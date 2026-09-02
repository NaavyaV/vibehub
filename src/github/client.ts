/**
 * Thin GitHub REST wrapper. The connected repo is the source of truth for all
 * code; D1 only ever stores paths, shas, and refs.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class PartialUploadError extends GitHubError {
  constructor(
    status: number,
    message: string,
    readonly uploaded: number,
    readonly total: number,
    readonly lastPath: string,
    body?: string,
  ) {
    super(status, message, body, { uploaded, total, last_path: lastPath, partial: true });
    this.name = "PartialUploadError";
  }
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface CommitFile {
  path: string;
  action: "add" | "modify" | "delete";
  content?: string;
  encoding?: "utf-8" | "base64";
}

const API = "https://api.github.com";
const DEFAULT_BLOB_MODE = "100644";
const TRANSIENT_GITHUB_STATUSES = new Set([408, 429, 500, 502, 503, 522, 524]);

function githubHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "VibeHub",
    ...extra,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries GitHub calls that fail with transient edge or rate-limit errors. */
export async function githubFetch(
  input: string,
  init: RequestInit = {},
  options: { retries?: number } = {},
): Promise<Response> {
  const retries = options.retries ?? 3;
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(input, init);
    lastResponse = response;
    if (!TRANSIENT_GITHUB_STATUSES.has(response.status) || attempt === retries) {
      return response;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 500 * 2 ** attempt;
    await sleep(delayMs);
  }

  return lastResponse!;
}

export interface GithubRepoSummary {
  full_name: string;
  name: string;
  owner: string;
  html_url: string;
  private: boolean;
  description: string | null;
  updated_at: string | null;
  default_branch: string;
}

/** Lists repositories the user personally owns (excludes organization repos). */
export async function listGithubReposForToken(
  token: string,
  options: { perPage?: number; maxPages?: number; githubLogin?: string } = {},
): Promise<GithubRepoSummary[]> {
  const perPage = options.perPage ?? 100;
  const maxPages = options.maxPages ?? 3;
  const repos: GithubRepoSummary[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const response = await githubFetch(
      `${API}/user/repos?sort=updated&direction=desc&per_page=${perPage}&page=${page}&affiliation=owner`,
      { headers: githubHeaders(token) },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GitHubError(
        response.status,
        `Could not list your GitHub repos (${response.status}): ${text.slice(0, 200)}`,
        text,
      );
    }
    const batch = (await response.json()) as Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      html_url: string;
      private: boolean;
      description: string | null;
      updated_at: string | null;
      default_branch: string;
    }>;
    for (const repo of batch) {
      if (options.githubLogin && repo.owner.login !== options.githubLogin) continue;
      repos.push({
        full_name: repo.full_name,
        name: repo.name,
        owner: repo.owner.login,
        html_url: repo.html_url,
        private: repo.private,
        description: repo.description,
        updated_at: repo.updated_at,
        default_branch: repo.default_branch || "main",
      });
    }
    if (batch.length < perPage) break;
  }

  return repos;
}

export async function fetchGithubLogin(token: string): Promise<string> {
  const user = await githubFetch(`${API}/user`, {
    headers: githubHeaders(token),
  }).then((r) => r.json() as Promise<{ login?: string }>);
  if (!user.login) {
    throw new GitHubError(401, "Could not read your GitHub username from the token.");
  }
  return user.login;
}

/** Returns repo metadata when it already exists for the authenticated user. */
export async function findUserRepository(
  token: string,
  owner: string,
  name: string,
): Promise<GithubRepoSummary | null> {
  const client = new GitHubClient(token, { owner, repo: name });
  const info = await client.getRepoInfo();
  if (!info) return null;
  return {
    full_name: `${owner}/${name}`,
    name,
    owner,
    html_url: `https://github.com/${owner}/${name}`,
    private: info.private,
    description: "Created by VibeHub",
    updated_at: null,
    default_branch: info.default_branch || "main",
  };
}

