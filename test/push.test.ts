import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Repo, parseJsonArray } from "../src/db/repo.js";
import { validateImportPlan } from "../src/domain/import.js";
import { GENERATED_ROUTES_PATH, PACKAGE_JSON_PATH } from "../src/domain/codegen.js";
import { connectRepo, importPlan } from "../src/services/projects.js";
import { finalizePush, getPushStatus, startPush } from "../src/services/push.js";
import type { AppEnv } from "../src/types.js";
import { FakeGitHub } from "./github-fake.js";

const appEnv = env as unknown as AppEnv;

const plan = {
  project_name: "Storefront",
  features: [
    { id: "cart", title: "Cart", scope_notes: "src/features/cart/**", manifest: { routes: ["/cart"] } },
    {
      id: "search",
      title: "Search",
      scope_notes: "src/features/search/**",
      manifest: { routes: ["/search"], deps: ["fuse.js@^7.0.0"] },
    },
    {
      id: "checkout",
      title: "Checkout",
      depends_on: ["cart"],
      scope_notes: "src/features/checkout/**",
      manifest: { routes: ["/checkout"] },
    },
  ],
};

let github: FakeGitHub;

/** Runs stage A inline so tests can await the whole pipeline. */
const inlineScheduler = (jobs: Array<Promise<unknown>>) => (work: Promise<unknown>) => {
  jobs.push(work);
};

async function setup() {
  github = new FakeGitHub();
  vi.stubGlobal("fetch", github.fetch);
  github.seed({
    "README.md": "# Storefront\n",
    [PACKAGE_JSON_PATH]: `{\n  "name": "storefront",\n  "dependencies": {}\n}\n`,
  });

  const repo = new Repo(appEnv.DB);
  const user = await repo.upsertGithubUser({
    githubLogin: `dev-${crypto.randomUUID().slice(0, 8)}`,
    displayName: "Dev",
    avatarUrl: null,
    githubTokenEnc: null,
  });
  const parsed = validateImportPlan(plan);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const { project } = await importPlan(repo, {
    plan: parsed.plan,
    userId: user.id,
    // Green-by-default gate keeps these tests about merge logic, not CI.
    testMode: "skip",
  });
  await connectRepo(appEnv, repo, project.id, {
    repoUrl: `https://github.com/${github.owner}/${github.repo}`,
    githubToken: "test-token",
  });
  return { repo, projectId: project.id, userId: user.id };
}

