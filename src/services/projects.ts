/**
 * Project-level operations: importing a plan, answering agent context queries,
 * connecting a repo, and reading/parking snapshots.
 */

import { Repo, parseJsonArray } from "../db/repo.js";
import { generateSharedFiles } from "../domain/codegen.js";
import { validateImportText, validateImportPlan, type ImportedPlan } from "../domain/import.js";
import { mergeManifests } from "../domain/manifest.js";
import { badRequest, notFound } from "../lib/errors.js";
import { GitHubClient, parseRepoUrl, type CommitFile, ensureUserRepository } from "../github/client.js";
import { WORKFLOW_PATH, WORKFLOW_YAML } from "../github/workflow-template.js";
import { encryptSecret } from "../lib/crypto.js";
import { loadGraph, safeManifest } from "./features.js";
import { hasRepo, requireEncryptionKey } from "./github.js";
import { connectedLiveRepo, requireLiveProject } from "./repo-health.js";
import { isDoneStatus, toPublicStatus } from "../domain/task-status.js";
import type { AppEnv, ProjectRow, TestMode } from "../types.js";

export const SNAPSHOT_REF_PREFIX = "heads/vibehub/snapshot/";

export interface ImportOutcome {
  project: ProjectRow;
  plan: ImportedPlan;
}

/** Creates a project and its task graph from a validated plan. */
export async function importPlan(
  repo: Repo,
  input: { plan: ImportedPlan; userId: string | null; testMode: TestMode },
): Promise<ImportOutcome> {
  const { plan } = input;

  const project = await repo.createProject({
    name: plan.projectName,
    createdBy: input.userId,
    sharedFileWarnings: [],
    testMode: input.testMode,
  });

  if (input.userId) await repo.addMember(project.id, input.userId, "owner");

  const slugToId = await repo.insertFeatures(
    project.id,
    plan.features.map((feature, index) => ({
      slug: feature.slug,
      title: feature.title,
      description: feature.description,
      scopeNotes: feature.scopeNotes,
      manifest: feature.manifest,
      testSpec: feature.testSpec,
      // New tasks start Assigned (available). Dependencies are advisory via blocked_by.
      status: "available",
      position: index,
    })),
  );

  const edges: Array<{ featureId: string; dependsOnId: string }> = [];
  for (const feature of plan.features) {
    const featureId = slugToId.get(feature.slug);
    if (!featureId) continue;
    for (const dep of feature.dependsOn) {
      const dependsOnId = slugToId.get(dep);
      if (dependsOnId) edges.push({ featureId, dependsOnId });
    }
  }
  await repo.insertDependencyEdges(edges);

  // Version 0 is the empty baseline. Its commit sha is filled in when a repo is
  // connected.
  await repo.insertVersion({
    projectId: project.id,
    versionNumber: 0,
    commitSha: null,
    createdByFeatureId: null,
    changedPaths: [],
  });

  return { project, plan };
}

export function parsePlanInput(input: { plan_text?: string; plan?: unknown }) {
  if (typeof input.plan_text === "string" && input.plan_text.trim() !== "") {
    return validateImportText(input.plan_text);
  }
  if (input.plan !== undefined) return validateImportPlan(input.plan);
  return { ok: false as const, errors: ["Paste the JSON block produced by your LLM."] };
}

export async function requireProject(repo: Repo, projectId: string): Promise<ProjectRow> {
  const project = await repo.getProject(projectId);
  if (!project) throw notFound(`No project ${projectId}.`);
  return project;
}

// --------------------------------------------------------------- context

