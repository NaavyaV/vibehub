/**
 * Bootstrap a VibeHub project from local code — via git push or agent-supplied files.
 */

import { Repo } from "../db/repo.js";
import {
  ensureUserRepository,
  fetchGithubLogin,
  findUserRepository,
  GitHubClient,
  parseRepoUrl,
} from "../github/client.js";
import { sha256Hex } from "../lib/crypto.js";
import {
  findLiveProjectByRepoName,
  findLiveProjectByRepoUrl,
  requireLiveProject,
} from "./repo-health.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { randomToken } from "../lib/ids.js";
import { publicUrl, type AppEnv, type TestMode } from "../types.js";
import { requireMembership } from "./access.js";
import { importExistingRepo } from "./existing.js";
import { requireUserGithubToken } from "./github-user.js";
import { syncProjectTasks, type TaskSyncInput } from "./features.js";
import { syncProjectWithGithub } from "./projects.js";
import { pushLocalCodeToGithub, type UploadFileInput, BOOTSTRAP_DECISION_TREE } from "./upload.js";
import {
  buildAgentPushPrompt,
  buildPushKit,
} from "./agent-kit.js";

export function gitPushInstructions(input: {
  repoUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  folderHint?: string;
}): { commands: string[]; notes: string[] } {
  const branch = input.defaultBranch || "main";
  const folder = input.folderHint?.trim() || ".";
  return {
    commands: [
      `cd ${folder}`,
      `git remote add vibehub ${input.cloneUrl}`,
      `git push -u vibehub HEAD:${branch}`,
    ],
    notes: [
      "Use an empty GitHub repo — VibeHub creates one with no commits so your first push works like normal.",
      "If `vibehub` remote already exists: git remote set-url vibehub " + input.cloneUrl,
      `After pushing, import the repo into VibeHub (web UI or MCP tool import_project_repo).`,
    ],
  };
}

export function agentBootstrapGuide(input: {
  env: AppEnv;
  projectId: string;
  projectName: string;
  repoUrl: string;
  featureCount: number;
  refinePrompt?: string;
  mcpUrl: string;
}): string {
  const lines = [
    `# VibeHub project ready: ${input.projectName}`,
    "",
    `Project ID: ${input.projectId}`,
    `Repo: ${input.repoUrl}`,
    `MCP URL: ${input.mcpUrl}`,
    "",
    "## What happened",
    `- Project linked to GitHub. Add tasks on the project page (or only if the user asks: sync_project_tasks with user_explicitly_requested).`,
    "",
    "## Next steps for the agent",
    "1. Call `get_project_context` with this project_id.",
    "2. Do NOT invent tasks. Only call `sync_project_tasks` if the user explicitly asked.",
    "3. Per feature: `get_my_task` → `pull_snapshot` → write code → `begin_upload` (declare every file) → `upload_file` for large ones → `push_code` with both confirmations → `get_push_status`. Stop.",
    "4. Never use git remotes to version or verify. Never edit `src/generated/**` or root `package.json`.",
    "",
    "## Refine the task tree (optional)",
    "Paste the refine prompt below into your LLM if you want a richer feature breakdown:",
    "",
    input.refinePrompt ?? "(none)",
  ];
  return lines.join("\n");
}

/** Plain-language prompt users paste into Cursor, Claude, etc. */
export function agentPushPrompt(mcpUrl: string, hasMcpToken = false): string {
  return buildAgentPushPrompt({ mcpUrl, hasMcpToken });
}