function createRepoErrorMessage(status: number, text: string): string {
  if (status === 522 || status === 524) {
    return "GitHub timed out while creating the repository. Wait a moment and try again. If the repo already exists on GitHub, choose Connect existing repo instead.";
  }
  return `Could not create GitHub repository (${status}): ${truncate(text, 400)}`;
}

export async function createUserRepository(
  token: string,
  input: { name: string; private?: boolean; description?: string; autoInit?: boolean },
): Promise<GithubRepoSummary> {
  const autoInit = input.autoInit ?? true;
  const response = await githubFetch(`${API}/user/repos`, {
    method: "POST",
    headers: githubHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      name: input.name,
      private: input.private ?? false,
      description: input.description ?? "",
      auto_init: autoInit,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GitHubError(response.status, createRepoErrorMessage(response.status, text), text);
  }
  const repo = (await response.json()) as {
    full_name: string;
    name: string;
    owner: { login: string };
    html_url: string;
    private: boolean;
    description: string | null;
    updated_at: string | null;
    default_branch: string;
  };
  return {
    full_name: repo.full_name,
    name: repo.name,
    owner: repo.owner.login,
    html_url: repo.html_url,
    private: repo.private,
    description: repo.description,
    updated_at: repo.updated_at,
    default_branch: repo.default_branch || "main",
  };
}

/** Creates a user-owned repo, reusing it when it already exists or was created despite a timeout. */
export async function ensureUserRepository(
  token: string,
  input: { name: string; private?: boolean; description?: string; autoInit?: boolean },
): Promise<GithubRepoSummary> {
  const login = await fetchGithubLogin(token);
  const existing = await findUserRepository(token, login, input.name);
  if (existing) return existing;

  try {
    return await createUserRepository(token, input);
  } catch (error) {
    const recovered = await findUserRepository(token, login, input.name);
    if (recovered) return recovered;
    throw error;
  }
}

export function parseRepoUrl(input: string): RepoRef | null {
  const value = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const patterns = [
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/i,
    /^git@github\.com:([^/]+)\/([^/]+)$/i,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match?.[1] && match[2]) return { owner: match[1], repo: match[2] };
  }
  return null;
}