export async function getProjectContext(env: AppEnv, repo: Repo, projectId: string) {
  const project = await requireLiveProject(env, repo, await requireProject(repo, projectId));
  const view = await loadGraph(repo, projectId);
  const versions = await repo.listVersions(projectId);
  const blockers = await repo.listOpenBlockers(projectId);
  const featureById = new Map(view.features.map((f) => [f.id, f.slug]));

  const merged = mergeManifests(
    view.features
      .filter((f) => isDoneStatus(f.status))
      .map((f) => ({ featureSlug: f.slug, manifest: safeManifest(f) })),
  );

  return {
    project: {
      id: project.id,
      name: project.name,
      repo_url: project.repo_url,
      storage_provider: project.storage_provider,
      current_version: project.current_version,
      default_branch: project.default_branch,
      test_mode: project.test_mode,
      repo_connected: hasRepo(project),
      created_at: project.created_at,
    },
    requirements: {
      project_name: project.name,
      shared_file_warnings: parseJsonArray(project.shared_file_warnings),
      feature_count: view.features.length,
      merged_count: view.mergedSlugs.size,
    },
    features: view.features.map((feature) => ({
      id: feature.slug,
      internal_id: feature.id,
      title: feature.title,
      description: feature.description,
      status: toPublicStatus(feature.status),
      assigned_to: feature.assigned_to,
      scope_notes: feature.scope_notes,
      manifest: safeManifest(feature),
      test_spec: feature.test_spec,
      depends_on: feature.dependsOn,
      blocked_by: feature.dependsOn.filter((dep) => !view.mergedSlugs.has(dep)),
    })),
    shared_wiring: {
      routes: merged.routes,
      exports: merged.exports,
      dependencies: merged.deps,
      generated_files_are_off_limits: true,
    },
    open_blockers: blockers.map((blocker) => ({
      id: blocker.id,
      feature: featureById.get(blocker.feature_id) ?? blocker.feature_id,
      reason: blocker.reason,
      created_at: blocker.created_at,
    })),
    versions: versions.slice(0, 20).map((version) => ({
      version: version.version_number,
      commit_sha: version.commit_sha,
      created_by_feature: version.created_by_feature_id
        ? featureById.get(version.created_by_feature_id) ?? null
        : null,
      changed_paths: parseJsonArray(version.changed_paths),
      created_at: version.created_at,
    })),
  };
}

export async function getMyTask(repo: Repo, projectId: string, userId: string) {
  const project = await requireProject(repo, projectId);
  const view = await loadGraph(repo, projectId);
  const bySlug = new Map(view.features.map((f) => [f.slug, f]));

  const mine = view.features.filter(
    (feature) => feature.assigned_to === userId && !isDoneStatus(feature.status),
  );

  const availableToClaim = view.features
    .filter(
      (feature) =>
        !isDoneStatus(feature.status) &&
        (feature.assigned_to === null || feature.assigned_to === userId),
    )
    .map((feature) => ({
      id: feature.slug,
      title: feature.title,
      status: toPublicStatus(feature.status),
      assigned_to: feature.assigned_to,
      blocked_by: feature.dependsOn.filter((dep) => !view.mergedSlugs.has(dep)),
    }));

  return {
    project_id: project.id,
    /** The version any push should be based on. */
    based_on_version: project.current_version,
    repo_connected: hasRepo(project),
    /** Tasks assigned to this user that are not Done. Prefer these. */
    assigned_features: mine.map((feature) => ({
      id: feature.slug,
      title: feature.title,
      description: feature.description,
      status: toPublicStatus(feature.status),
      scope_notes: feature.scope_notes,
      manifest: safeManifest(feature),
      test_spec: feature.test_spec,
      blocked_by: feature.dependsOn.filter((dep) => !view.mergedSlugs.has(dep)),
      /** Interfaces the dependencies expose, so the agent can code against them. */
      dependency_context: feature.dependsOn.map((slug) => {
        const dep = bySlug.get(slug);
        return {
          id: slug,
          status: dep ? toPublicStatus(dep.status) : "unknown",
          title: dep?.title ?? null,
          scope_notes: dep?.scope_notes ?? null,
          manifest: dep ? safeManifest(dep) : null,
        };
      }),
    })),
    /** Open tasks this user can work on (assigned to them, or still unassigned legacy). */
    available_to_you: availableToClaim,
    /**
     * Already shipped. If one of these merged wrong, push to the same feature_id
     * again — it reopens automatically. Never reach for git or a new task.
     */
    shipped_you_can_correct: view.features
      .filter((feature) => isDoneStatus(feature.status))
      .map((feature) => ({ id: feature.slug, title: feature.title })),
    recovery: {
      shipped_wrong_content:
        "Push to the same feature_id again with the corrected files. A push to a Done task reopens it and lands a new version.",
      never: "Do not use git, gh, or direct HTTP to this MCP. Every file reaches GitHub through these tools.",
    },
    /** @deprecated Use available_to_you */
    unclaimed_available: view.features
      .filter((feature) => toPublicStatus(feature.status) === "assigned" && feature.assigned_to === null)
      .map((feature) => ({ id: feature.slug, title: feature.title })),
    rules: [
      "One MCP loop: get_project_context → get_my_task → pull_snapshot → begin_upload → review_push → push_code → get_push_status → stop.",
      "Paste real file contents. Never send a stand-in like PLACEHOLDER meaning to swap it in later — declare bytes and the server will catch it.",
      "Nothing assigned to you does not mean you are stuck: to fix a shipped feature, push to that feature_id again.",
      "Never use git, gh, or a hand-rolled HTTP call to this MCP, and never read the user's token from disk.",
      "Never call push_code / push_feature until the user explicitly approved THIS push in chat. Finishing a task is not approval.",
      "Before pushing, re-pull current_version and reconcile your changed files against that snapshot.",
      "confirm_user_approved / confirm_built_on_latest mean those steps happened — they are not schema checkboxes.",
      "If a push is refused for missing confirmations, ask the user and re-read the project. Do not retry with the flags set true.",
      "Declare every file the feature touches in begin_upload — stylesheets and assets too, chunked if large.",
      "Never use git remotes to version or verify. Never sync_project_tasks unless the user explicitly asked.",
      "Only write files inside your feature's scope_notes.",
      "Never edit src/generated/** or package.json — declare routes, exports, and npm deps in your manifest instead.",
    ],
  };
}

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "vibehub-project" : slug;
}

