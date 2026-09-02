/**
 * VibeHub's remote MCP server. Every tool is a thin wrapper over the same
 * service functions the web API uses, so behaviour cannot drift between the two
 * surfaces. No tool calls a model.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

import { Repo } from "../db/repo.js";
import { HttpError, errorMessage } from "../lib/errors.js";
import { requireMembership, requireLiveMembership, resolveMemberId } from "../services/access.js";
import { requireFeature, startFeatureWork, syncProjectTasks } from "../services/features.js";
import { toPublicStatus } from "../domain/task-status.js";
import {
  getMyTask,
  getProjectContext,
  listHistory,
  pullCode,
  pullDiff,
  pullSnapshot,
  requireProject,
  revertToVersion,
  saveSnapshot,
  syncProjectWithGithub,
} from "../services/projects.js";
import { getPushStatus, pushCode, reviewPush } from "../services/push.js";
import { assertPushAllowed, recordContextRead, recordPushRefusal } from "../services/push-gate.js";
import {
  beginUpload,
  collectUpload,
  discardUpload,
  getUploadStatus,
  uploadChunk,
  CHUNK_LIMIT_BYTES,
} from "../services/uploads.js";
import type { ChangedFile } from "../domain/conflicts.js";
import {
  bootstrapProjectFromCode,
  bootstrapViaGit,
  importProjectRepo,
  prepareGitPushRepo,
  pushToVibehub,
} from "../services/bootstrap.js";
import type { AppEnv, McpProps } from "../types.js";

const BootstrapFileSchema = z.object({
  path: z.string().describe("Repo-relative path, e.g. src/index.ts"),
  content: z.string().describe("Full file content (utf-8 text)."),
});

const TaskSyncSchema = z.object({
  title: z
    .string()
    .describe('Human-readable action, e.g. "Add checkout flow" or "Fix mobile navigation". Never a folder or file name.'),
  description: z.string().optional(),
  depends_on: z
    .array(z.string())
    .optional()
    .describe("Slugs of tasks that must finish first."),
});

const ChangedFileSchema = z.object({
  path: z.string().describe("Repo-relative path, e.g. src/features/checkout/index.ts"),
  action: z.enum(["add", "modify", "delete"]),
  content: z
    .string()
    .describe(
      'Full utf-8 source text — always plain text, never base64. Pass "" when action is delete. Files over ~48KB should go through begin_upload/upload_file instead.',
    ),
  content_sha256: z
    .string()
    .optional()
    .describe("Optional SHA-256 hex of the utf-8 content, checked server-side."),
});

/**
 * The confirmation flags are attestations, so their meaning has to travel with
 * the schema — an agent that only reads the advertised tool definition must
 * still know that flipping them after a failed call is the wrong move.
 */
const NEVER_RETRY_NOTE =
  "If a push fails because the confirm flags are missing or false, do NOT retry with true. " +
  "Ask the user for permission and re-sync to the latest version first; only then set the flags.";

const ConfirmUserApprovedSchema = z
  .boolean()
  .describe(
    "REQUIRED attestation. Set true ONLY after you asked the user in chat for explicit permission to push THIS feature now, and they said yes in this conversation. " +
      'Do NOT infer approval from "finish my tasks", "implement X", "you\'re done", or similar — implementing a task is not permission to push. ' +
      "If you have not asked yet: STOP, ask, wait for the reply, then push. " +
      NEVER_RETRY_NOTE,
  );

const ConfirmBuiltOnLatestSchema = z
  .boolean()
  .describe(
    "REQUIRED attestation. Set true ONLY after you: (1) called get_project_context and noted current_version, " +
      "(2) pull_snapshot at that version for every path you changed, " +
      "(3) compared your local files to that snapshot and merged any upstream drift, " +
      "(4) set based_on_version to that same current_version. " +
      "If any step is incomplete, STOP and do it first. " +
      NEVER_RETRY_NOTE,
  );

const ApprovalQuoteSchema = z
  .string()
  .describe(
    "REQUIRED. The user's own words granting permission for this push, copied verbatim from this conversation " +
      '(e.g. "yes, push it"). It is stored on the push and shown to the team, so it must be a real message — ' +
      'not "true", not your own paraphrase. If you have no such message, you do not have permission yet: go ask.',
  );

const ManifestSchema = z
  .object({
    routes: z.array(z.unknown()).optional(),
    exports: z.array(z.unknown()).optional(),
    deps: z.array(z.unknown()).optional(),
  })
  .describe(
    "What this feature exposes. Entries may be strings ('/checkout', 'CheckoutButton', 'stripe@^14') or objects.",
  );

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message =
    error instanceof HttpError && error.details
      ? `${error.message}\n${JSON.stringify(error.details, null, 2)}`
      : errorMessage(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function guard(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await work());
  } catch (error) {
    return fail(error);
  }
}

