/**
 * The push gate. Entirely deterministic — no model is consulted at any point.
 *
 * A push moves through two stages:
 *
 *   Stage A (`applyPush`)  runs in the background right after `push_feature`
 *                          returns. It does path-based conflict detection, merges
 *                          manifests, regenerates shared wiring, and commits to a
 *                          staging ref. Then it asks GitHub Actions to build.
 *
 *   Stage B (`finalizePush`) runs when the Actions callback arrives. On green it
 *                          fast-forwards the default branch, records a new
 *                          version, marks the feature merged, and unlocks
 *                          dependents. On red it stops, leaving the default
 *                          branch and `current_version` untouched.
 *
 * Committing to a staging ref rather than straight to the default branch is a
 * deliberate refinement of the spec's step ordering: it keeps a failed build from
 * ever landing on the branch agents pull from.
 */

import { Repo, parseJsonArray } from "../db/repo.js";
import { PACKAGE_JSON_PATH, generateSharedFiles } from "../domain/codegen.js";
import {
  changedPathsSince,
  detectPathConflicts,
  validateChangedFiles,
  type ChangedFile,
} from "../domain/conflicts.js";
import {
  describeOverwriteRisk,
  isDestructiveOverwrite,
  type OverwriteRisk,
} from "../domain/content-guard.js";
import { findMissingImports } from "../domain/imports.js";
import { mergeManifests, normalizeManifest, type ManifestConflict } from "../domain/manifest.js";
import { badRequest, errorMessage } from "../lib/errors.js";
import { randomToken } from "../lib/ids.js";
import { sortedUnique } from "../lib/paths.js";
import { GitHubError, type CommitFile, type GitHubClient } from "../github/client.js";
import { sha256Hex } from "../lib/crypto.js";
import { loadGraph, recomputeBlockedStatuses, requireFeature, safeManifest } from "./features.js";
import { isDoneStatus } from "../domain/task-status.js";
import { connectedLiveRepo } from "./repo-health.js";
import { requireProject, syncProjectWithGithub } from "./projects.js";
import type { AppEnv, FeatureRow, ProjectRow, PushRow, VersionRow } from "../types.js";

export const PUSH_REF_PREFIX = "heads/vibehub/push/";
export const DISPATCH_EVENT = "vibehub_build";

export interface PushRequest {
  projectId: string;
  featureIdOrSlug: string;
  basedOnVersion: number;
  changedFiles: ChangedFile[];
  manifest?: unknown;
  notes?: string | null;
  webhookUrl?: string | null;
  userId: string | null;
  /** Set only when the agent means to gut or shrink a file dramatically. */
  allowLargeDeletions?: boolean;
}

export type Scheduler = (work: Promise<unknown>) => void;

/**
 * Simple day-to-day update: sync with GitHub, then submit changed files.
 * Picks based_on_version automatically. Prefer this over push_feature for agents.
 */
export async function pushCode(
  env: AppEnv,
  repo: Repo,
  input: {
    projectId: string;
    featureIdOrSlug: string;
    changedFiles: ChangedFile[];
    manifest?: unknown;
    notes?: string | null;
    webhookUrl?: string | null;
    userId: string | null;
    /** Required: agent confirms the human explicitly told it to push. */
    userApproved: boolean;
    /** Required: agent confirms it built on the project's latest version. */
    confirmedLatestVersion: boolean;
    /** Version the agent built against — must equal current after sync. */
    basedOnVersion: number;
    /** Set only when the agent means to gut or shrink a file dramatically. */
    allowLargeDeletions?: boolean;
  },
  schedule: Scheduler,
): Promise<{ push_id: string; status: PushRow["status"]; based_on_version: number; synced: boolean }> {
  const unconfirmed: string[] = [];
  if (!input.userApproved) {
    unconfirmed.push(
      'confirm_user_approved must be true. Ask the user "Is this code good? Test it and let me know." and wait for an explicit yes.',
    );
  }
  if (!input.confirmedLatestVersion) {
    unconfirmed.push(
      "confirm_built_on_latest must be true. Call get_project_context, make sure your work is based on current_version, then confirm.",
    );
  }
  if (unconfirmed.length > 0) {
    throw badRequest("Push refused: required confirmations are missing.", unconfirmed);
  }

  const sync = await syncProjectWithGithub(env, repo, input.projectId);
  const project = await requireProject(repo, input.projectId);

  if (input.basedOnVersion !== project.current_version) {
    throw badRequest(
      `Push refused: you confirmed you were on the latest version, but you built on v${input.basedOnVersion} and main is v${project.current_version}. Call pull_diff({ project_id, based_on_version: ${input.basedOnVersion} }), apply the line diffs, resolve conflicts, get the user to test and approve again, then push with based_on_version: ${project.current_version}.`,
    );
  }

  const started = await startPush(
    env,
    repo,
    {
      projectId: input.projectId,
      featureIdOrSlug: input.featureIdOrSlug,
      basedOnVersion: project.current_version,
      changedFiles: input.changedFiles,
      manifest: input.manifest,
      notes: input.notes ?? null,
      webhookUrl: input.webhookUrl ?? null,
      userId: input.userId,
      allowLargeDeletions: input.allowLargeDeletions,
    },
    schedule,
  );
  return {
    ...started,
    based_on_version: project.current_version,
    synced: sync.synced,
  };
}