export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToUtf8(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    readonly repo: RepoRef,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { allow404?: boolean; allow409?: boolean } = {},
  ): Promise<T | null> {
    const response = await githubFetch(`${API}${path}`, {
      method,
      headers: githubHeaders(
        this.token,
        body === undefined ? {} : { "Content-Type": "application/json" },
      ),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 404 && options.allow404) return null;
    if (response.status === 409 && options.allow409) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GitHubError(
        response.status,
        `GitHub ${method} ${path} failed with ${response.status}: ${truncate(text, 400)}`,
        text,
      );
    }
    if (response.status === 204) return null;
    return (await response.json()) as T;
  }

  private base(): string {
    return `/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.repo)}`;
  }

  async getRepoInfo(): Promise<{ default_branch: string; private: boolean } | null> {
    return this.request<{ default_branch: string; private: boolean }>("GET", this.base(), undefined, {
      allow404: true,
    });
  }

  /** Polls until the repo responds to the REST API (freshly created repos can lag). */
  async waitUntilReady(attempts = 12): Promise<{ default_branch: string; private: boolean }> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const info = await this.getRepoInfo();
      if (info) return info;
      await sleep(400 * (attempt + 1));
    }
    throw new GitHubError(
      404,
      `Repository ${this.repo.owner}/${this.repo.repo} is not reachable yet. Wait a moment and retry, or use prepare_git_push and push with git locally.`,
    );
  }

  /** `ref` is a short ref such as "heads/main". Returns null when absent. */
  async getRefSha(ref: string): Promise<string | null> {
    const result = await this.request<{ object: { sha: string } }>(
      "GET",
      `${this.base()}/git/ref/${ref}`,
      undefined,
      { allow404: true, allow409: true },
    );
    return result?.object.sha ?? null;
  }

  async createRef(ref: string, sha: string): Promise<void> {
    await this.request("POST", `${this.base()}/git/refs`, { ref: `refs/${ref}`, sha });
  }

  async updateRef(ref: string, sha: string, force = false): Promise<void> {
    await this.request("PATCH", `${this.base()}/git/refs/${ref}`, { sha, force });
  }

  async deleteRef(ref: string): Promise<void> {
    await this.request("DELETE", `${this.base()}/git/refs/${ref}`, undefined, { allow404: true });
  }

  /** Creates the ref if missing, otherwise force-moves it. */
  async upsertRef(ref: string, sha: string): Promise<void> {
    const existing = await this.getRefSha(ref);
    if (existing === null) await this.createRef(ref, sha);
    else if (existing !== sha) await this.updateRef(ref, sha, true);
  }

  /** Lightweight tag pointing at a commit (e.g. vibehub/v3). Idempotent. */
  async ensureTag(tagName: string, sha: string): Promise<void> {
    const ref = `tags/${tagName.replace(/^refs\/tags\//, "")}`;
    const existing = await this.getRefSha(ref);
    if (existing === sha) return;
    if (existing === null) {
      await this.request("POST", `${this.base()}/git/refs`, {
        ref: `refs/${ref}`,
        sha,
      });
      return;
    }
    await this.updateRef(ref, sha, true);
  }

  async getCommit(
    sha: string,
  ): Promise<{ sha: string; tree: { sha: string }; parents: Array<{ sha: string }> }> {
    const commit = await this.request<{
      sha: string;
      tree: { sha: string };
      parents: Array<{ sha: string }>;
    }>("GET", `${this.base()}/git/commits/${sha}`);
    if (!commit) throw new GitHubError(404, `Commit ${sha} not found`);
    return { ...commit, parents: commit.parents ?? [] };
  }

  async getTree(sha: string, recursive = true): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
    const query = recursive ? "?recursive=1" : "";
    const result = await this.request<{ tree: TreeEntry[]; truncated: boolean }>(
      "GET",
      `${this.base()}/git/trees/${sha}${query}`,
    );
    return result ?? { tree: [], truncated: false };
  }

  async getBlobText(sha: string): Promise<string> {
    const blob = await this.request<{ content: string; encoding: string }>(
      "GET",
      `${this.base()}/git/blobs/${sha}`,
    );
    if (!blob) throw new GitHubError(404, `Blob ${sha} not found`);
    return blob.encoding === "base64" ? base64ToUtf8(blob.content) : blob.content;
  }

  /** Reads a single file at a ref/sha. Returns null when the file does not exist. */
  async getFileText(path: string, ref: string): Promise<string | null> {
    const result = await this.request<{ content?: string; encoding?: string; sha: string; size: number }>(
      "GET",
      `${this.base()}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      undefined,
      { allow404: true },
    );
    if (!result) return null;
    // Files above ~1MB come back with empty content; fall back to the blob API.
    if (!result.content) return this.getBlobText(result.sha);
    return result.encoding === "base64" ? base64ToUtf8(result.content) : result.content;
  }

  async createBlob(content: string, encoding: "utf-8" | "base64"): Promise<string> {
    const payload =
      encoding === "base64"
        ? { content, encoding: "base64" }
        : { content: utf8ToBase64(content), encoding: "base64" };
    const blob = await this.request<{ sha: string }>("POST", `${this.base()}/git/blobs`, payload);
    if (!blob) throw new GitHubError(500, "Blob creation returned no sha");
    return blob.sha;
  }

  /**
   * Commits a set of file changes on top of `baseCommitSha` and returns the new
   * commit sha. Does not move any ref — callers decide where it lands.
   */
  async createCommitWithFiles(options: {
    baseCommitSha: string;
    message: string;
    files: CommitFile[];
  }): Promise<{ commitSha: string; skippedDeletes: string[] }> {
    const baseCommit = await this.getCommit(options.baseCommitSha);
    const base = await this.getTree(baseCommit.tree.sha, true);
    const existing = new Map(
      base.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry]),
    );

    const treeEntries: Array<Record<string, unknown>> = [];
    const skippedDeletes: string[] = [];

    for (const file of options.files) {
      if (file.action === "delete") {
        if (!existing.has(file.path) && !base.truncated) {
          skippedDeletes.push(file.path);
          continue;
        }
        treeEntries.push({
          path: file.path,
          mode: existing.get(file.path)?.mode ?? DEFAULT_BLOB_MODE,
          type: "blob",
          sha: null,
        });
      }
    }

    const toCreate = options.files.filter((file) => file.action !== "delete");
    const inlineLimit = 300_000;
    const large: CommitFile[] = [];

    for (const file of toCreate) {
      const content = file.content ?? "";
      const bytes = new TextEncoder().encode(content).byteLength;
      const mode = existing.get(file.path)?.mode ?? DEFAULT_BLOB_MODE;
      if (bytes > inlineLimit) {
        large.push(file);
        continue;
      }
      treeEntries.push({
        path: file.path,
        mode,
        type: "blob",
        content: file.encoding === "base64" ? content : content,
      });
    }

    if (large.length > 0) {
      const blobbed = await mapWithConcurrency(large, 8, async (file) => {
        const blobSha = await this.createBlob(file.content ?? "", file.encoding ?? "utf-8");
        return {
          path: file.path,
          mode: existing.get(file.path)?.mode ?? DEFAULT_BLOB_MODE,
          type: "blob" as const,
          sha: blobSha,
        };
      });
      treeEntries.push(...blobbed);
    }

    if (treeEntries.length === 0) {
      return { commitSha: options.baseCommitSha, skippedDeletes };
    }

    const tree = await this.request<{ sha: string }>("POST", `${this.base()}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: treeEntries,
    });
    if (!tree) throw new GitHubError(500, "Tree creation returned no sha");

    const commit = await this.request<{ sha: string }>("POST", `${this.base()}/git/commits`, {
      message: options.message,
      tree: tree.sha,
      parents: [options.baseCommitSha],
    });
    if (!commit) throw new GitHubError(500, "Commit creation returned no sha");

    return { commitSha: commit.sha, skippedDeletes };
  }

  /** Creates a commit that reuses an existing tree — used to revert cleanly. */
  async createCommitFromTree(options: {
    treeSha: string;
    parentSha: string;
    message: string;
  }): Promise<string> {
    const commit = await this.request<{ sha: string }>("POST", `${this.base()}/git/commits`, {
      message: options.message,
      tree: options.treeSha,
      parents: [options.parentSha],
    });
    if (!commit) throw new GitHubError(500, "Commit creation returned no sha");
    return commit.sha;
  }

  /** Paths that differ between two commits, with their change status. */
  async changedFilesBetween(
    baseSha: string,
    headSha: string,
  ): Promise<Array<{ path: string; status: string }>> {
    const result = await this.request<{ files?: Array<{ filename: string; status: string }> }>(
      "GET",
      `${this.base()}/compare/${baseSha}...${headSha}`,
    );
    return (result?.files ?? []).map((file) => ({ path: file.filename, status: file.status }));
  }

  async changedPathsBetween(baseSha: string, headSha: string): Promise<string[]> {
    return (await this.changedFilesBetween(baseSha, headSha)).map((file) => file.path);
  }

  async repositoryDispatch(eventType: string, clientPayload: Record<string, unknown>): Promise<void> {
    await this.request("POST", `${this.base()}/dispatches`, {
      event_type: eventType,
      client_payload: clientPayload,
    });
  }

  /** Creates or updates a file via the Contents API (works on empty repos). */
  async createFileViaContents(
    path: string,
    content: string,
    message: string,
    branch: string,
  ): Promise<void> {
    await this.request("PUT", `${this.base()}/contents/${encodePath(path)}`, {
      message,
      content: utf8ToBase64(content),
      branch,
    });
  }

  /** Pushes files one-by-one via Contents API — reliable with OAuth tokens on new repos. */
  async pushFilesViaContents(
    branch: string,
    files: CommitFile[],
    message: string,
  ): Promise<string> {
    const toUpload = files.filter((file) => file.action !== "delete" && file.content !== undefined);
    let uploaded = 0;
    try {
      await mapWithConcurrency(toUpload, 1, async (file, index) => {
        const existing = await this.request<{ sha: string }>(
          "GET",
          `${this.base()}/contents/${encodePath(file.path)}?ref=${encodeURIComponent(branch)}`,
          undefined,
          { allow404: true },
        );
        const payload: Record<string, unknown> = {
          message: index === 0 ? message : `${message} (${file.path})`,
          content: utf8ToBase64(file.content ?? ""),
          branch,
        };
        if (existing?.sha) payload.sha = existing.sha;
        await this.request("PUT", `${this.base()}/contents/${encodePath(file.path)}`, payload);
        uploaded += 1;
      });
    } catch (error) {
      if (uploaded > 0 && uploaded < toUpload.length && error instanceof GitHubError) {
        throw new PartialUploadError(
          error.status,
          `Uploaded ${uploaded}/${toUpload.length} files before failure at ${toUpload[uploaded]?.path ?? "unknown"}. The GitHub repo may be in a partial state — retry with the same repo_name and project_id, or delete the repo and use bootstrap_via_git.`,
          uploaded,
          toUpload.length,
          toUpload[uploaded]?.path ?? "unknown",
          error.body,
        );
      }
      throw error;
    }
    const head = await waitForRef(() => this.getRefSha(`heads/${branch}`));
    if (!head) {
      throw new GitHubError(502, "Files uploaded but the default branch ref is not ready yet.");
    }
    return head;
  }

  /**
   * Seeds a repo with an initial batch of files. Uses the Contents API because Git
   * Data endpoints often 404 with OAuth `public_repo` tokens on freshly created repos.
   */
  async pushInitialFiles(
    branch: string,
    files: CommitFile[],
    message = "chore(vibehub): initialize project",
  ): Promise<string> {
    const toUpload = files.filter((file) => file.action !== "delete");
    if (toUpload.length === 0) {
      throw new GitHubError(400, "No files to push to the repository.");
    }

    const ref = `heads/${branch}`;
    let head = await waitForRef(() => this.getRefSha(ref));

    if (!head) {
      const first = pickSeedFile(toUpload);
      if (!first) {
        throw new GitHubError(400, "No files to push to the repository.");
      }
      await this.createFileViaContents(first.path, first.content ?? "", message, branch);
      head = await waitForRef(() => this.getRefSha(ref));
      if (!head) {
        throw new GitHubError(
          502,
          "GitHub created the repository but the default branch is not ready yet.",
        );
      }
      if (toUpload.length === 1) return head;
      const remaining = toUpload.filter((file) => file.path !== first.path);
      return this.pushFilesViaContents(branch, remaining, message);
    }

    try {
      const batchSize = 120;
      for (let offset = 0; offset < toUpload.length; offset += batchSize) {
        const batch = toUpload.slice(offset, offset + batchSize);
        const batchMessage =
          offset === 0
            ? message
            : `${message} (part ${Math.floor(offset / batchSize) + 1})`;
        const { commitSha } = await this.createCommitWithFiles({
          baseCommitSha: head,
          message: batchMessage,
          files: batch,
        });
        await this.updateRef(ref, commitSha, false);
        head = commitSha;
      }
      return head;
    } catch (error) {
      if (!(error instanceof GitHubError) || (error.status !== 404 && error.status !== 409)) {
        throw error;
      }
      return this.pushFilesViaContents(branch, toUpload, message);
    }
  }

  /** Creates the repo's first commit when the default branch does not exist yet. */
  async createInitialCommit(branch: string, files: CommitFile[]): Promise<string> {
    return this.pushInitialFiles(branch, files);
  }
}

/** Prefer a shallow source file for the first commit — not CI workflow paths. */
function pickSeedFile(files: CommitFile[]): CommitFile | undefined {
  const priority = ["README.md", "readme.md", "package.json", ".gitignore"];
  for (const name of priority) {
    const match = files.find((file) => file.path === name);
    if (match) return match;
  }
  const shallow = files
    .filter((file) => !file.path.startsWith(".github/"))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  return shallow[0] ?? files[0];
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

async function waitForRef(
  read: () => Promise<string | null>,
  attempts = 10,
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const sha = await read();
    if (sha) return sha;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