/** House rules surfaced to every connecting agent. */
const INSTRUCTIONS = [
  "VibeHub coordinates parallel work. Your MCP Bearer token (vh_…) identifies YOU as a VibeHub user.",
  "Versions live in VibeHub (current_version). Git remotes are NOT the source of truth for versioning or verify.",
  "",
  "=== ONE LOOP TO SHIP CODE (do this; nothing else) ===",
  "1. get_project_context(project_id) → note current_version",
  "2. get_my_task(project_id) → pick a task assigned to you",
  "3. pull_snapshot(project_id, version=current_version) → read SoT files if needed",
  "4. Edit locally, then list EVERY path the feature touches — markup AND stylesheets AND assets.",
  "5. begin_upload({ project_id, feature_id, files:[{path, action, bytes, content?}] }) with that FULL list.",
  `   Inline content for files under ~${CHUNK_LIMIT_BYTES} bytes; omit content for bigger ones.`,
  "   bytes is the exact size of your LOCAL file. The upload must match it, so a truncated or",
  "   stand-in body cannot merge. This is your `git add`.",
  `6. upload_file for each large file, split into parts of ~${CHUNK_LIMIT_BYTES} bytes (part_index/part_count).`,
  "   Never skip a file because it is large — that is what chunking is for.",
  "6b. review_push(upload_id) — your `git status`. It shows bytes on main vs bytes in your push and",
  "   flags truncated bodies and imports pointing at files you did not send. Fix warnings before step 7.",
  "7. HARD STOP before pushing. Do A, B, then C — in that order:",
  '   A. Ask the user, in chat: "Ready to push <feature title> to VibeHub?" Wait for an explicit yes.',
  "      Implementing or finishing a task is NOT permission to push. Neither is \"finish my tasks for me\".",
  "      Requests like \"finish my tasks\" mean: build the work, then come back and ask before pushing.",
  "   B. Re-run get_project_context. If current_version moved, pull_snapshot again and reconcile your files.",
  "   C. Only then push, with confirm_user_approved, confirm_built_on_latest, and the user's",
  "      verbatim words in user_approval_quote.",
  "   D. If a push is refused because those flags are missing or false, that means you skipped A or B.",
  "      Go do A and B. Do NOT flip the booleans and retry — the server records the refusal and will",
  "      reject the retry until a fresh get_project_context read follows it.",
  "8. push_code({ project_id, feature_id, upload_id, based_on_version, confirm_user_approved, confirm_built_on_latest, user_approval_quote })",
  "9. get_push_status(push_id) until merged / conflict / failed — then STOP.",
  "10. Optional verify: pull_snapshot at the new version. Do NOT git fetch / git pull to verify.",
  "",
  "=== PUSH GATE (server-enforced, no way around it) ===",
  "The confirm_* fields are attestations about what you actually did, not schema checkboxes:",
  "  confirm_user_approved   — you asked in chat and the user said yes, in this conversation.",
  "  confirm_built_on_latest — you read current_version, diffed your files against that snapshot,",
  "                            reconciled drift, and set based_on_version to it.",
  "  user_approval_quote     — the user's own words, stored on the push and shown to the team.",
  "The server independently verifies: the version really is current, you really read the project at",
  "that version, and that read came after any previous refusal. Attesting without doing the work fails.",
  "The server also rejects a push whose relative imports point at files you did not send —",
  "  ship the stylesheet with the markup, in the same push.",
  "",
  "=== NEVER ===",
  "- Never send a stand-in body (PLACEHOLDER, TODO, ..., \"see /tmp/…\") meaning to swap in the real",
  "  content later. Paste the real text, or chunk it with upload_file. This is rejected on arrival.",
  "- Never stage file contents into /tmp or a shell script and reference them. The tool arguments ARE",
  "  the transport; content that is not in the call does not exist to VibeHub.",
  "- Never treat implementing/finishing a task as permission to push. Push only after an explicit yes",
  "  to a push confirmation question in this chat.",
  "- Never set a confirm_* flag true to get past a validation error. Go do the step it names.",
  "- Never use git, gh, curl, or a hand-rolled JSON-RPC client against this MCP, and never read the",
  "  user's token from ~/.cursor/mcp.json or anywhere else. Everything you need is a tool here:",
  "  wrong content shipped → push to the same feature_id again (a Done task reopens on push);",
  "  need to undo → list_history + go_back; branch moved outside VibeHub → sync_with_github.",
  "- Never use git remotes (git push/pull/fetch) to version, verify, or recover a VibeHub project.",
  "- Never call sync_project_tasks as deploy recovery, conflict recovery, or because a push failed.",
  "- Never invent or recreate tasks after a bad push — push the missing files to the same feature.",
  "- Never base64 anything. All file content is plain utf-8 text.",
  "- Never omit a file because the payload feels big — use begin_upload + upload_file chunks.",
  "- Never create tasks unless the user EXPLICITLY asked you to create/update the task list.",
  "",
  "=== TASKS ===",
  "Statuses: Assigned → Working (auto on push, or start_task) → Done (on merge).",
  "sync_project_tasks requires user_explicitly_requested=true AND an explicit user ask.",
  "It preserves assignees on matching titles. Prefer the project UI to add tasks.",
  "push_to_vibehub / bootstrap MUST NOT invent tasks — omit tasks[] unless the user asked.",
  "",
  "=== FILES ===",
  "Everything reaches GitHub through this MCP; VibeHub makes the commit. You never commit yourself.",
  "upload_status(upload_id) shows which declared files are still missing.",
  "push responses list content_digests — confirm every path you meant to ship is there.",
  "On conflict: pull_diff or pull_snapshot for tip content, re-merge locally, push once more.",
  "",
  "First-time project only (not day-to-day pushes):",
  "  Already on GitHub → push_to_vibehub({ repo_url }) without tasks[]",
  "  Shell bootstrap → bootstrap_via_git",
  "  No shell → push_to_vibehub({ files[] }) without tasks[]",
  "",
  "Auth: MCP Authorization Bearer vh_…  |  Save project_config to .vibehub/project.json; never commit .vibehub/",
  "Scope: only write inside feature scope_notes; never hand-edit src/generated/** or package.json",
].join("\n");