/**
 * The `git status` / `git diff --stat` of a VibeHub push: what each staged file
 * would do to main, and anything that would stop the merge. Read-only.
 */
export async function reviewPush(
  env: AppEnv,
  repo: Repo,
  projectId: string,
  files: ChangedFile[],
) {
  const project = await requireProject(repo, projectId);
  const { client } = await connectedLiveRepo(env, repo, project);
  const head = await repo.getVersion(project.id, project.current_version);
  if (!head?.commit_sha) {
    throw badRequest(
      `Version ${project.current_version} has no commit yet, so there is nothing to compare against.`,
    );
  }

  const encoder = new TextEncoder();
  const entries = [];
  for (const file of files) {
    const existing = await client.getFileText(file.path, head.commit_sha);
    const existingBytes = existing === null ? null : encoder.encode(existing).byteLength;
    const newBytes =
      file.action === "delete" ? 0 : encoder.encode(file.content ?? "").byteLength;
    entries.push({
      path: file.path,
      action: file.action,
      effect:
        file.action === "delete"
          ? existing === null
            ? "already absent"
            : "removes the file"
          : existing === null
            ? "creates a new file"
            : existing === file.content
              ? "no change"
              : "replaces the file",
      bytes_on_main: existingBytes,
      bytes_in_push: newBytes,
      byte_delta: existingBytes === null ? newBytes : newBytes - existingBytes,
    });
  }

  const destructive = await findDestructiveOverwrites(client, head.commit_sha, files);
  const incomplete = await findIncompletePush(client, head.commit_sha, files);
  const warnings = [
    ...destructive.map(
      (risk) => `Would wipe most of ${describeOverwriteRisk(risk)} — looks like a truncated paste.`,
    ),
    ...incomplete.map(
      (item) => `${item.from} imports "${item.specifier}", which is not in this push or on main.`,
    ),
  ];

  return {
    project_id: project.id,
    current_version: project.current_version,
    files: entries,
    warnings,
    ready_to_push: warnings.length === 0,
    next_step:
      warnings.length === 0
        ? "Looks consistent. Ask the user for permission, then push with based_on_version = current_version."
        : "Fix the warnings above before pushing — the server will refuse this push otherwise.",
  };
}

/**
 * Validates the request, records the push, and returns immediately. Structural
 * problems (bad paths, generated-file writes, unknown feature) are reported
 * synchronously; everything the team actually has to react to — conflicts and
 * build failures — arrives via `get_push_status`.
 */