export async function setupProjectRepository(
  env: AppEnv,
  repo: Repo,
  projectId: string,
  githubToken: string,
  input:
    | { mode: "connect"; repoUrl: string }
    | { mode: "create"; private?: boolean; repoName?: string },
): Promise<{ repo_url: string }> {
  let repoUrl: string;
  if (input.mode === "connect") {
    repoUrl = input.repoUrl.trim();
  } else {
    const project = await requireProject(repo, projectId);
    const name = slugifyName(input.repoName?.trim() || project.name);
    // auto_init gives an immediate default branch + README so we don't race the
    // Contents API on a brand-new empty repo (and avoid writing .github/workflows
    // which needs the GitHub `workflow` OAuth scope).
    const created = await ensureUserRepository(githubToken, {
      name,
      private: input.private === true,
      description: `Created by VibeHub for ${project.name}`,
      autoInit: true,
    });
    repoUrl = created.html_url;
  }

  try {
    await connectRepo(env, repo, projectId, { repoUrl, githubToken });
  } catch (error) {
    // Persist the GitHub link even when seeding fails so the project isn't left
    // asking the user to "connect a repo" after the repo already exists.
    const ref = parseRepoUrl(repoUrl);
    if (ref) {
      try {
        await repo.updateProjectRepo(projectId, {
          repoUrl: `https://github.com/${ref.owner}/${ref.repo}`,
          repoOwner: ref.owner,
          repoName: ref.repo,
          defaultBranch: "main",
          githubTokenEnc: await encryptSecret(githubToken, requireEncryptionKey(env)),
        });
      } catch {
        /* ignore secondary failure */
      }
    }
    throw error;
  }
  return { repo_url: repoUrl };
}

// ------------------------------------------------------------------ repo

function baselineReadme(projectName: string): CommitFile {
  return {
    path: "README.md",
    action: "add",
    content: `# ${projectName}\n\nCoordinated by VibeHub. Files under \`src/generated/\` and \`package.json\` are generated from feature manifests — do not edit them by hand.\n`,
  };
}

