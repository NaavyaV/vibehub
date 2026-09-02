/**
 * Create a GitHub repo from VibeHub and seed it with local files.
 * Push and project import run as separate requests so each stays within Worker limits.
 */

import {
  GitHubClient,
  GitHubError,
  PartialUploadError,
  ensureUserRepository,
  fetchGithubLogin,
  findUserRepository,
  parseRepoUrl,
  type CommitFile,
} from "../github/client.js";
import { WORKFLOW_PATH, WORKFLOW_YAML } from "../github/workflow-template.js";
import {
  collectGitignoreRules,
  DEFAULT_GITIGNORE,
  normalizeUploadPath,
  shouldUploadPath,
} from "../domain/upload-filter.js";
import { badRequest, HttpError } from "../lib/errors.js";
import {
  fetchGithubTokenScopes,
  tokenHasPrivateRepoAccess,
  tokenHasRepoAccess,
} from "../auth/github-oauth.js";
import { importExistingRepo } from "./existing.js";
import { cleanupProjectsForRepoUrl } from "./repo-health.js";
import type { AppEnv, TestMode } from "../types.js";
import type { Repo } from "../db/repo.js";

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 3_000_000;
const MAX_FILE_BYTES = 400_000;
const MAX_INCOMING_ENTRIES = 500;

export interface UploadFileInput {
  path: string;
  content: string;
}

export const BOOTSTRAP_DECISION_TREE = [
  "First push decision tree:",
  "  Has git remote pointing to GitHub with code pushed → push_to_vibehub({ repo_url, project_id? })",
  "  Has shell access, no git remote yet → bootstrap_via_git({ repo_name }) → run git_commands → bootstrap_via_git({ repo_url, wait_for_commits: true })",
  "  No shell, must upload files → push_to_vibehub({ repo_name, files[] }) — skips lockfiles and node_modules",
  "  Repo not found on upload → bootstrap_via_git or prepare_git_push, push locally, then import_project_repo",
].join("\n");

function normalizeRepoName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function prepareSourceFiles(
  files: UploadFileInput[],
  options: { includeWorkflow?: boolean } = {},
): { sourceFiles: CommitFile[]; workflowFile: CommitFile | null } {
  if (!Array.isArray(files) || files.length === 0) {
    throw badRequest("Select a folder with at least one text file to upload.");
  }
  if (files.length > MAX_INCOMING_ENTRIES) {
    throw badRequest(
      `Too many files in the upload (${files.length}). node_modules and build folders should be excluded — try choosing your project root again.`,
    );
  }

  const gitignoreRules = collectGitignoreRules(files);
  const prepared: CommitFile[] = [];
  let totalBytes = 0;
  const seen = new Set<string>();

  for (const raw of files) {
    const path = normalizeUploadPath(String(raw.path ?? ""));
    if (!shouldUploadPath(path, gitignoreRules)) continue;
    if (seen.has(path)) continue;

    const content = String(raw.content ?? "");
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes === 0) continue;
    if (bytes > MAX_FILE_BYTES) {
      throw badRequest(`File ${path} is too large (max ${MAX_FILE_BYTES} bytes per file).`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw badRequest(
        `Upload is too large (max ${MAX_TOTAL_BYTES} bytes total). Build output, lockfiles, and dependencies are excluded automatically — use bootstrap_via_git if the project is large.`,
      );
    }
    if (prepared.length >= MAX_FILES) {
      throw badRequest(
        `Too many files to upload at once (max ${MAX_FILES} after filtering). Use bootstrap_via_git with git push instead.`,
      );
    }

    seen.add(path);
    prepared.push({ path, action: "add", content });
  }

  if (prepared.length === 0) {
    throw badRequest(
      "No uploadable text files found. node_modules, lockfiles, .git, dist, and binary files are skipped.",
    );
  }

  if (!prepared.some((file) => file.path === ".gitignore")) {
    prepared.push({ path: ".gitignore", action: "add", content: DEFAULT_GITIGNORE });
  }

  let workflowFile: CommitFile | null = null;
  if (options.includeWorkflow !== false && !prepared.some((file) => file.path === WORKFLOW_PATH)) {
    workflowFile = { path: WORKFLOW_PATH, action: "add", content: WORKFLOW_YAML };
  }

  const sourceFiles = prepared.filter((file) => file.path !== WORKFLOW_PATH);
  return { sourceFiles, workflowFile };
}

function githubErrorMessage(error: GitHubError, context?: { owner?: string; repo?: string }): string {
  const repoLabel = context?.owner && context?.repo ? `${context.owner}/${context.repo}` : "the repository";

  if (error instanceof PartialUploadError) {
    return error.message;
  }

  if (error.status === 404) {
    if (error.message.includes(WORKFLOW_PATH)) {
      return `GitHub repo ${repoLabel} is not ready for uploads yet. Retry with the same repo_name and project_id, or use bootstrap_via_git: push with git locally, then import.\n\n${BOOTSTRAP_DECISION_TREE}`;
    }
    return `GitHub repo ${repoLabel} was not found or is not ready. If you just created it, wait a few seconds and retry with the same repo_name. Otherwise:\n\n${BOOTSTRAP_DECISION_TREE}`;
  }

  if (error.status === 422) {
    return `${error.message} The repository name may already exist — retry with the same repo_name and project_id to update it, or use bootstrap_via_git.`;
  }

  if (error.status === 401 || error.status === 403) {
    return `${error.message} Reconnect GitHub in VibeHub Settings and ensure the token has repo scope.`;
  }

  return error.message;
}