function inferRepoName(files: UploadFileInput[]): string | null {
  for (const file of files) {
    if (file.path !== "package.json") continue;
    try {
      const pkg = JSON.parse(file.content) as { name?: string };
      const name = pkg.name?.trim();
      if (!name) continue;
      return name.replace(/^@[^/]+\//, "").slice(0, 100);
    } catch {
      /* ignore invalid package.json */
    }
  }
  return null;
}

export async function ensureMcpToken(
  env: AppEnv,
  repo: Repo,
  userId: string,
  name = "My agent",
): Promise<{ mcp_url: string; token?: string; created: boolean }> {
  const mcpUrl = `${publicUrl(env)}/mcp`;
  const existing = await repo.listApiTokens(userId);
  if (existing.length > 0) return { mcp_url: mcpUrl, created: false };

  const token = `vh_${randomToken(32)}`;
  await repo.createApiToken({
    userId,
    name,
    tokenHash: await sha256Hex(token),
  });
  return { mcp_url: mcpUrl, token, created: true };
}

function bootstrapConfigExtras(
  env: AppEnv,
  input: {
    projectId: string;
    projectUrl: string;
    repoUrl: string | null;
    repoName?: string | null;
    hasMcpToken?: boolean;
  },
) {
  const mcpUrl = `${publicUrl(env)}/mcp`;
  const pushKit = buildPushKit({
    projectId: input.projectId,
    projectUrl: input.projectUrl,
    repoUrl: input.repoUrl,
    repoName: input.repoName ?? input.repoUrl?.replace(/^https:\/\/github\.com\/[^/]+\//, "") ?? null,
    mcpUrl,
    hasMcpToken: input.hasMcpToken ?? false,
  });

  return {
    vibehub_config: {
      project_id: input.projectId,
      project_url: input.projectUrl,
      repo_url: input.repoUrl,
      mcp_url: mcpUrl,
    },
    project_config_path: pushKit.project_config_path,
    project_config: pushKit.project_config,
    gitignore_snippet: pushKit.gitignore_snippet,
    bootstrap_decision_tree: BOOTSTRAP_DECISION_TREE,
  };
}

function pushToVibehubResponse(
  env: AppEnv,
  imported: Awaited<ReturnType<typeof importProjectRepo>> & { files_pushed?: number },
  mcp: Awaited<ReturnType<typeof ensureMcpToken>>,
  hasMcpToken: boolean,
) {
  const projectUrl = imported.project_url;
  const mcpUrl = mcp.mcp_url;
  const pushKit = buildPushKit({
    projectId: imported.project_id,
    projectUrl,
    repoUrl: imported.repo_url ?? null,
    repoName: imported.repo_url?.replace(/^https:\/\/github\.com\/[^/]+\//, "") ?? null,
    mcpUrl,
    hasMcpToken: hasMcpToken || Boolean(mcp.token),
  });

  return {
    success: true,
    message: `Project "${imported.name}" is ready on VibeHub.`,
    project_id: imported.project_id,
    project_url: projectUrl,
    repo_url: imported.repo_url,
    feature_count: imported.feature_count,
    files_pushed: imported.files_pushed,
    next_steps: [
      `Open your project: ${projectUrl}`,
      "Save .vibehub/project.json locally and add .vibehub/ to .gitignore (see gitignore_snippet). Do not commit VibeHub files.",
      "Pick your AI tool on the VibeHub project page — or paste push_prompt into chat.",
    ],
    mcp_url: mcpUrl,
    ...(mcp.token ? { mcp_token: mcp.token, mcp_token_note: "Copy this token now — shown once." } : {}),
    ...bootstrapConfigExtras(env, {
      projectId: imported.project_id,
      projectUrl,
      repoUrl: imported.repo_url ?? null,
      hasMcpToken: hasMcpToken || Boolean(mcp.token),
    }),
    cursor_mcp_config: pushKit.cursor_mcp_config,
    cursor_rule: pushKit.cursor_rule,
    push_prompt: pushKit.push_prompt,
    agent_push_prompt: pushKit.agent_push_prompt,
    agents: pushKit.agents,
    setup_steps: pushKit.setup_steps,
    has_project: pushKit.has_project,
    agent_guide: imported.agent_guide,
    refine_prompt: imported.refine_prompt,
  };
}

function stableRepoName(input: {
  repoName?: string;
  projectName?: string;
  files?: UploadFileInput[];
}): string {
  return (
    input.repoName?.trim() ||
    (input.files ? inferRepoName(input.files) : null) ||
    input.projectName?.trim() ||
    "my-project"
  );
}

async function existingImportResponse(
  env: AppEnv,
  repo: Repo,
  projectId: string,
  repoUrl: string,
  extras: { files_pushed?: number; reused_repo?: boolean } = {},
) {
  const project = await repo.getProject(projectId);
  const features = project ? await repo.listFeatures(projectId) : [];
  const base = {
    project_id: projectId,
    name: project?.name ?? projectId,
    repo_url: repoUrl,
    project_url: `${publicUrl(env)}/projects/${projectId}`,
    feature_count: features.length,
    features: features.map((feature) => ({
      id: feature.slug,
      title: feature.title,
      scope_notes: feature.scope_notes,
    })),
    refine_prompt: "",
    path_count: 0,
    already_exists: true as const,
    ...extras,
  };
  return {
    ...base,
    mcp_url: `${publicUrl(env)}/mcp`,
    ...bootstrapConfigExtras(env, {
      projectId,
      projectUrl: base.project_url,
      repoUrl,
    }),
    agent_guide: agentBootstrapGuide({
      env,
      projectId,
      projectName: base.name,
      repoUrl,
      featureCount: base.feature_count,
      mcpUrl: `${publicUrl(env)}/mcp`,
    }),
  };
}

async function applyAgentTasks(
  repo: Repo,
  projectId: string,
  userId: string,
  tasks?: TaskSyncInput[],
): Promise<{ tasks_synced: number; tasks_skipped: boolean; tasks_deleted: number; tasks_message: string }> {
  const result = await syncProjectTasks(repo, projectId, tasks ?? [], userId);
  const hasTasks = (tasks?.length ?? 0) > 0;
  return {
    tasks_synced: result.skipped ? 0 : result.created,
    tasks_skipped: result.skipped,
    tasks_deleted: result.deleted,
    tasks_message: result.skipped
      ? hasTasks
        ? "No tasks updated — the task list was left unchanged."
        : "Project looks complete. No tasks added."
      : `Added ${result.created} tasks (removed ${result.deleted} old open tasks).`,
  };
}

/**
 * One-shot entry point when a user says "push this to VibeHub".
 * Accepts source files (agent reads workspace) or an existing repo_url.
 */
export async function pushToVibehub(
  env: AppEnv,
  repo: Repo,
  userId: string,
  input: {
    projectId?: string;
    repoName?: string;
    projectName?: string;
    private?: boolean;
    testMode?: TestMode;
    repoUrl?: string;
    files?: UploadFileInput[];
    tasks?: TaskSyncInput[];
    mintMcpToken?: boolean;
  },
) {
  const { token } = await requireUserGithubToken(env, repo, userId);
  const userTokens = await repo.listApiTokens(userId);
  const repoName = stableRepoName(input);
  let targetRepoUrl = input.repoUrl?.trim() || null;
  let existingProjectId = input.projectId?.trim() || null;

  if (existingProjectId) {
    await requireMembership(repo, existingProjectId, userId);
    let project = await repo.getProject(existingProjectId);
    if (!project) throw badRequest(`No project ${existingProjectId}.`);
    try {
      project = await requireLiveProject(env, repo, project);
      if (project.repo_url) targetRepoUrl = project.repo_url;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        existingProjectId = null;
        targetRepoUrl = input.repoUrl?.trim() || null;
      } else {
        throw error;
      }
    }
  }

  if (!targetRepoUrl) {
    const byName = await findLiveProjectByRepoName(env, repo, userId, repoName);
    if (byName?.repo_url) {
      targetRepoUrl = byName.repo_url;
      existingProjectId = existingProjectId ?? byName.id;
    }
  } else if (!existingProjectId) {
    const byUrl = await findLiveProjectByRepoUrl(env, repo, userId, targetRepoUrl);
    if (byUrl) existingProjectId = byUrl.id;
  }

  const finishResponse = (
    imported: Awaited<ReturnType<typeof importProjectRepo>> & { files_pushed?: number },
    mcp: Awaited<ReturnType<typeof ensureMcpToken>>,
    extras: Record<string, unknown> = {},
  ) => ({
    ...pushToVibehubResponse(
      env,
      imported,
      mcp,
      userTokens.length > 0 || Boolean(mcp.token),
    ),
    ...extras,
  });

  if (input.files && input.files.length > 0) {
    const pushed = await pushLocalCodeToGithub({
      repoName,
      private: input.private,
      githubToken: token,
      files: input.files,
      existingRepoUrl: targetRepoUrl ?? undefined,
      cleanupDb: repo,
    });
    targetRepoUrl = pushed.repo_url;

    if (existingProjectId) {
      await syncProjectWithGithub(env, repo, existingProjectId).catch(() => null);
      const imported = await existingImportResponse(env, repo, existingProjectId, targetRepoUrl, {
        files_pushed: pushed.file_count,
        reused_repo: pushed.reused_repo,
      });
      const taskResult = await applyAgentTasks(repo, existingProjectId, userId, input.tasks);
      const mcp =
        input.mintMcpToken === false
          ? { mcp_url: `${publicUrl(env)}/mcp`, created: false as const }
          : await ensureMcpToken(env, repo, userId);
      return finishResponse(imported, mcp, {
        ...taskResult,
        reused_repo: pushed.reused_repo,
        already_exists: true,
        message: pushed.reused_repo
          ? `Updated ${pushed.file_count} files on existing repo ${targetRepoUrl}. VibeHub is synced to the new GitHub tip.`
          : `Uploaded ${pushed.file_count} files to ${targetRepoUrl}.`,
      });
    }

    const duplicate = await findLiveProjectByRepoUrl(env, repo, userId, targetRepoUrl);
    if (duplicate) {
      await syncProjectWithGithub(env, repo, duplicate.id).catch(() => null);
      const imported = await existingImportResponse(env, repo, duplicate.id, targetRepoUrl, {
        files_pushed: pushed.file_count,
        reused_repo: pushed.reused_repo,
      });
      const taskResult = await applyAgentTasks(repo, duplicate.id, userId, input.tasks);
      const mcp =
        input.mintMcpToken === false
          ? { mcp_url: `${publicUrl(env)}/mcp`, created: false as const }
          : await ensureMcpToken(env, repo, userId);
      return finishResponse(imported, mcp, {
        ...taskResult,
        reused_repo: pushed.reused_repo,
        already_exists: true,
        message: `Project already linked to ${targetRepoUrl}. Updated ${pushed.file_count} files and synced VibeHub.`,
      });
    }

    const imported = await bootstrapProjectFromCode(env, repo, userId, {
      repoName,
      private: input.private,
      projectName: input.projectName ?? repoName,
      testMode: input.testMode,
      files: input.files,
      existingRepoUrl: targetRepoUrl,
    });
    const taskResult = await applyAgentTasks(repo, imported.project_id, userId, input.tasks);
    const mcp =
      input.mintMcpToken === false
        ? { mcp_url: `${publicUrl(env)}/mcp`, created: false as const }
        : await ensureMcpToken(env, repo, userId);
    return { ...finishResponse(imported, mcp), ...taskResult };
  }

  let imported: Awaited<ReturnType<typeof importProjectRepo>> & { files_pushed?: number };

  if (targetRepoUrl) {
    imported = await importProjectRepo(env, repo, userId, {
      repoUrl: targetRepoUrl,
      projectName: input.projectName,
      testMode: input.testMode,
    });
  } else {
    throw badRequest(
      `Pass files[] with project source (skip node_modules, lockfiles, and dist), or repo_url if the code is already on GitHub.\n\n${BOOTSTRAP_DECISION_TREE}`,
    );
  }

  const taskResult = await applyAgentTasks(repo, imported.project_id, userId, input.tasks);
  const mcp =
    input.mintMcpToken === false
      ? { mcp_url: `${publicUrl(env)}/mcp`, created: false as const }
      : await ensureMcpToken(env, repo, userId);

  return { ...finishResponse(imported, mcp), ...taskResult };
}

/** Creates an empty GitHub repo meant for a local `git push`. */
export async function prepareGitPushRepo(
  env: AppEnv,
  repo: Repo,
  userId: string,
  input: { repoName: string; private?: boolean; folderHint?: string },
) {
  const { token, user } = await requireUserGithubToken(env, repo, userId);
  const name = input.repoName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!name) throw badRequest("Enter a repository name.");

  const login = user.github_login ?? (await fetchGithubLogin(token));
  const existing = await findUserRepository(token, login, name);
  if (existing) {
    const cloneUrl = `https://github.com/${existing.owner}/${existing.name}.git`;
    const { commands, notes } = gitPushInstructions({
      repoUrl: existing.html_url,
      cloneUrl,
      defaultBranch: existing.default_branch || "main",
      folderHint: input.folderHint,
    });
    return {
      repo_url: existing.html_url,
      clone_url: cloneUrl,
      repo_name: existing.name,
      owner: existing.owner,
      default_branch: existing.default_branch || "main",
      private: existing.private,
      github_login: login,
      already_exists: true,
      git_commands: commands,
      notes: [
        "This GitHub repo already exists — reusing it instead of creating a duplicate.",
        ...notes,
      ],
      import_hint:
        "After git push completes, call bootstrap_via_git({ repo_url, wait_for_commits: true }) or import_project_repo.",
      mcp_url: `${publicUrl(env)}/mcp`,
      bootstrap_decision_tree: BOOTSTRAP_DECISION_TREE,
      next_tool_call: {
        tool: "bootstrap_via_git",
        args: { repo_url: existing.html_url, wait_for_commits: true },
      },
    };
  }

  const created = await ensureUserRepository(token, {
    name,
    private: input.private ?? false,
    description: "VibeHub project — push your code with git",
    autoInit: false,
  });

  const cloneUrl = `https://github.com/${created.owner}/${created.name}.git`;
  const { commands, notes } = gitPushInstructions({
    repoUrl: created.html_url,
    cloneUrl,
    defaultBranch: created.default_branch || "main",
    folderHint: input.folderHint,
  });

  return {
    repo_url: created.html_url,
    clone_url: cloneUrl,
    repo_name: created.name,
    owner: created.owner,
    default_branch: created.default_branch || "main",
    private: created.private,
    github_login: user.github_login,
    git_commands: commands,
    notes,
    import_hint:
      "After git push completes, call bootstrap_via_git({ repo_url, wait_for_commits: true }) or import_project_repo.",
    mcp_url: `${publicUrl(env)}/mcp`,
    bootstrap_decision_tree: BOOTSTRAP_DECISION_TREE,
    next_tool_call: {
      tool: "bootstrap_via_git",
      args: { repo_url: created.html_url, wait_for_commits: true },
    },
  };
}

async function waitForGithubCommits(
  token: string,
  repoUrl: string,
  attempts = 30,
): Promise<{ owner: string; repo: string; branch: string; head: string }> {
  const ref = parseRepoUrl(repoUrl);
  if (!ref) throw badRequest("Invalid repo_url.");

  const client = new GitHubClient(token, ref);
  const info = await client.waitUntilReady();
  const branch = info.default_branch || "main";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const head = await client.getRefSha(`heads/${branch}`);
    if (head) return { ...ref, branch, head };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw badRequest(
    `No commits on ${ref.owner}/${ref.repo} yet. Run the git_commands from bootstrap_via_git, then call bootstrap_via_git({ repo_url: "${repoUrl}", wait_for_commits: true }).`,
  );
}

/**
 * Git-first bootstrap for agents with shell access.
 * Phase 1: repo_name → create empty repo + git_commands.
 * Phase 2: repo_url + wait_for_commits → poll for push, import, return vibehub_config.
 */
export async function bootstrapViaGit(
  env: AppEnv,
  repo: Repo,
  userId: string,
  input: {
    repo_name?: string;
    repo_url?: string;
    private?: boolean;
    folder_path?: string;
    project_name?: string;
    wait_for_commits?: boolean;
    tasks?: TaskSyncInput[];
  },
) {
  const repoUrl = input.repo_url?.trim();

  if (repoUrl && input.wait_for_commits) {
    const { token } = await requireUserGithubToken(env, repo, userId);
    await waitForGithubCommits(token, repoUrl);

    const imported = await importProjectRepo(env, repo, userId, {
      repoUrl,
      projectName: input.project_name,
    });
    const taskResult = await applyAgentTasks(repo, imported.project_id, userId, input.tasks);
    const userTokens = await repo.listApiTokens(userId);
    const mcp = await ensureMcpToken(env, repo, userId);

    return {
      ...pushToVibehubResponse(env, imported, mcp, userTokens.length > 0 || Boolean(mcp.token)),
      ...taskResult,
      status: "imported" as const,
      message: `Imported ${repoUrl} into VibeHub. Save project_config to .vibehub/project.json locally.`,
    };
  }

  const repoName = input.repo_name?.trim();
  if (!repoName) {
    throw badRequest(
      `Pass repo_name to create a GitHub repo, or repo_url + wait_for_commits after git push.\n\n${BOOTSTRAP_DECISION_TREE}`,
    );
  }

  const prepared = await prepareGitPushRepo(env, repo, userId, {
    repoName,
    private: input.private,
    folderHint: input.folder_path,
  });

  return {
    ...prepared,
    status: "awaiting_git_push" as const,
    message: prepared.already_exists
      ? `Repo ${prepared.repo_url} already exists. Run git_commands locally, then bootstrap_via_git({ repo_url: "${prepared.repo_url}", wait_for_commits: true }).`
      : `Created empty repo ${prepared.repo_url}. Run git_commands locally, then bootstrap_via_git({ repo_url: "${prepared.repo_url}", wait_for_commits: true }).`,
    next_tool_call: {
      tool: "bootstrap_via_git",
      args: {
        repo_url: prepared.repo_url,
        wait_for_commits: true,
        project_name: input.project_name,
      },
    },
    bootstrap_decision_tree: BOOTSTRAP_DECISION_TREE,
  };
}

export async function importProjectRepo(
  env: AppEnv,
  repo: Repo,
  userId: string,
  input: { repoUrl: string; projectName?: string; testMode?: TestMode },
) {
  const { token } = await requireUserGithubToken(env, repo, userId);
  const result = await importExistingRepo(env, repo, {
    repoUrl: input.repoUrl,
    githubToken: token,
    userId,
    projectName: input.projectName,
    testMode: input.testMode ?? "skip",
  });

  return {
    ...result,
    repo_url: input.repoUrl,
    project_url: `${publicUrl(env)}/projects/${result.project_id}`,
    mcp_url: `${publicUrl(env)}/mcp`,
    ...bootstrapConfigExtras(env, {
      projectId: result.project_id,
      projectUrl: `${publicUrl(env)}/projects/${result.project_id}`,
      repoUrl: input.repoUrl,
    }),
    agent_guide: agentBootstrapGuide({
      env,
      projectId: result.project_id,
      projectName: result.name,
      repoUrl: input.repoUrl,
      featureCount: result.feature_count,
      refinePrompt: result.refine_prompt,
      mcpUrl: `${publicUrl(env)}/mcp`,
    }),
  };
}

export async function bootstrapProjectFromCode(
  env: AppEnv,
  repo: Repo,
  userId: string,
  input: {
    repoName: string;
    private?: boolean;
    projectName?: string;
    testMode?: TestMode;
    files: UploadFileInput[];
    existingRepoUrl?: string;
  },
) {
  const { token } = await requireUserGithubToken(env, repo, userId);
  const pushed = await pushLocalCodeToGithub({
    repoName: input.repoName,
    private: input.private,
    githubToken: token,
    files: input.files,
    existingRepoUrl: input.existingRepoUrl,
    cleanupDb: repo,
  });

  const imported = await importProjectRepo(env, repo, userId, {
    repoUrl: pushed.repo_url,
    projectName: input.projectName,
    testMode: input.testMode,
  });

  return {
    ...imported,
    repo_url: pushed.repo_url,
    files_pushed: pushed.file_count,
    reused_repo: pushed.reused_repo,
  };
}