export async function startPush(
  env: AppEnv,
  repo: Repo,
  request: PushRequest,
  schedule: Scheduler,
): Promise<{
  push_id: string;
  status: PushRow["status"];
  file_count: number;
  paths: string[];
  content_digests: Array<{ path: string; sha256: string; bytes: number }>;
  checklist: Array<{ path: string; included: true }>;
}> {
  const project = await requireProject(repo, request.projectId);
  const feature = await requireFeature(repo, request.projectId, request.featureIdOrSlug);

  if (!Number.isInteger(request.basedOnVersion) || request.basedOnVersion < 0) {
    throw badRequest("based_on_version must be a non-negative integer.");
  }
  if (request.basedOnVersion > project.current_version) {
    throw badRequest(
      `based_on_version ${request.basedOnVersion} is ahead of the project's current version ${project.current_version}.`,
    );
  }
  if (!(await repo.getVersion(project.id, request.basedOnVersion))) {
    throw badRequest(`Project has no version ${request.basedOnVersion}.`);
  }

  const validated = await validateChangedFiles(request.changedFiles);
  if (validated.errors.length > 0) {
    throw badRequest("This push was rejected before it was recorded.", validated.errors);
  }

  // Mark the task Working when an agent lands a push (start_task is optional).
  if (feature.assigned_to === request.userId || !feature.assigned_to) {
    const fields: { status: "in_progress"; assigned_to?: string } = { status: "in_progress" };
    if (!feature.assigned_to && request.userId) fields.assigned_to = request.userId;
    await repo.updateFeature(feature.id, fields);
  }

  const push = await repo.createPush({
    projectId: project.id,
    featureId: feature.id,
    basedOnVersion: request.basedOnVersion,
    changedPaths: validated.paths,
    notes: request.notes ?? null,
    callbackTokenHash: null,
    webhookUrl: request.webhookUrl ?? null,
    createdBy: request.userId,
  });

  // Persist the payload so Stage A survives Worker eviction (D1 never stores code).
  await env.PUSH_PAYLOADS.put(
    `push:${push.id}`,
    JSON.stringify({
      files: validated.files,
      manifest: request.manifest ?? null,
      allowLargeDeletions: request.allowLargeDeletions === true,
    }),
    { expirationTtl: 60 * 60 * 24 },
  );

  schedule(
    applyPush(env, repo, push.id).catch(async (error) => {
      await repo
        .updatePush(push.id, {
          status: "failed",
          stage: "done",
          error: `Push processing failed: ${errorMessage(error)}. Re-push to retry.`,
        })
        .catch(() => undefined);
    }),
  );

  return {
    push_id: push.id,
    status: push.status,
    file_count: validated.files.length,
    paths: validated.paths,
    content_digests: validated.digests,
    checklist: validated.paths.map((path) => ({ path, included: true })),
  };
}

interface PushLoad {
  push: PushRow;
  project: ProjectRow;
  feature: FeatureRow;
  versions: VersionRow[];
}

async function loadPush(repo: Repo, pushId: string): Promise<PushLoad> {
  const push = await repo.getPush(pushId);
  if (!push) throw new Error(`No push ${pushId}`);
  const project = await requireProject(repo, push.project_id);
  const feature = await requireFeature(repo, project.id, push.feature_id);
  const versions = await repo.listVersions(project.id);
  return { push, project, feature, versions };
}

function versionPaths(versions: VersionRow[]) {
  return versions.map((version) => ({
    version_number: version.version_number,
    changed_paths: parseJsonArray(version.changed_paths),
  }));
}

async function markConflict(
  env: AppEnv,
  repo: Repo,
  pushId: string,
  paths: string[],
  reason: string,
): Promise<void> {
  await repo.updatePush(pushId, {
    status: "conflict",
    stage: "done",
    conflict_paths: JSON.stringify(paths),
    conflict_reason: reason,
  });
  await cleanupStagingRef(env, repo, pushId);
}

async function markFailed(env: AppEnv, repo: Repo, pushId: string, error: string): Promise<void> {
  await repo.updatePush(pushId, { status: "failed", stage: "done", error });
  await cleanupStagingRef(env, repo, pushId);
}

async function cleanupStagingRef(env: AppEnv, repo: Repo, pushId: string): Promise<void> {
  try {
    const push = await repo.getPush(pushId);
    if (!push?.staging_ref) return;
    const project = await repo.getProject(push.project_id);
    if (!project) return;
    const { client } = await connectedLiveRepo(env, repo, project);
    await client.deleteRef(stagingRefOf(push));
  } catch {
    // Staging cleanup is best-effort.
  }
}

/** True when every pushed file already matches the commit tip (already on main). */
async function pushedFilesMatchTip(
  client: GitHubClient,
  tipSha: string,
  files: ChangedFile[],
): Promise<boolean> {
  for (const file of files) {
    const onTip = await client.getFileText(file.path, tipSha);
    if (file.action === "delete") {
      if (onTip !== null) return false;
      continue;
    }
    const content = file.content ?? "";
    if (onTip !== content) return false;
  }
  return true;
}

/**
 * Feature is already on main — mark merged at the current tip without a new commit.
 */
async function markAlreadyShipped(
  env: AppEnv,
  repo: Repo,
  pushId: string,
  feature: FeatureRow,
  project: ProjectRow,
  tipSha: string,
  note: string,
): Promise<void> {
  await repo.updateFeature(feature.id, { status: "merged" });
  await recomputeBlockedStatuses(repo, project.id);
  await repo.updatePush(pushId, {
    status: "merged",
    stage: "done",
    commit_sha: tipSha,
    merged_version: project.current_version,
    build_output: note,
    conflict_paths: "[]",
    conflict_reason: null,
    error: null,
  });
  await cleanupStagingRef(env, repo, pushId);
}