function baselineScaffoldFiles(project: ProjectRow): CommitFile[] {
  const merged = mergeManifests([]);
  const generated = generateSharedFiles(merged, {
    existingPackageJson: null,
    projectName: slugifyName(project.name),
  });
  return generated.files.map((file) => ({
    path: file.path,
    action: "add" as const,
    content: file.content,
  }));
}

/**
 * Seeds an empty GitHub repo. Skips `.github/workflows/*` when test_mode is
 * "skip" (or when the OAuth token lacks the `workflow` scope — GitHub returns
 * 404 for those paths without it).
 */
async function seedEmptyRepository(
  client: GitHubClient,
  project: ProjectRow,
  branch: string,
): Promise<string> {
  const wantWorkflow = project.test_mode !== "skip";
  const withoutWorkflow: CommitFile[] = [baselineReadme(project.name), ...baselineScaffoldFiles(project)];
  const withWorkflow: CommitFile[] = wantWorkflow
    ? [
        withoutWorkflow[0]!,
        { path: WORKFLOW_PATH, action: "add", content: WORKFLOW_YAML },
        ...withoutWorkflow.slice(1),
      ]
    : withoutWorkflow;

  try {
    return await client.createInitialCommit(branch, withWorkflow);
  } catch (error) {
    if (!wantWorkflow) throw error;
    // Workflow writes need the `workflow` OAuth scope; GitHub often answers 404.
    // Fall back to a repo without the CI file rather than failing the whole setup.
    return client.createInitialCommit(branch, withoutWorkflow);
  }
}

export async function connectRepo(
  env: AppEnv,
  repo: Repo,
  projectId: string,
  input: { repoUrl: string; githubToken: string },
): Promise<{ project: ProjectRow; baselineCommit: string }> {
  const project = await requireProject(repo, projectId);
  const ref = parseRepoUrl(input.repoUrl);
  if (!ref) {
    throw badRequest(
      `"${input.repoUrl}" is not a recognizable GitHub repo. Use https://github.com/owner/repo or owner/repo.`,
    );
  }

  const client = new GitHubClient(input.githubToken, ref);
  let info: { default_branch: string; private: boolean };
  try {
    info = await client.waitUntilReady();
  } catch {
    throw badRequest(
      `Cannot reach ${ref.owner}/${ref.repo} with the connected GitHub account. Check the URL and that the token has repo access.`,
    );
  }

  const branch = info.default_branch || "main";
  let head = await client.getRefSha(`heads/${branch}`);

  if (head === null) {
    head = await seedEmptyRepository(client, project, branch);
  }

  await repo.updateProjectRepo(projectId, {
    repoUrl: `https://github.com/${ref.owner}/${ref.repo}`,
    repoOwner: ref.owner,
    repoName: ref.repo,
    defaultBranch: branch,
    githubTokenEnc: await encryptSecret(input.githubToken, requireEncryptionKey(env)),
  });
  await repo.setVersionCommit(projectId, 0, head);

  return { project: await requireProject(repo, projectId), baselineCommit: head };
}

// -------------------------------------------------------------- snapshots

const MAX_TOTAL_BYTES = 1_500_000;
const MAX_FILE_BYTES = 200_000;
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "pdf", "zip", "gz", "tgz",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "wasm", "so", "dylib",
]);

function looksBinary(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(extension);
}

export interface SnapshotFile {
  path: string;
  size: number;
  content?: string;
  omitted?: "too-large" | "binary" | "budget-exceeded";
}

