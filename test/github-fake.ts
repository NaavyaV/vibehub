/**
 * An in-memory stand-in for the subset of the GitHub REST API that VibeHub uses.
 * Lets the whole push gate be exercised without network access, including the
 * commit/tree/blob plumbing that conflict replay depends on.
 */

interface Commit {
  sha: string;
  treeSha: string;
  parents: string[];
  message: string;
}

export class FakeGitHub {
  readonly owner = "acme";
  readonly repo = "storefront";
  defaultBranch = "main";

  private blobs = new Map<string, string>();
  private trees = new Map<string, Map<string, string>>();
  private commits = new Map<string, Commit>();
  private refs = new Map<string, string>();
  private counter = 0;

  readonly dispatches: Array<{ event_type: string; client_payload: Record<string, unknown> }> = [];

  private nextSha(prefix: string): string {
    this.counter += 1;
    return `${prefix}${String(this.counter).padStart(38, "0")}`;
  }

  /** Seeds the default branch with an initial commit. */
  seed(files: Record<string, string>): string {
    const entries = new Map<string, string>();
    for (const [path, content] of Object.entries(files)) {
      const blobSha = this.nextSha("b");
      this.blobs.set(blobSha, content);
      entries.set(path, blobSha);
    }
    const treeSha = this.nextSha("t");
    this.trees.set(treeSha, entries);
    const sha = this.nextSha("c");
    this.commits.set(sha, { sha, treeSha, parents: [], message: "seed" });
    this.refs.set(`heads/${this.defaultBranch}`, sha);
    return sha;
  }

  headSha(): string {
    const sha = this.refs.get(`heads/${this.defaultBranch}`);
    if (!sha) throw new Error("No default branch");
    return sha;
  }

  fileAt(commitSha: string, path: string): string | null {
    const commit = this.commits.get(commitSha);
    if (!commit) return null;
    const blobSha = this.trees.get(commit.treeSha)?.get(path);
    return blobSha === undefined ? null : (this.blobs.get(blobSha) ?? null);
  }

  pathsAt(commitSha: string): string[] {
    const commit = this.commits.get(commitSha);
    if (!commit) return [];
    return [...(this.trees.get(commit.treeSha)?.keys() ?? [])].sort();
  }

  refExists(ref: string): boolean {
    return this.refs.has(ref);
  }

  /** Simulates an unrelated commit landing directly on the branch. */
  commitDirectly(files: Record<string, string>): string {
    const head = this.headSha();
    const base = this.commits.get(head)!;
    const entries = new Map(this.trees.get(base.treeSha));
    for (const [path, content] of Object.entries(files)) {
      const blobSha = this.nextSha("b");
      this.blobs.set(blobSha, content);
      entries.set(path, blobSha);
    }
    const treeSha = this.nextSha("t");
    this.trees.set(treeSha, entries);
    const sha = this.nextSha("c");
    this.commits.set(sha, { sha, treeSha, parents: [head], message: "out of band" });
    this.refs.set(`heads/${this.defaultBranch}`, sha);
    return sha;
  }