/**
 * Files whose replacement would destroy most of what is on main. Almost always a
 * truncated paste rather than an intentional rewrite, so the push stops unless
 * the agent said the shrink was deliberate.
 */
export async function findDestructiveOverwrites(
  client: GitHubClient,
  baseCommitSha: string,
  files: ChangedFile[],
): Promise<OverwriteRisk[]> {
  const risks: OverwriteRisk[] = [];
  for (const file of files) {
    if (file.action === "delete" || typeof file.content !== "string") continue;
    const existing = await client.getFileText(file.path, baseCommitSha);
    if (existing === null) continue;

    const existingBytes = new TextEncoder().encode(existing).byteLength;
    const newBytes = new TextEncoder().encode(file.content).byteLength;
    if (isDestructiveOverwrite(existingBytes, newBytes)) {
      risks.push({
        path: file.path,
        existing_bytes: existingBytes,
        new_bytes: newBytes,
        removed_bytes: existingBytes - newBytes,
      });
    }
  }
  return risks;
}

/**
 * Relative imports in the pushed files that resolve to nothing after the merge.
 * A truncated tree means we cannot be sure, so the check stands down.
 */
async function findIncompletePush(
  client: GitHubClient,
  baseCommitSha: string,
  files: ChangedFile[],
): Promise<Array<{ from: string; specifier: string }>> {
  try {
    const tree = await client.getTree(baseCommitSha);
    if (tree.truncated) return [];
    const existing = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
    return findMissingImports(
      files.map((file) => ({ path: file.path, content: file.content, action: file.action })),
      existing,
    );
  } catch {
    return [];
  }
}

/**
 * Rebuilds the shared wiring for a candidate merge and reports any manifest-level
 * disagreement (duplicate route, duplicate export, conflicting dep version).
 */
async function buildSharedFiles(
  repo: Repo,
  client: GitHubClient,
  project: ProjectRow,
  feature: FeatureRow,
  baseCommitSha: string,
): Promise<{ files: CommitFile[]; conflicts: ManifestConflict[] }> {
  const features = await repo.listFeatures(project.id);
  const sources = features
    .filter((row) => isDoneStatus(row.status) || row.id === feature.id)
    .map((row) => ({ featureSlug: row.slug, manifest: safeManifest(row) }));

  const merged = mergeManifests(sources);
  const existingPackageJson = await client.getFileText(PACKAGE_JSON_PATH, baseCommitSha);
  const generated = generateSharedFiles(merged, {
    existingPackageJson,
    projectName: project.name,
  });

  const files: CommitFile[] = [];
  for (const file of generated.files) {
    const current = await client.getFileText(file.path, baseCommitSha);
    // Only rewrite a generated file when its content actually changes, so
    // versions record the smallest truthful set of changed paths.
    if (current !== file.content) {
      files.push({ path: file.path, action: current === null ? "add" : "modify", content: file.content });
    }
  }
  return { files, conflicts: generated.conflicts };
}