export class VibeHubMCP extends McpAgent<AppEnv, never, McpProps> {
  server = new McpServer({ name: "vibehub", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  private repo(): Repo {
    return new Repo(this.env.DB);
  }

  private get userId(): string {
    const userId = this.props?.userId;
    if (!userId) throw new HttpError(401, "This MCP session is not authenticated.");
    return userId;
  }

  /** Runs stage A of a push outside the tool's response path. */
  private runInBackground = (work: Promise<unknown>): void => {
    const state = this.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void };
    if (typeof state.waitUntil === "function") state.waitUntil(work);
    else void work;
  };

  /**
   * Notes that this agent has seen the project's live version. The push gate
   * requires such a read, taken after any previous refusal.
   */
  private async noteContextRead(projectId: string): Promise<void> {
    const project = await this.repo().getProject(projectId);
    if (!project) return;
    await recordContextRead(this.env, this.userId, projectId, project.current_version);
  }

  /** The one path that lands code: gate first, then push. */
  private async shipFeature(
    repo: Repo,
    input: {
      project_id: string;
      feature_id: string;
      based_on_version: number;
      confirm_user_approved: boolean;
      confirm_built_on_latest: boolean;
      user_approval_quote: string;
      upload_id?: string;
      changed_files?: ChangedFile[];
      manifest?: unknown;
      notes?: string;
      allow_large_deletions?: boolean;
    },
  ): Promise<unknown> {
    await requireLiveMembership(this.env, repo, input.project_id, this.userId);
    const feature = await requireFeature(repo, input.project_id, input.feature_id);
    const project = await requireProject(repo, input.project_id);

    await assertPushAllowed(this.env, {
      userId: this.userId,
      projectId: input.project_id,
      featureId: feature.slug,
      featureTitle: feature.title,
      currentVersion: project.current_version,
      basedOnVersion: input.based_on_version,
      confirmUserApproved: input.confirm_user_approved,
      confirmBuiltOnLatest: input.confirm_built_on_latest,
      approvalQuote: input.user_approval_quote,
    });

    const changedFiles = await this.resolvePushFiles({ ...input, feature_id: feature.slug });
    const approval = `Approved by user: "${input.user_approval_quote.trim()}"`;
    const notes = input.notes?.trim() ? `${input.notes.trim()}\n\n${approval}` : approval;

    try {
      const result = await pushCode(
        this.env,
        repo,
        {
          projectId: input.project_id,
          featureIdOrSlug: feature.slug,
          changedFiles,
          basedOnVersion: input.based_on_version,
          userApproved: input.confirm_user_approved,
          confirmedLatestVersion: input.confirm_built_on_latest,
          manifest: input.manifest,
          notes,
          userId: this.userId,
          allowLargeDeletions: input.allow_large_deletions === true,
        },
        this.runInBackground,
      );
      if (input.upload_id) this.runInBackground(discardUpload(this.env, input.upload_id));
      return result;
    } catch (error) {
      // A rejected push means the next attempt has to re-sync, not just retry.
      await recordPushRefusal(
        this.env,
        this.userId,
        input.project_id,
        feature.slug,
        "resync_required",
      );
      throw error;
    }
  }

  /** Staged upload plus any inline files, as one file list. */
  private async resolvePushFiles(input: {
    upload_id?: string;
    changed_files?: ChangedFile[];
    feature_id: string;
  }): Promise<ChangedFile[]> {
    const inline = input.changed_files ?? [];
    if (!input.upload_id) {
      if (inline.length === 0) {
        throw new HttpError(
          400,
          "Nothing to push. Declare the feature's files with begin_upload and pass upload_id, or pass changed_files for a small push.",
        );
      }
      return inline;
    }

    const staged = await collectUpload(this.env, input.upload_id, this.userId);
    if (staged.featureIdOrSlug !== input.feature_id) {
      throw new HttpError(
        400,
        `Upload ${input.upload_id} was opened for feature "${staged.featureIdOrSlug}", not "${input.feature_id}".`,
      );
    }

    const byPath = new Map(staged.files.map((file) => [file.path, file]));
    for (const file of inline) {
      if (byPath.has(file.path)) {
        throw new HttpError(
          400,
          `"${file.path}" was sent both in the upload and in changed_files. Send it once.`,
        );
      }
      byPath.set(file.path, file);
    }
    return [...byPath.values()];
  }

  override async init(): Promise<void> {
    const repo = this.repo();

    this.server.registerTool(
      "get_project_context",
      {
        description:
          "Requirements, current version, the full feature list with statuses and dependencies, the generated shared wiring, and recent version history.",
        inputSchema: { project_id: z.string() },
      },
      async ({ project_id }) =>
        guard(async () => {
          await requireLiveMembership(this.env, repo, project_id, this.userId);
          const context = await getProjectContext(this.env, repo, project_id);
          await recordContextRead(this.env, this.userId, project_id, context.project.current_version);
          return context;
        }),
    );

    this.server.registerTool(
      "get_my_task",
      {
        description:
          "Tasks available to the authenticated user: assigned open tasks (Assigned/Working), plus any still-unassigned legacy tasks. Call start_task before coding.",
        inputSchema: {
          project_id: z.string(),
          user_id: z
            .string()
            .optional()
            .describe("Defaults to the authenticated user. Accepts a VibeHub user id or GitHub login."),
        },
      },
      async ({ project_id, user_id }) =>
        guard(async () => {
          await requireMembership(repo, project_id, this.userId);
          const target = user_id
            ? (await resolveMemberId(repo, project_id, user_id)) ?? this.userId
            : this.userId;
          return getMyTask(repo, project_id, target);
        }),
    );

    this.server.registerTool(
      "start_task",
      {
        description:
          "Mark a task Working when you start coding it. The task must be assigned to you (or still unassigned — then it is claimed for you).",
        inputSchema: {
          project_id: z.string(),
          feature_id: z.string().describe("Feature slug or id from get_my_task / get_project_context."),
        },
      },
      async ({ project_id, feature_id }) =>
        guard(async () => {
          await requireMembership(repo, project_id, this.userId);
          const feature = await startFeatureWork(repo, project_id, feature_id, this.userId);
          return {
            id: feature.slug,
            title: feature.title,
            status: toPublicStatus(feature.status),
            assigned_to: feature.assigned_to,
            message: `Task "${feature.title}" is now Working.`,
          };
        }),
    );

    this.server.registerTool(
      "pull_snapshot",
      {
        description:
          "Lower-level read of a specific version. Prefer pull_code for day-to-day work — it syncs with GitHub first.",
        inputSchema: {
          project_id: z.string(),
          version: z.number().int().nonnegative().optional(),
          paths: z.array(z.string()).optional().describe("Limit the response to these paths."),
        },
      },
      async ({ project_id, version, paths }) =>
        guard(async () => {
          await requireLiveMembership(this.env, repo, project_id, this.userId);
          const snapshot = await pullSnapshot(this.env, repo, project_id, { version, paths });
          // Only a read of the live version counts towards the push gate.
          if (version === undefined) await this.noteContextRead(project_id);
          return snapshot;
        }),
    );

    this.server.registerTool(
      "pull_code",
      {
        description:
          "Get full project files (syncs with GitHub first). Prefer pull_diff when catching up before a push — diffs are smaller.",
        inputSchema: {
          project_id: z.string(),
          paths: z.array(z.string()).optional().describe("Optional: only these paths."),
        },
      },
      async ({ project_id, paths }) =>
        guard(async () => {
          await requireLiveMembership(this.env, repo, project_id, this.userId);
          const code = await pullCode(this.env, repo, project_id, { paths });
          await this.noteContextRead(project_id);
          return code;
        }),
    );

    this.server.registerTool(
      "pull_diff",
      {
        description:
          "Line diffs from based_on_version → current main. Use this to catch up before push_code — apply patches locally instead of re-downloading whole files.",
        inputSchema: {
          project_id: z.string(),
          based_on_version: z
            .number()
            .int()
            .nonnegative()
            .describe("The VibeHub version your local code was based on."),
        },
      },
      async ({ project_id, based_on_version }) =>
        guard(async () => {
          await requireLiveMembership(this.env, repo, project_id, this.userId);
          return pullDiff(this.env, repo, project_id, based_on_version);
        }),
    );

    this.server.registerTool(
      "list_history",
      {
        description:
          "List saved versions so you can go_back to an earlier one. Safe — nothing is deleted.",
        inputSchema: { project_id: z.string() },
      },
      async ({ project_id }) =>
        guard(async () => {
          await requireLiveMembership(this.env, repo, project_id, this.userId);
          return listHistory(repo, project_id);
        }),
    );

    this.server.registerTool(
      "go_back",
      {
        description:
          "Restore the project to how it looked at an earlier version. Creates a new version — history is kept. Use list_history to pick the version number.",
        inputSchema: {
          project_id: z.string(),
          version: z.number().int().nonnegative().describe("Version number from list_history."),
        },
      },
      async ({ project_id, version }) =>
        guard(async () => {
          await requireLiveMembership(this.env, repo, project_id, this.userId);
          return revertToVersion(this.env, repo, project_id, version);
        }),
    );

    this.server.registerTool(
      "sync_with_github",
      {
        description:
          "Record the current GitHub tip as the latest VibeHub version when the branch moved outside VibeHub (e.g. after a manual git push).",
        inputSchema: { project_id: z.string() },
      },
      async ({ project_id }) =>
        guard(async () => {
          await requireLiveMembership(this.env, repo, project_id, this.userId);
          const synced = await syncProjectWithGithub(this.env, repo, project_id);
          await this.noteContextRead(project_id);
          return synced;
        }),
    );

    this.server.registerTool(
      "begin_upload",
      {
        description:
          "Start a push by declaring EVERY file the feature touches. Small files can carry content here; large ones (>48KB) are sent with upload_file in chunks. The push is refused until every declared path has arrived, so nothing gets silently dropped.",
        inputSchema: {
          project_id: z.string(),
          feature_id: z.string().describe("Task/feature id, e.g. 'add-calendar-view'."),
          files: z
            .array(
              z.object({
                path: z.string().describe("Repo-relative path, e.g. src/App.css"),
                action: z
                  .enum(["add", "modify", "delete"])
                  .default("modify")
                  .describe("Defaults to modify."),
                bytes: z
                  .number()
                  .int()
                  .nonnegative()
                  .optional()
                  .describe(
                    "REQUIRED unless action is delete or content is inlined here: the exact utf-8 byte size of your LOCAL file. " +
                      "The assembled upload must match it, so a truncated or stand-in body cannot merge.",
                  ),
                sha256: z
                  .string()
                  .optional()
                  .describe("Optional sha256 hex of the local file, checked after reassembly."),
                content: z
                  .string()
                  .optional()
                  .describe(
                    `Full utf-8 text. Include it here when the file is under ~${CHUNK_LIMIT_BYTES} bytes; otherwise omit and send it with upload_file. ` +
                      "Never send a stand-in like PLACEHOLDER meaning to swap it in later — that is rejected.",
                  ),
              }),
            )
            .min(1)
            .describe("The complete file list for this feature — every path, including stylesheets."),
        },
      },
      async (input) =>
        guard(async () => {
          await requireLiveMembership(this.env, repo, input.project_id, this.userId);
          return beginUpload(this.env, {
            projectId: input.project_id,
            featureIdOrSlug: input.feature_id,
            userId: this.userId,
            files: input.files,
          });
        }),
    );

    this.server.registerTool(
      "review_push",
      {
        description:
          "The `git status` of a VibeHub push: what each staged file would do to main (bytes on main vs bytes in your push) " +
          "and any problem that will stop the merge — truncated bodies, imports pointing at files you did not send. " +
          "Read-only. Run it after staging and before asking the user for permission.",
        inputSchema: {
          project_id: z.string(),
          upload_id: z.string().optional().describe("From begin_upload."),
          changed_files: z
            .array(ChangedFileSchema)
            .optional()
            .describe("Inline alternative to upload_id."),
          feature_id: z.string().describe("Task/feature id the files belong to."),
        },
      },
      async (input) =>
        guard(async () => {
          await requireLiveMembership(this.env, repo, input.project_id, this.userId);
          const feature = await requireFeature(repo, input.project_id, input.feature_id);
          const files = await this.resolvePushFiles({ ...input, feature_id: feature.slug });
          return reviewPush(this.env, repo, input.project_id, files);
        }),
    );

    this.server.registerTool(
      "upload_file",
      {
        description:
          `Send one declared file, in one call or split into parts of ~${CHUNK_LIMIT_BYTES} bytes. Always plain utf-8 text — never base64. Parts may arrive in any order.`,
        inputSchema: {
          upload_id: z.string().describe("From begin_upload."),
          path: z.string().describe("Must be one of the paths declared in begin_upload."),
          content: z.string().describe("Utf-8 text for this part (or the whole file)."),
          part_index: z
            .number()
            .int()
            .nonnegative()
            .default(0)
            .describe("0-based index of this part. Omit for single-part files."),
          part_count: z
            .number()
            .int()
            .positive()
            .default(1)
            .describe("Total number of parts for this file. Omit for single-part files."),
        },
      },
      async (input) =>
        guard(async () =>
          uploadChunk(this.env, {
            uploadId: input.upload_id,
            userId: this.userId,
            path: input.path,
            content: input.content,
            partIndex: input.part_index,
            partCount: input.part_count,
          }),
        ),
    );

    this.server.registerTool(
      "upload_status",
      {
        description: "Which declared files have fully arrived and which are still missing.",
        inputSchema: { upload_id: z.string() },
      },
      async ({ upload_id }) => guard(async () => getUploadStatus(this.env, upload_id)),
    );

    this.server.registerTool(
      "push_code",
      {
        description:
          "Ship a feature. BEFORE CALLING: (1) ask the user in chat for explicit permission to push this feature now and wait for their yes, " +
          "(2) re-check your changed files against pull_snapshot at current_version. The confirm_* flags attest that those two steps happened; " +
          "setting them true without doing the steps is invalid and the server will catch it. " +
          NEVER_RETRY_NOTE,
        inputSchema: {
          project_id: z.string(),
          feature_id: z.string().describe("Task/feature id, e.g. 'add-calendar-view'."),
          based_on_version: z
            .number()
            .int()
            .nonnegative()
            .describe("Must equal current_version from get_project_context."),
          confirm_user_approved: ConfirmUserApprovedSchema,
          confirm_built_on_latest: ConfirmBuiltOnLatestSchema,
          user_approval_quote: ApprovalQuoteSchema,
          upload_id: z
            .string()
            .optional()
            .describe("From begin_upload. Preferred — it carries files of any size."),
          changed_files: z
            .array(ChangedFileSchema)
            .optional()
            .describe("Inline alternative to upload_id, for small pushes. Every file, utf-8."),
          allow_large_deletions: z
            .boolean()
            .optional()
            .describe(
              "Only set true when you deliberately mean to gut a file. By default a push that replaces most of an existing file is refused, because that is what a truncated paste looks like.",
            ),
          manifest: ManifestSchema.optional(),
          notes: z.string().optional(),
        },
      },
      async (input) => guard(async () => this.shipFeature(repo, input)),
    );

    this.server.registerTool(
      "push_feature",
      {
        description:
          "Same gate as push_code — kept for older clients. BEFORE CALLING: ask the user for explicit permission to push this feature now, " +
          "then re-check your changed files against pull_snapshot at current_version. The confirm_* flags attest those steps. " +
          NEVER_RETRY_NOTE,
        inputSchema: {
          project_id: z.string(),
          feature_id: z.string().describe("The feature id, e.g. 'checkout'."),
          based_on_version: z
            .number()
            .int()
            .nonnegative()
            .describe("Must equal current_version from get_project_context."),
          confirm_user_approved: ConfirmUserApprovedSchema,
          confirm_built_on_latest: ConfirmBuiltOnLatestSchema,
          user_approval_quote: ApprovalQuoteSchema,
          upload_id: z.string().optional().describe("From begin_upload. Preferred for large files."),
          changed_files: z.array(ChangedFileSchema).optional(),
          allow_large_deletions: z
            .boolean()
            .optional()
            .describe("Only set true when you deliberately mean to gut a file."),
          manifest: ManifestSchema.optional(),
          notes: z.string().optional(),
        },
      },
      async (input) => guard(async () => this.shipFeature(repo, input)),
    );

    this.server.registerTool(
      "get_push_status",
      {
        description:
          "Poll a push. On 'conflict' it returns the current content of only the overlapping files so you can re-merge narrowly.",
        inputSchema: { push_id: z.string() },
      },
      async ({ push_id }) =>
        guard(async () => {
          const push = await repo.getPush(push_id);
          if (!push) throw new HttpError(404, `No push ${push_id}.`);
          await requireMembership(repo, push.project_id, this.userId);
          return getPushStatus(this.env, repo, push_id);
        }),
    );

    this.server.registerTool(
      "report_blocker",
      {
        description:
          "Flag a feature for human attention and record the reason. Does not change Assigned/Working/Done status.",
        inputSchema: {
          project_id: z.string(),
          feature_id: z.string(),
          reason: z.string().min(1),
        },
      },
      async ({ project_id, feature_id, reason }) =>
        guard(async () => {
          await requireMembership(repo, project_id, this.userId);
          const feature = await requireFeature(repo, project_id, feature_id);
          const blocker = await repo.createBlocker({
            projectId: project_id,
            featureId: feature.id,
            reason,
            reportedBy: this.userId,
          });
          return {
            blocker_id: blocker.id,
            feature_id: feature.slug,
            status: toPublicStatus(feature.status),
            flagged_for_human_attention: true,
          };
        }),
    );

    this.server.registerTool(
      "save_snapshot",
      {
        description:
          "Park unmerged work on a side branch without touching the source of truth. Does not create a version and does not run the build gate.",
        inputSchema: {
          project_id: z.string(),
          feature_id: z.string().optional(),
          description: z.string().default(""),
          based_on_version: z.number().int().nonnegative().optional(),
          changed_files: z.array(ChangedFileSchema).min(1),
        },
      },
      async (input) =>
        guard(async () => {
          await requireMembership(repo, input.project_id, this.userId);
          return saveSnapshot(this.env, repo, input.project_id, {
            featureIdOrSlug: input.feature_id ?? null,
            description: input.description ?? "",
            basedOnVersion: input.based_on_version,
            changedFiles: input.changed_files,
            userId: this.userId,
          });
        }),
    );

    this.server.registerTool(
      "push_to_vibehub",
      {
        description:
          "Bootstrap when code is already on GitHub (repo_url) or file upload is required (no shell). Prefer bootstrap_via_git when the agent has shell access. Returns project_config for .vibehub/project.json.",
        inputSchema: {
          project_id: z
            .string()
            .optional()
            .describe("Existing VibeHub project. Reuses its GitHub repo instead of creating a new one."),
          repo_name: z
            .string()
            .optional()
            .describe(
              "GitHub repo name. Defaults to package.json name. Use the SAME name on every retry — never invent new names.",
            ),
          project_name: z.string().optional().describe("Display name in VibeHub."),
          private: z.boolean().optional(),
          repo_url: z
            .string()
            .optional()
            .describe("Existing GitHub repo URL. With files[], uploads there; alone, imports only."),
          files: z
            .array(BootstrapFileSchema)
            .optional()
            .describe("Project source files. Skips lockfiles, node_modules, dist. Prefer bootstrap_via_git when shell is available."),
          tasks: z
            .array(TaskSyncSchema)
            .optional()
            .describe(
              "IGNORED unless create_tasks=true. Do not pass tasks when shipping code — only when the user explicitly asked to create a task list.",
            ),
          create_tasks: z
            .boolean()
            .optional()
            .describe(
              "Set true ONLY when the user explicitly asked you to create/update tasks. Default false — never invent tasks on bootstrap/push.",
            ),
        },
      },
      async (input) =>
        guard(async () =>
          pushToVibehub(this.env, repo, this.userId, {
            projectId: input.project_id,
            repoName: input.repo_name,
            projectName: input.project_name,
            private: input.private,
            repoUrl: input.repo_url,
            files: input.files,
            tasks:
              input.create_tasks === true
                ? input.tasks?.map((task) => ({
                    title: task.title,
                    description: task.description,
                    dependsOn: task.depends_on,
                  }))
                : undefined,
          }),
        ),
    );

    this.server.registerTool(
      "sync_project_tasks",
      {
        description:
          "ONLY when the user explicitly asked to create or rewrite the task list. Never use for deploy recovery, push failures, or conflicts. Preserves assignees on matching titles. Prefer the project UI.",
        inputSchema: {
          project_id: z.string().describe("VibeHub project id."),
          user_explicitly_requested: z
            .boolean()
            .describe(
              "REQUIRED and must be true. Confirms the human explicitly asked you to create or rewrite tasks.",
            ),
          tasks: z
            .array(TaskSyncSchema)
            .describe(
              "Action-oriented tasks, e.g. \"Fix auth redirect\". Empty array = no change. Matching titles keep their assignees.",
            ),
        },
      },
      async (input) =>
        guard(async () => {
          if (input.user_explicitly_requested !== true) {
            throw new HttpError(
              400,
              "sync_project_tasks refused: set user_explicitly_requested=true only when the user asked you to create/update tasks. Never call this to recover a failed push.",
            );
          }
          await requireMembership(repo, input.project_id, this.userId);
          const result = await syncProjectTasks(
            repo,
            input.project_id,
            input.tasks.map((task) => ({
              title: task.title,
              description: task.description,
              dependsOn: task.depends_on,
            })),
            this.userId,
          );
          return {
            ...result,
            message: result.skipped
              ? "No tasks updated — the task list was left unchanged."
              : `Updated tasks: ${result.created} created, ${result.updated} updated, ${result.deleted} removed (assignees preserved on matches).`,
          };
        }),
    );

    this.server.registerTool(
      "bootstrap_via_git",
      {
        description:
          "Preferred first push for agents with shell access. Phase 1: repo_name → empty GitHub repo + git_commands. Phase 2: after git push, call with repo_url + wait_for_commits:true → imports and returns project_config.",
        inputSchema: {
          repo_name: z
            .string()
            .optional()
            .describe("Phase 1: create or reuse this GitHub repo name."),
          repo_url: z
            .string()
            .optional()
            .describe("Phase 2: https://github.com/owner/repo after git push."),
          wait_for_commits: z
            .boolean()
            .optional()
            .describe("Phase 2: poll GitHub until main has commits, then import into VibeHub."),
          private: z.boolean().optional(),
          folder_path: z.string().optional().describe("Local path for the cd command."),
          project_name: z.string().optional(),
          tasks: z
            .array(TaskSyncSchema)
            .optional()
            .describe("IGNORED unless create_tasks=true. Never invent tasks during bootstrap."),
          create_tasks: z
            .boolean()
            .optional()
            .describe("true ONLY when the user explicitly asked to create tasks."),
        },
      },
      async (input) =>
        guard(async () =>
          bootstrapViaGit(this.env, repo, this.userId, {
            repo_name: input.repo_name,
            repo_url: input.repo_url,
            private: input.private,
            folder_path: input.folder_path,
            project_name: input.project_name,
            wait_for_commits: input.wait_for_commits,
            tasks:
              input.create_tasks === true
                ? input.tasks?.map((task) => ({
                    title: task.title,
                    description: task.description,
                    dependsOn: task.depends_on,
                  }))
                : undefined,
          }),
        ),
    );

    this.server.registerTool(
      "prepare_git_push",
      {
        description:
          "Lower-level: create empty GitHub repo and return git commands. Prefer bootstrap_via_git — it wraps this and handles import.",
        inputSchema: {
          repo_name: z.string().describe("New repository name on GitHub, e.g. my-app"),
          private: z.boolean().optional().describe("Create a private repo (requires private repo OAuth scope)."),
          folder_path: z
            .string()
            .optional()
            .describe("Local path hint for the cd command, e.g. /Users/you/project"),
        },
      },
      async ({ repo_name, private: isPrivate, folder_path }) =>
        guard(async () =>
          prepareGitPushRepo(this.env, repo, this.userId, {
            repoName: repo_name,
            private: isPrivate,
            folderHint: folder_path,
          }),
        ),
    );

    this.server.registerTool(
      "import_project_repo",
      {
        description:
          "After code is on GitHub, connect the repo to VibeHub. Does not create tasks.",
        inputSchema: {
          repo_url: z.string().describe("https://github.com/owner/repo"),
          project_name: z.string().optional(),
        },
      },
      async ({ repo_url, project_name }) =>
        guard(async () =>
          importProjectRepo(this.env, repo, this.userId, {
            repoUrl: repo_url,
            projectName: project_name,
          }),
        ),
    );

    this.server.registerTool(
      "bootstrap_project_from_code",
      {
        description:
          "Fallback when git is unavailable: create GitHub repo, upload files (skips lockfiles), import. Prefer bootstrap_via_git when the agent has shell access.",
        inputSchema: {
          repo_name: z.string(),
          private: z.boolean().optional(),
          project_name: z.string().optional(),
          files: z.array(BootstrapFileSchema).min(1),
        },
      },
      async (input) =>
        guard(async () =>
          bootstrapProjectFromCode(this.env, repo, this.userId, {
            repoName: input.repo_name,
            private: input.private,
            projectName: input.project_name,
            files: input.files,
          }),
        ),
    );
  }
}