  /** A `fetch` implementation to install as the global during tests. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.github.com") {
      return new Response("unexpected host in test", { status: 502 });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const prefix = `/repos/${this.owner}/${this.repo}`;
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    if (path === null) return json({ message: "Not Found" }, 404);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (method === "GET" && path === "") {
      return json({ default_branch: this.defaultBranch, private: false });
    }

    if (method === "GET" && path.startsWith("/git/ref/")) {
      const ref = path.slice("/git/ref/".length);
      const sha = this.refs.get(ref);
      return sha ? json({ object: { sha } }) : json({ message: "Not Found" }, 404);
    }

    if (method === "POST" && path === "/git/refs") {
      const ref = String(body.ref).replace(/^refs\//, "");
      this.refs.set(ref, String(body.sha));
      return json({ object: { sha: body.sha } }, 201);
    }

    if (method === "PATCH" && path.startsWith("/git/refs/")) {
      const ref = path.slice("/git/refs/".length);
      const current = this.refs.get(ref);
      const target = this.commits.get(String(body.sha));
      // Reject a non-fast-forward unless forced, like GitHub does.
      if (!body.force && current && target && !this.isAncestor(current, target.sha)) {
        return json({ message: "Update is not a fast forward" }, 422);
      }
      this.refs.set(ref, String(body.sha));
      return json({ object: { sha: body.sha } });
    }

    if (method === "DELETE" && path.startsWith("/git/refs/")) {
      this.refs.delete(path.slice("/git/refs/".length));
      return new Response(null, { status: 204 });
    }

    if (method === "GET" && path.startsWith("/git/commits/")) {
      const commit = this.commits.get(path.slice("/git/commits/".length));
      if (!commit) return json({ message: "Not Found" }, 404);
      return json({
        sha: commit.sha,
        tree: { sha: commit.treeSha },
        parents: commit.parents.map((sha) => ({ sha })),
      });
    }

    if (method === "GET" && path.startsWith("/git/trees/")) {
      const treeSha = path.slice("/git/trees/".length);
      const entries = this.trees.get(treeSha);
      if (!entries) return json({ message: "Not Found" }, 404);
      return json({
        sha: treeSha,
        truncated: false,
        tree: [...entries].map(([entryPath, blobSha]) => ({
          path: entryPath,
          mode: "100644",
          type: "blob",
          sha: blobSha,
          size: (this.blobs.get(blobSha) ?? "").length,
        })),
      });
    }

    if (method === "GET" && path.startsWith("/git/blobs/")) {
      const blobSha = path.slice("/git/blobs/".length);
      const content = this.blobs.get(blobSha);
      if (content === undefined) return json({ message: "Not Found" }, 404);
      return json({ content: toBase64(content), encoding: "base64" });
    }

    if (method === "GET" && path.startsWith("/contents/")) {
      const filePath = decodeURIComponent(path.slice("/contents/".length));
      const ref = url.searchParams.get("ref") ?? this.headSha();
      const content = this.fileAt(ref, filePath);
      if (content === null) return json({ message: "Not Found" }, 404);
      return json({ content: toBase64(content), encoding: "base64", sha: "x", size: content.length });
    }

    if (method === "POST" && path === "/git/blobs") {
      const sha = this.nextSha("b");
      this.blobs.set(sha, fromBase64(String(body.content)));
      return json({ sha }, 201);
    }

    if (method === "POST" && path === "/git/trees") {
      const entries = new Map(this.trees.get(String(body.base_tree)) ?? []);
      for (const entry of (body.tree ?? []) as Array<{
        path: string;
        sha?: string | null;
        content?: string;
      }>) {
        if (entry.sha === null) {
          entries.delete(entry.path);
          continue;
        }
        if (typeof entry.content === "string") {
          const blobSha = this.nextSha("b");
          this.blobs.set(blobSha, entry.content);
          entries.set(entry.path, blobSha);
          continue;
        }
        if (entry.sha) entries.set(entry.path, entry.sha);
      }
      const sha = this.nextSha("t");
      this.trees.set(sha, entries);
      return json({ sha }, 201);
    }

    if (method === "POST" && path === "/git/commits") {
      const sha = this.nextSha("c");
      this.commits.set(sha, {
        sha,
        treeSha: String(body.tree),
        parents: ((body.parents ?? []) as string[]).slice(),
        message: String(body.message ?? ""),
      });
      return json({ sha }, 201);
    }

    if (method === "GET" && path.startsWith("/compare/")) {
      const [baseSha, headSha] = path.slice("/compare/".length).split("...") as [string, string];
      return json({ files: this.diff(baseSha, headSha) });
    }

    if (method === "POST" && path === "/dispatches") {
      this.dispatches.push({
        event_type: String(body.event_type),
        client_payload: (body.client_payload ?? {}) as Record<string, unknown>,
      });
      return new Response(null, { status: 204 });
    }

    return json({ message: `Unhandled ${method} ${path}` }, 501);
  };

  private isAncestor(candidate: string, descendant: string): boolean {
    let cursor: string | undefined = descendant;
    while (cursor) {
      if (cursor === candidate) return true;
      cursor = this.commits.get(cursor)?.parents[0];
    }
    return false;
  }

  private diff(baseSha: string, headSha: string): Array<{ filename: string; status: string }> {
    const base = this.trees.get(this.commits.get(baseSha)?.treeSha ?? "") ?? new Map();
    const head = this.trees.get(this.commits.get(headSha)?.treeSha ?? "") ?? new Map();
    const files: Array<{ filename: string; status: string }> = [];
    for (const [path, blobSha] of head) {
      if (!base.has(path)) files.push({ filename: path, status: "added" });
      else if (base.get(path) !== blobSha) files.push({ filename: path, status: "modified" });
    }
    for (const path of base.keys()) {
      if (!head.has(path)) files.push({ filename: path, status: "removed" });
    }
    return files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