/** Stage A. Loads changed files from KV so the work survives Worker eviction. */
export async function applyPush(env: AppEnv, repo: Repo, pushId: string): Promise<void> {
  const stored = await env.PUSH_PAYLOADS.get(`push:${pushId}`, "json");
  const payload = stored as {
    files?: ChangedFile[];
    manifest?: unknown;
    allowLargeDeletions?: boolean;
  } | null;
  if (!payload?.files?.length) {
    await markFailed(
      env,
      repo,
      pushId,
      "Push payload expired or was lost. Ask your agent to push again.",
    );
    return;
  }
  const files = payload.files;
  const rawManifest = payload.manifest;
  const { push, project: projectBefore, feature } = await loadPush(repo, pushId);
  if (push.status !== "testing" || push.stage !== "queued") return;
  await repo.updatePush(pushId, { stage: "applying" });

  // Align with GitHub before conflict checks so out-of-band commits are visible.
  await syncProjectWithGithub(env, repo, projectBefore.id);
  const { project, versions } = await loadPush(repo, pushId);

  // Dependencies must be merged before dependent work can land.
  const view = await loadGraph(repo, project.id);
  const unmet = (view.features.find((f) => f.id === feature.id)?.dependsOn ?? []).filter(
    (slug) => !view.mergedSlugs.has(slug),
  );
  if (unmet.length > 0) {
    await markFailed(
      env,
      repo,
      pushId,
      `Feature "${feature.slug}" depends on ${unmet.map((s) => `"${s}"`).join(", ")}, which ${
        unmet.length === 1 ? "has" : "have"
      } not merged yet.`,
    );
    return;
  }

  const { client, branch } = await connectedLiveRepo(env, repo, project);
  const head = await repo.getVersion(project.id, project.current_version);
  if (!head?.commit_sha) {
    await markFailed(
      env,
      repo,
      pushId,
      `Version ${project.current_version} has no commit. Connect a GitHub repo to establish the baseline.`,
    );
    return;
  }

  // Already on main (e.g. agent git-pushed the same blobs) — ship without a new commit.
  if (await pushedFilesMatchTip(client, head.commit_sha, files)) {
    if (rawManifest !== undefined && rawManifest !== null) {
      try {
        const normalized = normalizeManifest(rawManifest, feature.slug);
        await repo.updateFeature(feature.id, { manifest: JSON.stringify(normalized) });
      } catch (error) {
        await markFailed(env, repo, pushId, `Invalid manifest: ${errorMessage(error)}`);
        return;
      }
    }
    await markAlreadyShipped(
      env,
      repo,
      pushId,
      feature,
      project,
      head.commit_sha,
      "Files already matched GitHub main — marked merged without a new commit.",
    );
    await notifyWebhook(repo, pushId);
    return;
  }

  const incomingPaths = parseJsonArray(push.changed_paths);
  const pathsSince = changedPathsSince(versionPaths(versions), push.based_on_version);
  const overlap = detectPathConflicts(pathsSince, incomingPaths);
  if (overlap.length > 0) {
    await markConflict(
      env,
      repo,
      pushId,
      overlap,
      `${overlap.length} file${overlap.length === 1 ? "" : "s"} you changed were also changed by versions ${
        push.based_on_version + 1
      }–${project.current_version}. Call pull_code, re-merge only the conflict_paths, then push_code again.`,
    );
    return;
  }

  if (payload.allowLargeDeletions !== true) {
    const risks = await findDestructiveOverwrites(client, head.commit_sha, files);
    if (risks.length > 0) {
      await markFailed(
        env,
        repo,
        pushId,
        `This push would wipe most of ${risks.length === 1 ? "a file" : "several files"} — nothing was merged:\n- ${risks
          .map(describeOverwriteRisk)
          .join(
            "\n- ",
          )}\nThis is what a truncated or placeholder body looks like. Re-read each file locally, send the complete text (chunk it with begin_upload/upload_file if large), and push again. If you really do mean to gut the file, push with allow_large_deletions: true.`,
      );
      return;
    }
  }

  const incomplete = await findIncompletePush(client, head.commit_sha, files);
  if (incomplete.length > 0) {
    await markFailed(
      env,
      repo,
      pushId,
      `This push is incomplete — nothing was merged. These imports point at files that are neither in the push nor on main:\n- ${incomplete
        .map((item) => `${item.from} imports "${item.specifier}"`)
        .join(
          "\n- ",
        )}\nUpload every file the feature needs (begin_upload declares the full list, upload_file sends large ones in chunks), then push again.`,
    );
    return;
  }

  // The feature's declared manifest is metadata, so it is safe to persist here
  // and is what codegen unions over.
  if (rawManifest !== undefined && rawManifest !== null) {
    try {
      const normalized = normalizeManifest(rawManifest, feature.slug);
      await repo.updateFeature(feature.id, { manifest: JSON.stringify(normalized) });
      feature.manifest = JSON.stringify(normalized);
    } catch (error) {
      await markFailed(env, repo, pushId, `Invalid manifest: ${errorMessage(error)}`);
      return;
    }
  }

  const shared = await buildSharedFiles(repo, client, project, feature, head.commit_sha);
  if (shared.conflicts.length > 0) {
    await markConflict(
      env,
      repo,
      pushId,
      [],
      `Manifest conflict, so the shared wiring cannot be generated:\n- ${shared.conflicts
        .map((conflict) => conflict.message)
        .join("\n- ")}`,
    );
    return;
  }

  const commitFiles: CommitFile[] = [
    ...files.map((file) => ({
      path: file.path,
      action: file.action,
      content: file.content,
      encoding: file.encoding,
    })),
    ...shared.files,
  ];

  const { commitSha } = await client.createCommitWithFiles({
    baseCommitSha: head.commit_sha,
    message: buildCommitMessage(feature, push),
    files: commitFiles,
  });

  // Identical tree = already on main (avoid empty vibehub commits).
  const baseCommit = await client.getCommit(head.commit_sha);
  const stagedCommit = await client.getCommit(commitSha);
  if (commitSha === head.commit_sha || stagedCommit.tree.sha === baseCommit.tree.sha) {
    await markAlreadyShipped(
      env,
      repo,
      pushId,
      feature,
      project,
      head.commit_sha,
      "No file changes against current main — marked merged without a new commit.",
    );
    await notifyWebhook(repo, pushId);
    return;
  }

  const stagingRef = `${PUSH_REF_PREFIX}${push.id}`;
  await client.upsertRef(stagingRef, commitSha);
  await repo.updatePush(pushId, {
    stage: "building",
    commit_sha: commitSha,
    staging_ref: `refs/${stagingRef}`,
  });

  if (project.test_mode === "skip") {
    await finalizePush(env, repo, pushId, {
      success: true,
      output: "Build gate skipped (project test_mode = skip).",
    });
    return;
  }

  const callbackToken = randomToken();
  await repo.updatePush(pushId, { callback_token_hash: await sha256Hex(callbackToken) });

  try {
    await client.repositoryDispatch(DISPATCH_EVENT, {
      push_id: push.id,
      project_id: project.id,
      feature_id: feature.slug,
      commit_sha: commitSha,
      ref: `refs/${stagingRef}`,
      branch,
      test_spec: feature.test_spec ?? "",
      callback_url: `${env.PUBLIC_URL.replace(/\/$/, "")}/api/pushes/${push.id}/build-result`,
      callback_token: callbackToken,
    });
  } catch (error) {
    await markFailed(
      env,
      repo,
      pushId,
      `Could not trigger the GitHub Actions build: ${errorMessage(error)}. Add .github/workflows/vibehub-build.yml to the repo, or set the project's test mode to "skip".`,
    );
  }
}