/** Reads the repo tree at a given version. Never writes anything. */
export async function pullSnapshot(
  env: AppEnv,
  repo: Repo,
  projectId: string,
  options: { version?: number; paths?: string[] } = {},
): Promise<{
  version: number;
  commit_sha: string;
  files: SnapshotFile[];
  truncated_tree: boolean;
  omitted_paths: string[];
}> {
  const project = await requireProject(repo, projectId);
  const versionNumber = options.version ?? project.current_version;
  const version = await repo.getVersion(projectId, versionNumber);
  if (!version) throw notFound(`Project has no version ${versionNumber}.`);
  if (!version.commit_sha) {
    throw badRequest(
      `Version ${versionNumber} has no commit yet. Connect a GitHub repo to establish the baseline.`,
    );
  }

  const { client } = await connectedLiveRepo(env, repo, project);
  const commit = await client.getCommit(version.commit_sha);
  const tree = await client.getTree(commit.tree.sha, true);

  const wanted = options.paths?.length ? new Set(options.paths) : null;
  const blobs = tree.tree
    .filter((entry) => entry.type === "blob")
    .filter((entry) => !wanted || wanted.has(entry.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const files: SnapshotFile[] = [];
  const omitted: string[] = [];
  let budget = MAX_TOTAL_BYTES;

  for (const entry of blobs) {
    const size = entry.size ?? 0;
    if (looksBinary(entry.path)) {
      files.push({ path: entry.path, size, omitted: "binary" });
      omitted.push(entry.path);
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      files.push({ path: entry.path, size, omitted: "too-large" });
      omitted.push(entry.path);
      continue;
    }
    if (size > budget) {
      files.push({ path: entry.path, size, omitted: "budget-exceeded" });
      omitted.push(entry.path);
      continue;
    }
    files.push({ path: entry.path, size, content: await client.getBlobText(entry.sha) });
    budget -= size;
  }

  return {
    version: versionNumber,
    commit_sha: version.commit_sha,
    files,
    truncated_tree: tree.truncated,
    omitted_paths: omitted,
  };
}

/**
 * Parks work on a side branch. The default branch and `current_version` are
 * untouched, so this never affects the source of truth.
 */
export async function saveSnapshot(
  env: AppEnv,
  repo: Repo,
  projectId: string,
  input: {
    featureIdOrSlug: string | null;
    description: string;
    basedOnVersion?: number;
    changedFiles: CommitFile[];
    userId: string | null;
  },
) {
  const project = await requireProject(repo, projectId);
  const feature = input.featureIdOrSlug
    ? await repo.findFeature(projectId, input.featureIdOrSlug)
    : null;
  if (input.featureIdOrSlug && !feature) {
    throw notFound(`No feature "${input.featureIdOrSlug}" in this project.`);
  }

  const baseVersionNumber = input.basedOnVersion ?? project.current_version;
  const baseVersion = await repo.getVersion(projectId, baseVersionNumber);
  if (!baseVersion?.commit_sha) {
    throw badRequest(`Version ${baseVersionNumber} has no commit to base a snapshot on.`);
  }

  const { client } = await connectedLiveRepo(env, repo, project);
  const snapshot = await repo.createSnapshot({
    projectId,
    featureId: feature?.id ?? null,
    description: input.description,
    storageRef: "pending",
    createdBy: input.userId,
  });

  const { commitSha } = await client.createCommitWithFiles({
    baseCommitSha: baseVersion.commit_sha,
    message: `snapshot(${feature?.slug ?? "project"}): ${input.description || snapshot.id}`,
    files: input.changedFiles,
  });

  const ref = `${SNAPSHOT_REF_PREFIX}${snapshot.id}`;
  await client.upsertRef(ref, commitSha);
  await repo.updateSnapshotRef(snapshot.id, `refs/${ref}`);

  return { id: snapshot.id, storage_ref: `refs/${ref}`, commit_sha: commitSha };
}

/**
 * Aligns VibeHub's version pointer with the real GitHub default-branch tip.
 * Call this whenever something may have committed outside the push gate
 * (e.g. push_to_vibehub file upload, manual git push).
 */
export async function syncProjectWithGithub(
  env: AppEnv,
  repo: Repo,
  projectId: string,
): Promise<{
  synced: boolean;
  version: number;
  commit_sha: string;
  message: string;
}> {
  const project = await requireLiveProject(env, repo, await requireProject(repo, projectId));
  const { client, branch } = await connectedLiveRepo(env, repo, project);
  const tip = await client.getRefSha(`heads/${branch}`);
  if (!tip) {
    throw badRequest(
      `GitHub branch ${branch} has no commits yet. Push code to the repo first.`,
    );
  }

  const current = await repo.getVersion(projectId, project.current_version);
  if (current?.commit_sha === tip) {
    return {
      synced: false,
      version: project.current_version,
      commit_sha: tip,
      message: "Already in sync with GitHub.",
    };
  }

  const changedPaths = current?.commit_sha
    ? await client.changedPathsBetween(current.commit_sha, tip)
    : [];

  for (let attempt = 0; attempt < 5; attempt++) {
    const fresh = await requireProject(repo, projectId);
    const freshCurrent = await repo.getVersion(projectId, fresh.current_version);
    if (freshCurrent?.commit_sha === tip) {
      return {
        synced: false,
        version: fresh.current_version,
        commit_sha: tip,
        message: "Already in sync with GitHub.",
      };
    }

    const nextVersion = fresh.current_version + 1;
    if (!(await repo.casCurrentVersion(projectId, fresh.current_version, nextVersion))) {
      continue;
    }

    try {
      await repo.insertVersion({
        projectId,
        versionNumber: nextVersion,
        commitSha: tip,
        createdByFeatureId: null,
        changedPaths,
      });
    } catch (error) {
      await repo.casCurrentVersion(projectId, nextVersion, fresh.current_version);
      throw error;
    }

    return {
      synced: true,
      version: nextVersion,
      commit_sha: tip,
      message: `Recorded GitHub tip as version ${nextVersion} (${changedPaths.length} paths changed outside VibeHub).`,
    };
  }

  throw badRequest("Could not sync with GitHub — try again in a moment.");
}

/** Pull the latest code: sync with GitHub first, then return the tree. */
export async function pullCode(
  env: AppEnv,
  repo: Repo,
  projectId: string,
  options: { paths?: string[] } = {},
) {
  const sync = await syncProjectWithGithub(env, repo, projectId);
  const snapshot = await pullSnapshot(env, repo, projectId, {
    version: sync.version,
    paths: options.paths,
  });
  return {
    ...snapshot,
    synced: sync.synced,
    sync_message: sync.message,
    how_to_go_back: "Call go_back with a version number from list_history to restore an earlier snapshot.",
  };
}

function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  // Drop trailing empty line from split so "a\n" and "a" compare cleanly.
  if (a.length > 0 && a[a.length - 1] === "") a.pop();
  if (b.length > 0 && b[b.length - 1] === "") b.pop();

  const lines: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${before === null ? 0 : 1},${a.length} +${after === null ? 0 : 1},${b.length} @@`,
  ];

  // Simple Myers-ish fallback: emit full replace hunk (good enough for agent catch-up).
  for (const line of a) lines.push(`-${line}`);
  for (const line of b) lines.push(`+${line}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Line diffs from based_on_version → current tip. Prefer this over full-file pull
 * when catching up before a push.
 */
export async function pullDiff(
  env: AppEnv,
  repo: Repo,
  projectId: string,
  basedOnVersion: number,
) {
  const sync = await syncProjectWithGithub(env, repo, projectId);
  const project = await requireProject(repo, projectId);
  const currentVersion = project.current_version;

  if (basedOnVersion > currentVersion) {
    throw badRequest(
      `based_on_version ${basedOnVersion} is ahead of current version ${currentVersion}.`,
    );
  }

  if (basedOnVersion === currentVersion) {
    return {
      project_id: projectId,
      based_on_version: basedOnVersion,
      current_version: currentVersion,
      up_to_date: true,
      synced: sync.synced,
      diffs: [] as Array<{ path: string; status: string; patch: string }>,
      message: "Already on the latest version. No diffs.",
    };
  }

  const base = await repo.getVersion(projectId, basedOnVersion);
  const head = await repo.getVersion(projectId, currentVersion);
  if (!base?.commit_sha || !head?.commit_sha) {
    throw badRequest("Missing commit for one of the versions — connect the GitHub repo.");
  }

  const { client } = await connectedLiveRepo(env, repo, project);
  const changed = await client.changedFilesBetween(base.commit_sha, head.commit_sha);
  const diffs: Array<{ path: string; status: string; patch: string }> = [];

  for (const entry of changed) {
    const before =
      entry.status === "added" ? null : await client.getFileText(entry.path, base.commit_sha);
    const after =
      entry.status === "removed" ? null : await client.getFileText(entry.path, head.commit_sha);
    diffs.push({
      path: entry.path,
      status: entry.status,
      patch: unifiedDiff(entry.path, before, after),
    });
  }

  return {
    project_id: projectId,
    based_on_version: basedOnVersion,
    current_version: currentVersion,
    up_to_date: false,
    synced: sync.synced,
    diffs,
    message: `Main moved from v${basedOnVersion} to v${currentVersion} (${diffs.length} file${
      diffs.length === 1 ? "" : "s"
    }). Apply these patches locally, resolve conflicts, then ask the user to test and approve before push_code.`,
  };
}

/** Version history for the simple “go back” flow. */
export async function listHistory(repo: Repo, projectId: string) {
  const project = await requireProject(repo, projectId);
  const versions = await repo.listVersions(projectId);
  return {
    project_id: projectId,
    current_version: project.current_version,
    versions: versions.map((version) => ({
      version: version.version_number,
      commit_sha: version.commit_sha,
      created_at: version.created_at,
      changed_paths: parseJsonArray(version.changed_paths),
      is_current: version.version_number === project.current_version,
    })),
    how_to_go_back:
      "Call go_back({ project_id, version }) to restore that version's files on GitHub. History is kept — it creates a new version, it does not erase anything.",
  };
}

/**
 * Reverts the source of truth to an earlier version by committing that version's
 * tree on top of the current head. History is never rewritten.
 */
export async function revertToVersion(
  env: AppEnv,
  repo: Repo,
  projectId: string,
  targetVersionNumber: number,
) {
  await requireLiveProject(env, repo, await requireProject(repo, projectId));
  await syncProjectWithGithub(env, repo, projectId);
  const target = await repo.getVersion(projectId, targetVersionNumber);
  if (!target?.commit_sha) throw badRequest(`Version ${targetVersionNumber} has no commit.`);

  const fresh = await requireProject(repo, projectId);
  const current = await repo.getVersion(projectId, fresh.current_version);
  if (!current?.commit_sha) throw badRequest("Current version has no commit.");
  if (current.commit_sha === target.commit_sha) {
    throw badRequest(`Project is already at the tree of version ${targetVersionNumber}.`);
  }

  const { client, branch } = await connectedLiveRepo(env, repo, fresh);
  const tip = (await client.getRefSha(`heads/${branch}`)) ?? current.commit_sha;
  const targetCommit = await client.getCommit(target.commit_sha);
  const changedPaths = await client.changedPathsBetween(tip, target.commit_sha);

  const revertSha = await client.createCommitFromTree({
    treeSha: targetCommit.tree.sha,
    parentSha: tip,
    message: `revert(vibehub): restore tree of version ${targetVersionNumber}`,
  });
  await client.updateRef(`heads/${branch}`, revertSha, false);

  const nextVersion = fresh.current_version + 1;
  if (!(await repo.casCurrentVersion(projectId, fresh.current_version, nextVersion))) {
    throw badRequest("Someone else updated the project at the same time. Try go_back again.");
  }
  try {
    await repo.insertVersion({
      projectId,
      versionNumber: nextVersion,
      commitSha: revertSha,
      createdByFeatureId: null,
      changedPaths,
    });
  } catch (error) {
    await repo.casCurrentVersion(projectId, nextVersion, fresh.current_version);
    throw error;
  }

  return {
    version: nextVersion,
    commit_sha: revertSha,
    changed_paths: changedPaths,
    restored_from_version: targetVersionNumber,
    message: `Restored the project to how it looked at version ${targetVersionNumber}. This is now version ${nextVersion}.`,
  };
}