async function push(
  context: Awaited<ReturnType<typeof setup>>,
  input: {
    feature: string;
    basedOnVersion: number;
    files: Array<{ path: string; action: "add" | "modify" | "delete"; content?: string }>;
    manifest?: unknown;
    allowLargeDeletions?: boolean;
  },
) {
  const jobs: Array<Promise<unknown>> = [];
  const result = await startPush(
    appEnv,
    context.repo,
    {
      projectId: context.projectId,
      featureIdOrSlug: input.feature,
      basedOnVersion: input.basedOnVersion,
      changedFiles: input.files,
      manifest: input.manifest,
      notes: null,
      webhookUrl: null,
      userId: context.userId,
      allowLargeDeletions: input.allowLargeDeletions,
    },
    inlineScheduler(jobs),
  );
  await Promise.all(jobs);
  return result.push_id;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the push gate", () => {
  let context: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    context = await setup();
  });

  it("connects a repo and pins version 0 to the current head", async () => {
    const version0 = await context.repo.getVersion(context.projectId, 0);
    expect(version0!.commit_sha).toBe(github.headSha());
  });

  it("auto-applies a clean push, bumps the version, and merges the feature", async () => {
    const pushId = await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [
        { path: "src/features/cart/index.ts", action: "add", content: "export const cart = [];\n" },
        { path: "src/features/cart/routes.tsx", action: "add", content: "export default null;\n" },
      ],
    });

    const status = await getPushStatus(appEnv, context.repo, pushId);
    expect(status.status).toBe("merged");
    expect(status.merged_version).toBe(1);

    const project = await context.repo.getProject(context.projectId);
    expect(project!.current_version).toBe(1);
    expect((await context.repo.findFeature(context.projectId, "cart"))!.status).toBe("merged");
    expect(github.fileAt(github.headSha(), "src/features/cart/index.ts")).toBe(
      "export const cart = [];\n",
    );
  });

  it("generates the shared wiring instead of letting the feature write it", async () => {
    await push(context, {
      feature: "search",
      basedOnVersion: 0,
      files: [{ path: "src/features/search/routes.tsx", action: "add", content: "export default null;\n" }],
    });

    const routes = github.fileAt(github.headSha(), GENERATED_ROUTES_PATH);
    expect(routes).toContain(`path: "/search"`);
    expect(routes).toContain(`import("../features/search/routes")`);

    const pkg = JSON.parse(github.fileAt(github.headSha(), PACKAGE_JSON_PATH)!) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["fuse.js"]).toBe("^7.0.0");

    const version = await context.repo.getVersion(context.projectId, 1);
    expect(parseJsonArray(version!.changed_paths)).toContain(GENERATED_ROUTES_PATH);
  });

  it("keeps dependent features Assigned when a dependency merges (deps are advisory)", async () => {
    expect((await context.repo.findFeature(context.projectId, "checkout"))!.status).toBe("available");
    await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [{ path: "src/features/cart/index.ts", action: "add", content: "x\n" }],
    });
    expect((await context.repo.findFeature(context.projectId, "checkout"))!.status).toBe("available");
  });

  it("never records a push whose content is a stand-in", async () => {
    await expect(
      push(context, {
        feature: "cart",
        basedOnVersion: 0,
        files: [{ path: "src/features/cart/styles.css", action: "add", content: "PLACEHOLDER" }],
      }),
    ).rejects.toThrow(/rejected before it was recorded/);
  });

  it("refuses to replace a large file with a truncated body", async () => {
    const stylesheet = `.hero { color: red; }\n`.repeat(400);
    await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [{ path: "src/features/cart/styles.css", action: "add", content: stylesheet }],
    });

    // Plausible content, but a fraction of what is on main — a half-pasted file.
    const pushId = await push(context, {
      feature: "cart",
      basedOnVersion: 1,
      files: [
        { path: "src/features/cart/styles.css", action: "modify", content: ".hero { color: red; }\n" },
      ],
    });

    const status = await getPushStatus(appEnv, context.repo, pushId);
    expect(status.status).toBe("failed");
    expect(status.error).toMatch(/would wipe most of/);
    // Main still has the real stylesheet.
    expect(github.fileAt(github.headSha(), "src/features/cart/styles.css")).toBe(stylesheet);
  });

  it("allows a deliberate rewrite when the agent says the shrink is intended", async () => {
    const stylesheet = `.hero { color: red; }\n`.repeat(400);
    await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [{ path: "src/features/cart/styles.css", action: "add", content: stylesheet }],
    });

    const pushId = await push(context, {
      feature: "cart",
      basedOnVersion: 1,
      files: [{ path: "src/features/cart/styles.css", action: "modify", content: ".hero{}\n" }],
      allowLargeDeletions: true,
    });

    const status = await getPushStatus(appEnv, context.repo, pushId);
    expect(status.status).toBe("merged");
  });

  it("refuses a push whose dependencies have not merged", async () => {
    const pushId = await push(context, {
      feature: "checkout",
      basedOnVersion: 0,
      files: [{ path: "src/features/checkout/index.ts", action: "add", content: "x\n" }],
    });
    const status = await getPushStatus(appEnv, context.repo, pushId);
    expect(status.status).toBe("failed");
    expect(status.error).toMatch(/depends on "cart", which has not merged yet/);
  });

  it("accepts a stale push when no paths overlap", async () => {
    await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [{ path: "src/features/cart/index.ts", action: "add", content: "cart\n" }],
    });

    // Still claiming version 0 while the project is on version 1.
    const pushId = await push(context, {
      feature: "search",
      basedOnVersion: 0,
      files: [{ path: "src/features/search/index.ts", action: "add", content: "search\n" }],
    });

    const status = await getPushStatus(appEnv, context.repo, pushId);
    expect(status.status).toBe("merged");
    expect(status.merged_version).toBe(2);
    // The earlier feature's file survived the second merge.
    expect(github.fileAt(github.headSha(), "src/features/cart/index.ts")).toBe("cart\n");
  });

  it("rejects an overlapping push and returns only the conflicting files", async () => {
    await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [
        { path: "src/lib/money.ts", action: "add", content: "export const format = 1;\n" },
        { path: "src/features/cart/index.ts", action: "add", content: "cart\n" },
      ],
    });

    const pushId = await push(context, {
      feature: "search",
      basedOnVersion: 0,
      files: [
        { path: "src/lib/money.ts", action: "modify", content: "export const format = 2;\n" },
        { path: "src/features/search/index.ts", action: "add", content: "search\n" },
      ],
    });

    const status = await getPushStatus(appEnv, context.repo, pushId);
    expect(status.status).toBe("conflict");
    expect(status.conflict_paths).toEqual(["src/lib/money.ts"]);
    expect(status.conflicting_files).toEqual([
      { path: "src/lib/money.ts", tip_sha: github.headSha() },
    ]);
    expect(status.reason).toMatch(/pull_code/);

    // Nothing landed: the project is still on the first merge.
    expect((await context.repo.getProject(context.projectId))!.current_version).toBe(1);
    expect(github.fileAt(github.headSha(), "src/lib/money.ts")).toBe("export const format = 1;\n");
  });

  it("rejects a manifest conflict rather than guessing a dependency version", async () => {
    await push(context, {
      feature: "search",
      basedOnVersion: 0,
      files: [{ path: "src/features/search/index.ts", action: "add", content: "s\n" }],
      manifest: { deps: ["fuse.js@^7.0.0"] },
    });

    const pushId = await push(context, {
      feature: "cart",
      basedOnVersion: 1,
      files: [{ path: "src/features/cart/index.ts", action: "add", content: "c\n" }],
      manifest: { deps: ["fuse.js@^6.0.0"] },
    });

    const status = await getPushStatus(appEnv, context.repo, pushId);
    expect(status.status).toBe("conflict");
    expect(status.reason).toMatch(/Dependency "fuse\.js" is requested as/);
  });

  it("rejects a push that tries to write a generated file, before recording it", async () => {
    await expect(
      push(context, {
        feature: "cart",
        basedOnVersion: 0,
        files: [{ path: GENERATED_ROUTES_PATH, action: "modify", content: "hacked\n" }],
      }),
    ).rejects.toThrow(/rejected before it was recorded/);
    expect(await context.repo.listPushes(context.projectId)).toHaveLength(0);
  });

  it("rejects a based_on_version ahead of the project", async () => {
    await expect(
      push(context, {
        feature: "cart",
        basedOnVersion: 7,
        files: [{ path: "src/features/cart/index.ts", action: "add", content: "x\n" }],
      }),
    ).rejects.toThrow(/ahead of the project's current version/);
  });

  it("replays onto a head that moved out of band while the build ran", async () => {
    const jobs: Array<Promise<unknown>> = [];
    const started = await startPush(
      appEnv,
      context.repo,
      {
        projectId: context.projectId,
        featureIdOrSlug: "cart",
        basedOnVersion: 0,
        changedFiles: [
          { path: "src/features/cart/index.ts", action: "add", content: "cart\n" },
        ],
        manifest: undefined,
        notes: null,
        webhookUrl: null,
        userId: context.userId,
      },
      inlineScheduler(jobs),
    );

    // Another push lands first, so the staged commit's parent is now stale.
    await push(context, {
      feature: "search",
      basedOnVersion: 0,
      files: [{ path: "src/features/search/index.ts", action: "add", content: "search\n" }],
    });
    await Promise.all(jobs);

    const status = await getPushStatus(appEnv, context.repo, started.push_id);
    expect(status.status).toBe("merged");
    expect(github.fileAt(github.headSha(), "src/features/cart/index.ts")).toBe("cart\n");
    expect(github.fileAt(github.headSha(), "src/features/search/index.ts")).toBe("search\n");
  });

  it("deletes the staging ref once a push lands", async () => {
    const pushId = await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [{ path: "src/features/cart/index.ts", action: "add", content: "x\n" }],
    });
    const row = await context.repo.getPush(pushId);
    expect(row!.staging_ref).toMatch(/^refs\/heads\/vibehub\/push\//);
    expect(github.refExists(row!.staging_ref!.replace(/^refs\//, ""))).toBe(false);
  });
});

describe("the build gate", () => {
  let context: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    context = await setup();
    await context.repo.setTestMode(context.projectId, "actions");
  });

  it("dispatches to GitHub Actions and waits, without moving the branch", async () => {
    const pushId = await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [{ path: "src/features/cart/index.ts", action: "add", content: "x\n" }],
    });

    const row = await context.repo.getPush(pushId);
    expect(row!.status).toBe("testing");
    expect(row!.stage).toBe("building");
    expect(github.dispatches).toHaveLength(1);

    const payload = github.dispatches[0]!.client_payload;
    expect(github.dispatches[0]!.event_type).toBe("vibehub_build");
    expect(payload.push_id).toBe(pushId);
    expect(String(payload.callback_url)).toContain(`/api/pushes/${pushId}/build-result`);
    expect(String(payload.callback_token).length).toBeGreaterThan(20);

    // The default branch has not moved while the build is pending.
    const version0 = await context.repo.getVersion(context.projectId, 0);
    expect(github.headSha()).toBe(version0!.commit_sha);
  });

  it("leaves the branch and version untouched when the build fails", async () => {
    const pushId = await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [{ path: "src/features/cart/index.ts", action: "add", content: "x\n" }],
    });
    const headBefore = github.headSha();

    await finalizePush(appEnv, context.repo, pushId, { success: false, output: "tsc: 3 errors" });

    const status = await getPushStatus(appEnv, context.repo, pushId);
    expect(status.status).toBe("failed");
    expect(status.build_output).toBe("tsc: 3 errors");
    expect(github.headSha()).toBe(headBefore);
    expect((await context.repo.getProject(context.projectId))!.current_version).toBe(0);
    expect((await context.repo.findFeature(context.projectId, "cart"))!.status).not.toBe("merged");
  });

  it("lands the push when the build reports success", async () => {
    const pushId = await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [{ path: "src/features/cart/index.ts", action: "add", content: "x\n" }],
    });
    await finalizePush(appEnv, context.repo, pushId, { success: true, output: "ok" });

    const status = await getPushStatus(appEnv, context.repo, pushId);
    expect(status.status).toBe("merged");
    expect(status.merged_version).toBe(1);
  });

  it("ignores a repeated callback for a settled push", async () => {
    const pushId = await push(context, {
      feature: "cart",
      basedOnVersion: 0,
      files: [{ path: "src/features/cart/index.ts", action: "add", content: "x\n" }],
    });
    await finalizePush(appEnv, context.repo, pushId, { success: true, output: "ok" });
    await finalizePush(appEnv, context.repo, pushId, { success: false, output: "late failure" });

    const status = await getPushStatus(appEnv, context.repo, pushId);
    expect(status.status).toBe("merged");
    expect((await context.repo.getProject(context.projectId))!.current_version).toBe(1);
  });
});