function buildCommitMessage(feature: FeatureRow, push: PushRow): string {
  const summary = `feat(${feature.slug}): ${feature.title}`;
  const trailer = `\n\nVibeHub-Push: ${push.id}\nVibeHub-Based-On-Version: ${push.based_on_version}`;
  return push.notes ? `${summary}\n\n${push.notes}${trailer}` : `${summary}${trailer}`;
}

export interface BuildResult {
  success: boolean;
  output?: string;
}

/** Stage B. Idempotent: a repeated callback for a settled push is ignored. */
export async function finalizePush(
  env: AppEnv,
  repo: Repo,
  pushId: string,
  result: BuildResult,
): Promise<void> {
  const initial = await repo.getPush(pushId);
  if (!initial) throw new Error(`No push ${pushId}`);
  if (initial.status !== "testing") return;

  const output = truncate(result.output ?? "", 20_000);

  if (!result.success) {
    await repo.updatePush(pushId, {
      status: "failed",
      stage: "done",
      build_output: output,
      error: "The build gate failed. The default branch and current version are unchanged.",
    });
    await cleanupStagingRef(env, repo, pushId);
    await notifyWebhook(repo, pushId);
    return;
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await sleep(100 * attempt);
    const settled = await tryMerge(env, repo, pushId, output);
    if (settled) {
      await notifyWebhook(repo, pushId);
      return;
    }
  }

  await markFailed(
    env,
    repo,
    pushId,
    "Could not land this push after several retries. Call pull_code to sync with GitHub, then push_code again with the latest files.",
  );
  await notifyWebhook(repo, pushId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One attempt at landing a green push. Returns false when another push is
 * landing concurrently and the caller should retry with fresh state.
 *
 * The version counter is the lock: whoever wins `casCurrentVersion` owns the
 * transition from N to N+1, and only then touches the branch.
 */
async function tryMerge(
  env: AppEnv,
  repo: Repo,
  pushId: string,
  output: string,
): Promise<boolean> {
  // Align with GitHub first — out-of-band commits otherwise make updateRef 422 forever.
  const loaded = await loadPush(repo, pushId);
  await syncProjectWithGithub(env, repo, loaded.project.id);

  const { push, project, feature, versions } = await loadPush(repo, pushId);
  if (!push.commit_sha) {
    await markFailed(env, repo, pushId, "Push has no staged commit to land.");
    return true;
  }

  // Another finalize has taken the counter but not yet written its version row.
  // Its paths are not visible yet, so conflict detection would be wrong.
  if (project.current_version > 0 && !versions.some((v) => v.version_number === project.current_version)) {
    return false;
  }

  const incomingPaths = parseJsonArray(push.changed_paths);
  const pathsSince = changedPathsSince(versionPaths(versions), push.based_on_version);
  const overlap = detectPathConflicts(pathsSince, incomingPaths);
  if (overlap.length > 0) {
    // Another push landed on the same files while this one was building.
    // If our staged blobs already match tip, treat as already shipped.
    const { client } = await connectedLiveRepo(env, repo, project);
    const tip = await client.getRefSha(`heads/${project.default_branch || "main"}`);
    if (tip && push.commit_sha) {
      const staged = await client.getCommit(push.commit_sha);
      const tipCommit = await client.getCommit(tip);
      if (staged.tree.sha === tipCommit.tree.sha) {
        await markAlreadyShipped(
          env,
          repo,
          pushId,
          feature,
          project,
          tip,
          "Staged tree already matched GitHub main — marked merged without moving the branch.",
        );
        return true;
      }
    }
    await markConflict(
      env,
      repo,
      pushId,
      overlap,
      `The build passed, but version ${project.current_version} changed ${
        overlap.length === 1 ? "a file" : "files"
      } this push also changed. Call pull_code, re-merge conflict_paths, then push_code.`,
    );
    return true;
  }

  const head = await repo.getVersion(project.id, project.current_version);
  if (!head?.commit_sha) {
    await markFailed(env, repo, pushId, `Version ${project.current_version} has no commit.`);
    return true;
  }

  const { client, branch } = await connectedLiveRepo(env, repo, project);
  const githubTip = await client.getRefSha(`heads/${branch}`);
  if (!githubTip) {
    await markFailed(env, repo, pushId, `GitHub branch ${branch} has no tip to land on.`);
    return true;
  }

  // Always land on the live GitHub tip — not only D1's recorded head.
  const baseSha = githubTip;
  const staged = await client.getCommit(push.commit_sha);
  let landingSha = push.commit_sha;
  let landedPaths = sortedUnique([
    ...incomingPaths,
    ...(await client.changedPathsBetween(staged.parents[0]?.sha ?? baseSha, push.commit_sha)),
  ]);

  if (staged.parents[0]?.sha !== baseSha) {
    // Head moved (or D1/GitHub drifted). Replay this push's files on top of the tip.
    const replayed = await replayOnto(repo, client, project, feature, push, baseSha);
    if (replayed.conflicts.length > 0) {
      await markConflict(
        env,
        repo,
        pushId,
        [],
        `Manifest conflict against version ${project.current_version}:\n- ${replayed.conflicts
          .map((conflict) => conflict.message)
          .join("\n- ")}`,
      );
      return true;
    }
    // Replay produced no tree change — already on tip.
    if (replayed.commitSha === baseSha) {
      await markAlreadyShipped(
        env,
        repo,
        pushId,
        feature,
        project,
        baseSha,
        "Replay produced no changes against GitHub main — marked merged.",
      );
      return true;
    }
    landingSha = replayed.commitSha;
    landedPaths = replayed.changedPaths;
  }

  const nextVersion = project.current_version + 1;
  if (!(await repo.casCurrentVersion(project.id, project.current_version, nextVersion))) {
    // Another push claimed this transition first. Nothing has been written, so
    // retrying re-checks conflicts against its result.
    return false;
  }

  try {
    await repo.insertVersion({
      projectId: project.id,
      versionNumber: nextVersion,
      commitSha: landingSha,
      createdByFeatureId: feature.id,
      changedPaths: landedPaths,
    });
    // Not forced: if the branch moved again mid-flight, retry with a fresh tip.
    await client.updateRef(`heads/${branch}`, landingSha, false);
    // One tag per successful version — best-effort; merge still counts if tagging fails.
    try {
      await client.ensureTag(`vibehub/v${nextVersion}`, landingSha);
    } catch {
      /* ignore */
    }
  } catch (error) {
    await repo.deleteVersion(project.id, nextVersion);
    await repo.casCurrentVersion(project.id, nextVersion, project.current_version);
    if (error instanceof GitHubError && error.status === 422) return false;
    throw error;
  }

  await repo.updateFeature(feature.id, { status: "merged" });
  await recomputeBlockedStatuses(repo, project.id);
  await repo.updatePush(pushId, {
    status: "merged",
    stage: "done",
    commit_sha: landingSha,
    merged_version: nextVersion,
    build_output: output,
    conflict_paths: "[]",
    conflict_reason: null,
  });
  await client.deleteRef(stagingRefOf(push));
  return true;
}

async function replayOnto(
  repo: Repo,
  client: GitHubClient,
  project: ProjectRow,
  feature: FeatureRow,
  push: PushRow,
  newBaseSha: string,
): Promise<{ commitSha: string; changedPaths: string[]; conflicts: ManifestConflict[] }> {
  if (!push.commit_sha) throw new Error("Cannot replay a push with no staged commit");
  const staged = await client.getCommit(push.commit_sha);
  const stagedParent = staged.parents[0]?.sha;
  if (!stagedParent) throw new Error("Staged commit has no parent");

  const featurePaths = new Set(parseJsonArray(push.changed_paths));
  const diff = await client.changedFilesBetween(stagedParent, push.commit_sha);

  const files: CommitFile[] = [];
  for (const entry of diff) {
    if (!featurePaths.has(entry.path)) continue; // generated files get regenerated below
    if (entry.status === "removed") {
      files.push({ path: entry.path, action: "delete" });
      continue;
    }
    const content = await client.getFileText(entry.path, push.commit_sha);
    if (content === null) continue;
    files.push({
      path: entry.path,
      action: entry.status === "added" ? "add" : "modify",
      content,
    });
  }

  const shared = await buildSharedFiles(repo, client, project, feature, newBaseSha);
  if (shared.conflicts.length > 0) {
    return { commitSha: push.commit_sha, changedPaths: [], conflicts: shared.conflicts };
  }

  const { commitSha } = await client.createCommitWithFiles({
    baseCommitSha: newBaseSha,
    message: buildCommitMessage(feature, push),
    files: [...files, ...shared.files],
  });

  return {
    commitSha,
    changedPaths: sortedUnique([...featurePaths, ...shared.files.map((file) => file.path)]),
    conflicts: [],
  };
}

function stagingRefOf(push: PushRow): string {
  return push.staging_ref?.replace(/^refs\//, "") ?? `${PUSH_REF_PREFIX}${push.id}`;
}

async function notifyWebhook(repo: Repo, pushId: string): Promise<void> {
  const push = await repo.getPush(pushId);
  if (!push?.webhook_url) return;
  try {
    await fetch(push.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        push_id: push.id,
        project_id: push.project_id,
        status: push.status,
        merged_version: push.merged_version,
        conflict_paths: parseJsonArray(push.conflict_paths),
        error: push.error,
      }),
    });
  } catch {
    // A push outcome is authoritative in D1; a failed webhook is not fatal.
  }
}