function rethrowUploadError(error: unknown, context?: { owner?: string; repo?: string }): never {
  if (error instanceof GitHubError) {
    throw badRequest(githubErrorMessage(error, context));
  }
  if (error instanceof HttpError) throw error;
  const detail = error instanceof Error ? error.message : String(error);
  throw badRequest(
    detail.includes("CPU") || detail.includes("timeout") || detail.includes("limit")
      ? `GitHub push timed out — use bootstrap_via_git (git push) instead of uploading files through MCP.\n\n${BOOTSTRAP_DECISION_TREE}`
      : `Upload failed: ${detail}`,
  );
}

async function validateLocalUpload(input: {
  repoName: string;
  private?: boolean;
  githubToken: string;
  files: UploadFileInput[];
  existingRepoUrl?: string;
}) {
  const repoName = normalizeRepoName(input.repoName);
  if (!repoName) {
    throw badRequest("Enter a repository name (letters, numbers, hyphens, dots).");
  }

  const scopes = await fetchGithubTokenScopes(input.githubToken);
  if (!tokenHasRepoAccess(scopes)) {
    throw badRequest("Connect your GitHub repos first so VibeHub can create a repository for you.");
  }
  if (input.private && !tokenHasPrivateRepoAccess(scopes)) {
    throw badRequest("Private repositories need private-repo access.", {
      code: "private_repo_access_required",
    });
  }

  return {
    repoName,
    ...prepareSourceFiles(input.files, { includeWorkflow: !input.existingRepoUrl }),
  };
}

async function resolveGithubTarget(input: {
  githubToken: string;
  repoName: string;
  private?: boolean;
  existingRepoUrl?: string;
}): Promise<{ owner: string; name: string; htmlUrl: string; branch: string; reused: boolean }> {
  if (input.existingRepoUrl) {
    const ref = parseRepoUrl(input.existingRepoUrl);
    if (!ref) throw badRequest("Invalid existing repo URL.");
    const client = new GitHubClient(input.githubToken, ref);
    const info = await client.waitUntilReady();
    return {
      owner: ref.owner,
      name: ref.repo,
      htmlUrl: `https://github.com/${ref.owner}/${ref.repo}`,
      branch: info.default_branch || "main",
      reused: true,
    };
  }

  const login = await fetchGithubLogin(input.githubToken);
  const existing = await findUserRepository(input.githubToken, login, input.repoName);
  if (existing) {
    const client = new GitHubClient(input.githubToken, {
      owner: existing.owner,
      repo: existing.name,
    });
    await client.waitUntilReady();
    return {
      owner: existing.owner,
      name: existing.name,
      htmlUrl: existing.html_url,
      branch: existing.default_branch || "main",
      reused: true,
    };
  }

  const created = await ensureUserRepository(input.githubToken, {
    name: input.repoName,
    private: input.private ?? false,
    description: "Created by VibeHub",
    autoInit: false,
  });

  const client = new GitHubClient(input.githubToken, {
    owner: created.owner,
    repo: created.name,
  });
  await client.waitUntilReady();

  return {
    owner: created.owner,
    name: created.name,
    htmlUrl: created.html_url,
    branch: created.default_branch || "main",
    reused: false,
  };
}

async function pushFilesToRepo(input: {
  githubToken: string;
  owner: string;
  name: string;
  branch: string;
  sourceFiles: CommitFile[];
  workflowFile: CommitFile | null;
  reused: boolean;
}): Promise<void> {
  const client = new GitHubClient(input.githubToken, { owner: input.owner, repo: input.name });
  const message = input.reused
    ? "chore(vibehub): update project files"
    : "chore(vibehub): import project files";

  if (input.sourceFiles.length > 0) {
    await client.pushInitialFiles(input.branch, input.sourceFiles, message);
  }

  if (input.workflowFile) {
    await client.pushInitialFiles(input.branch, [input.workflowFile], "chore(vibehub): add CI workflow");
  }
}

/** Creates the GitHub repo and pushes filtered local files. */
export async function pushLocalCodeToGithub(input: {
  repoName: string;
  private?: boolean;
  githubToken: string;
  files: UploadFileInput[];
  existingRepoUrl?: string;
  cleanupDb?: Repo;
}): Promise<{ repo_url: string; repo_name: string; file_count: number; reused_repo: boolean }> {
  const { repoName, sourceFiles, workflowFile } = await validateLocalUpload(input);

  try {
    const target = await resolveGithubTarget({
      githubToken: input.githubToken,
      repoName,
      private: input.private,
      existingRepoUrl: input.existingRepoUrl,
    });

    await pushFilesToRepo({
      githubToken: input.githubToken,
      owner: target.owner,
      name: target.name,
      branch: target.branch,
      sourceFiles,
      workflowFile,
      reused: target.reused,
    });

    const fileCount = sourceFiles.length + (workflowFile ? 1 : 0);
    return {
      repo_url: target.htmlUrl,
      repo_name: target.name,
      file_count: fileCount,
      reused_repo: target.reused,
    };
  } catch (error) {
    if (
      input.existingRepoUrl &&
      input.cleanupDb &&
      error instanceof GitHubError &&
      error.status === 404
    ) {
      await cleanupProjectsForRepoUrl(input.cleanupDb, input.existingRepoUrl);
    }
    rethrowUploadError(error, { owner: repoName, repo: repoName });
  }
}

export async function importFromLocalCode(
  env: AppEnv,
  repo: Repo,
  input: {
    repoName: string;
    private?: boolean;
    githubToken: string;
    userId: string;
    files: UploadFileInput[];
    testMode?: TestMode;
    projectName?: string;
  },
) {
  const pushed = await pushLocalCodeToGithub(input);
  try {
    return await importExistingRepo(env, repo, {
      repoUrl: pushed.repo_url,
      githubToken: input.githubToken,
      userId: input.userId,
      projectName: input.projectName?.trim() || pushed.repo_name,
      testMode: input.testMode ?? "skip",
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    rethrowUploadError(error);
  }
}