/**
 * Poll target for `get_push_status`. On conflict it returns paths + tip SHAs
 * (not full file bodies) — call pull_code for content.
 */
export async function getPushStatus(
  _env: AppEnv,
  repo: Repo,
  pushId: string,
): Promise<Record<string, unknown>> {
  const push = await repo.getPush(pushId);
  if (!push) throw badRequest(`No push ${pushId}.`);
  const project = await requireProject(repo, push.project_id);
  const feature = await repo.findFeature(project.id, push.feature_id);

  const base: Record<string, unknown> = {
    push_id: push.id,
    project_id: push.project_id,
    feature_id: feature?.slug ?? push.feature_id,
    status: push.status,
    stage: push.stage,
    based_on_version: push.based_on_version,
    current_version: project.current_version,
    changed_paths: parseJsonArray(push.changed_paths),
    commit_sha: push.commit_sha,
    created_at: push.created_at,
    updated_at: push.updated_at,
  };

  if (push.status === "merged") {
    return {
      ...base,
      merged_version: push.merged_version,
      version_tag: push.merged_version != null ? `vibehub/v${push.merged_version}` : null,
      build_output: push.build_output,
    };
  }

  if (push.status === "failed") {
    return { ...base, error: push.error, build_output: push.build_output };
  }

  if (push.status === "conflict") {
    const conflictPaths = parseJsonArray(push.conflict_paths);
    const conflictHints: Array<{ path: string; tip_sha: string | null }> = [];
    const head = await repo.getVersion(project.id, project.current_version);
    const tipSha = head?.commit_sha ?? null;
    for (const path of conflictPaths) {
      conflictHints.push({ path, tip_sha: tipSha });
    }
    return {
      ...base,
      reason: push.conflict_reason,
      conflict_paths: conflictPaths,
      /** Paths that overlap tip — fetch content with pull_code({ paths }). */
      conflicting_files: conflictHints,
      tip_commit_sha: tipSha,
      next_step:
        "Call pull_code with conflict_paths to fetch tip content, re-merge locally, then push_code again. Do not git push the default branch — VibeHub is the only writer of main.",
    };
  }

  return base;
}

/** Verifies the one-time token a GitHub Actions run presents on callback. */
export async function verifyCallbackToken(
  repo: Repo,
  pushId: string,
  token: string,
): Promise<boolean> {
  const push = await repo.getPush(pushId);
  if (!push?.callback_token_hash) return false;
  return (await sha256Hex(token)) === push.callback_token_hash;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…output truncated…`;
}
