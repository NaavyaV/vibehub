/**
 * Copy-paste snippets and prompts for connecting agents to VibeHub.
 */

import { VIBEHUB_GITIGNORE_SNIPPET } from "../domain/upload-filter.js";

export type AgentId =
  | "cursor"
  | "claude-desktop"
  | "claude-code"
  | "codex"
  | "vscode"
  | "windsurf"
  | "antigravity"
  | "other";

export interface ProjectConfigInput {
  projectId: string;
  projectUrl: string;
  repoUrl: string | null;
  repoName: string | null;
  mcpUrl: string;
}

export interface AgentGuideInput extends ProjectConfigInput {
  hasMcpToken: boolean;
}

export interface AgentGuide {
  id: AgentId;
  name: string;
  tagline: string;
  config_path: string;
  config_label: string;
  config: string;
  cli_command: string | null;
  setup_steps: string[];
  setup_prompt: string;
}

export function buildProjectConfigJson(input: ProjectConfigInput): string {
  return `${JSON.stringify(
    {
      project_id: input.projectId,
      project_url: input.projectUrl,
      repo_name: input.repoName,
      repo_url: input.repoUrl,
      mcp_url: input.mcpUrl,
    },
    null,
    2,
  )}\n`;
}

export function buildCursorMcpConfig(mcpUrl: string, token = "vh_YOUR_TOKEN_HERE"): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        vibehub: {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function buildClaudeCodeMcpJson(mcpUrl: string, token = "${VIBEHUB_MCP_TOKEN}"): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        vibehub: {
          type: "http",
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function buildVsCodeMcpConfig(mcpUrl: string, token = "vh_YOUR_TOKEN_HERE"): string {
  return `${JSON.stringify(
    {
      servers: {
        vibehub: {
          type: "http",
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function buildWindsurfMcpConfig(mcpUrl: string, token = "vh_YOUR_TOKEN_HERE"): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        vibehub: {
          serverUrl: mcpUrl,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

/** Antigravity IDE / CLI — remote servers use serverUrl (not url). */
export function buildAntigravityMcpConfig(mcpUrl: string, token = "vh_YOUR_TOKEN_HERE"): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        vibehub: {
          serverUrl: mcpUrl,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function buildCodexMcpConfig(mcpUrl: string): string {
  return `[mcp_servers.vibehub]
url = "${mcpUrl}"
bearer_token_env_var = "VIBEHUB_MCP_TOKEN"
startup_timeout_sec = 15
`;
}

export function buildGitignoreSnippet(): string {
  return `${VIBEHUB_GITIGNORE_SNIPPET}\n`;
}

export function buildCursorRule(): string {
  return `## VibeHub push
- Read \`.vibehub/project.json\` for project_id (local — gitignored). MCP Bearer token identifies the VibeHub user.
- Versions live in VibeHub (\`current_version\`). Never use git remotes to version or verify.
- One loop: get_project_context → get_my_task → pull_snapshot → begin_upload (declare EVERY file) → upload_file for anything large → ask user to test → push_code → get_push_status → stop.
- Never sync_project_tasks unless the user explicitly asked to create tasks (and then user_explicitly_requested=true). Never invent tasks on push/bootstrap.
- Never base64 anything; all content is plain utf-8. Never skip a file for being large — chunk it with upload_file.
- Never send a stand-in body (PLACEHOLDER, "see /tmp/...") planning to swap it in later; declare each file's bytes so truncation is caught.
- Never use git, gh, curl, or a hand-rolled MCP client, and never read the VibeHub token from disk. To fix a shipped feature, push to the same feature_id again.
- Finishing a task is NOT permission to push. Ask "Ready to push <feature> to VibeHub?" and wait for an explicit yes.
- push_code requires confirm_user_approved, confirm_built_on_latest, user_approval_quote (the user's exact words), and based_on_version === current_version.
- If a push is refused for missing confirmations, ask the user and re-read get_project_context. Never retry by setting the flags true.
- First-time only: push_to_vibehub({ repo_url }) or bootstrap_via_git — omit tasks[] / create_tasks.
- Return project_url when done.
`;
}

function pushContextBlock(input: AgentGuideInput): string[] {
  const lines: string[] = [
    "## About VibeHub",
    "VibeHub is a project board for vibecoders. You push code via MCP, it lands on GitHub, and the team tracks tasks on a visual board.",
    "",
    `MCP endpoint: ${input.mcpUrl}`,
  ];

  if (input.projectId) {
    lines.push(
      `Project ID: ${input.projectId}`,
      `Project URL: ${input.projectUrl}`,
      input.repoUrl ? `GitHub repo: ${input.repoUrl}` : "",
    );
  }

  lines.push(
    "",
    "## Push this project",
    "1. Read `.vibehub/project.json` in the repo root if it exists — reuse project_id and repo_url from there.",
    input.projectId
      ? `2. Always pass project_id: ${input.projectId} on every push so VibeHub reuses the same GitHub repo.`
      : "2. After the first successful push, write `.vibehub/project.json` locally (from the response). Do not commit it.",
    "3. Never git add, commit, or push VibeHub integration files (.vibehub/, project MCP config). They are local-only.",
    "4. Push COMPLETE features only — not after every prompt. Wait until the user says they are done building or asks to push to VibeHub.",
    "5. Feature ship loop (MCP only — no git SoT): get_project_context → get_my_task → pull_snapshot → begin_upload with every path → upload_file for large files → ask user to test → push_code with both confirmations → get_push_status → stop.",
    "6. For first-time bootstrap: if `git remote -v` shows a GitHub URL and code is pushed, call push_to_vibehub with project_id + repo_url + repo_name (omit tasks / create_tasks).",
    "7. If you have shell access and no git remote: bootstrap_via_git({ repo_name }) → run git_commands → bootstrap_via_git({ repo_url, wait_for_commits: true }).",
    "8. Only if git is unavailable: push_to_vibehub with project_id + repo_name + files[] (skips lockfiles, node_modules, dist, .env*, .vibehub/, secrets).",
    "9. Use ONE repo name from package.json. Never create vibehub-app, vibehub-complete, or similar retry names.",
    "10. Do not set private:true unless the user explicitly asks.",
    "11. Never create tasks unless the user explicitly asked — never sync_project_tasks as push recovery.",
    "12. Save project_config from the response to `.vibehub/project.json` locally. Return project_url when done.",
    "",
    "## Auto-add .gitignore (do this yourself — do not ask the user)",
    "Ensure the project `.gitignore` includes the VibeHub local-integration block below. If missing, append it automatically (create `.gitignore` if needed). Do not commit VibeHub files.",
    "",
    "```gitignore",
    VIBEHUB_GITIGNORE_SNIPPET.trim(),
    "```",
  );

  return lines.filter(Boolean);
}

function mcpAuthNote(hasMcpToken: boolean): string {
  return hasMcpToken
    ? "The user already has a VibeHub MCP token. Tell them exactly where to paste it (see Where to paste the MCP key below). Use the configured Bearer token — not an old token from chat history."
    : "MCP may not be wired yet. Ask the user for their vh_… token from VibeHub Settings, then tell them exactly where to paste it (see Where to paste the MCP key below). They can also paste the token in this chat.";
}

function pasteKeyBlock(lines: string[]): string[] {
  return ["## Where to paste the MCP key", "Tell the user clearly:", ...lines.map((l) => `- ${l}`), ""];
}

export function buildAgentSetupPrompt(agentId: AgentId, input: AgentGuideInput): string {
  const tokenNote = mcpAuthNote(input.hasMcpToken);
  const push = pushContextBlock(input);
  const tokenPlaceholder = input.hasMcpToken ? "vh_PASTE_FROM_VIBEHUB_SETTINGS" : "vh_YOUR_TOKEN_HERE";

  if (agentId === "cursor") {
    return [
      "Help me connect VibeHub and push this project.",
      "",
      tokenNote,
      "",
      ...pasteKeyBlock([
        "Open `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (this repo only).",
        "In the `vibehub` server entry, find `headers.Authorization`.",
        `Replace \`${tokenPlaceholder}\` with their full \`vh_…\` token so it reads: \`Authorization: Bearer vh_…\`.`,
        "Save the file, then fully quit and reopen Cursor. Confirm vibehub is connected under MCP settings.",
      ]),
      "## Step 1 — Wire VibeHub MCP in Cursor",
      "Create or edit the MCP config file above. Paste:",
      "",
      "```json",
      buildCursorMcpConfig(input.mcpUrl, tokenPlaceholder).trim(),
      "```",
      "",
      "Then open Cursor MCP settings and confirm `vibehub` shows as connected.",
      "Use Agent mode (Ctrl/Cmd+I) when pushing — MCP tools work there.",
      "",
      "## Step 2 — Optional project rule",
      "Add a project rule (Settings → Rules, or `.cursor/rules/vibehub.mdc`) with:",
      "",
      buildCursorRule().trim(),
      "",
      ...push,
      "",
      "## If MCP is not connected yet",
      "Stop. Tell the user to create a token at VibeHub Settings, paste it into `headers.Authorization` in mcp.json (replacing the placeholder), OR paste the token in this chat.",
    ].join("\n");
  }

  if (agentId === "claude-desktop") {
    return [
      "Help me connect VibeHub and push this project using Claude Desktop.",
      "",
      tokenNote,
      "",
      ...pasteKeyBlock([
        "Claude Desktop does not put Bearer tokens in a JSON file for remote connectors.",
        "Open Claude Desktop → profile → Settings → Connectors → Add custom connector.",
        `Name: VibeHub. URL: ${input.mcpUrl}`,
        "When the app asks for authentication, paste their `vh_…` token as a Bearer token.",
        "Fully quit and reopen Claude Desktop (closing the window is not enough).",
      ]),
      "## Step 1 — Add VibeHub as a connector",
      "1. Open Claude Desktop.",
      "2. Profile → Settings → Connectors → Add custom connector.",
      `3. Name: VibeHub. URL: ${input.mcpUrl}`,
      "4. Paste the user's vh_… token as a Bearer token when prompted.",
      "5. Fully quit and reopen. Start a new chat — look for the tools/hammer icon.",
      "",
      ...push,
    ].join("\n");
  }

  if (agentId === "claude-code") {
    return [
      "Help me connect VibeHub and push this project using Claude Code.",
      "",
      tokenNote,
      "",
      ...pasteKeyBlock([
        "Option A: In the project folder, run the `claude mcp add` command and replace `TOKEN` in the Authorization header with their `vh_…` token.",
        "Option B: Edit `.mcp.json` in the project root — set `headers.Authorization` to `Bearer vh_…` (replace `${VIBEHUB_MCP_TOKEN}` / placeholder with the real token, or export `VIBEHUB_MCP_TOKEN=vh_…` first).",
        "Then start a new Claude Code session and run `/mcp` to confirm vibehub is connected.",
      ]),
      "## Step 1 — Add VibeHub MCP",
      "",
      "### Option A — One command",
      "In the project folder (replace TOKEN with the vh_… token from VibeHub Settings):",
      "",
      `\`claude mcp add --transport http --scope project --header "Authorization: Bearer TOKEN" vibehub ${input.mcpUrl}\``,
      "",
      "### Option B — Edit `.mcp.json`",
      "```json",
      buildClaudeCodeMcpJson(input.mcpUrl).trim(),
      "```",
      "",
      "Tell the user to put their token in `headers.Authorization` (or export `VIBEHUB_MCP_TOKEN=vh_…`).",
      "Start Claude Code and run `/mcp` to confirm.",
      "",
      ...push,
    ].join("\n");
  }

  if (agentId === "codex") {
    return [
      "Help me connect VibeHub and push this project using OpenAI Codex CLI.",
      "",
      tokenNote,
      "",
      ...pasteKeyBlock([
        "Export the token in the shell: `export VIBEHUB_MCP_TOKEN=vh_…` (paste the full token after `=`).",
        "Add the TOML block to `~/.codex/config.toml` or `.codex/config.toml` — Codex reads the token from that env var (`bearer_token_env_var`).",
        "Or run `codex mcp add … --bearer-token-env-var VIBEHUB_MCP_TOKEN` after exporting the env var.",
        "Confirm with `codex mcp list` and `/mcp` in a session.",
      ]),
      "## Step 1 — Add VibeHub MCP to Codex (TOML)",
      "",
      "1. `export VIBEHUB_MCP_TOKEN=vh_…` (token from VibeHub Settings).",
      "2. Edit `~/.codex/config.toml` OR `.codex/config.toml` and add:",
      "",
      "```toml",
      buildCodexMcpConfig(input.mcpUrl).trim(),
      "```",
      "",
      `Or: \`codex mcp add vibehub --url ${input.mcpUrl} --bearer-token-env-var VIBEHUB_MCP_TOKEN\``,
      "",
      "3. `codex mcp list` — vibehub should appear.",
      "",
      ...push,
    ].join("\n");
  }

  if (agentId === "vscode") {
    return [
      "Help me connect VibeHub and push this project using VS Code with GitHub Copilot.",
      "",
      tokenNote,
      "",
      ...pasteKeyBlock([
        "Open `.vscode/mcp.json` in the project (or MCP: Open User Configuration).",
        "In the `servers.vibehub` entry, find `headers.Authorization`.",
        `Replace \`${tokenPlaceholder}\` with their full \`vh_…\` token: \`Authorization: Bearer vh_…\`.`,
        "Save, then open Copilot Chat in Agent mode and confirm VibeHub tools appear.",
      ]),
      "## Step 1 — Add VibeHub MCP in VS Code",
      "",
      "1. Open this project in VS Code.",
      "2. Command palette → MCP: Open User Configuration, or create `.vscode/mcp.json`.",
      "3. VS Code uses a `servers` key. Paste:",
      "",
      "```json",
      buildVsCodeMcpConfig(input.mcpUrl, tokenPlaceholder).trim(),
      "```",
      "",
      "4. Tell the user to replace the placeholder in `headers.Authorization` with their vh_… token.",
      "5. Open Copilot Chat → Agent mode and confirm tools.",
      "",
      ...push,
    ].join("\n");
  }

  if (agentId === "windsurf") {
    return [
      "Help me connect VibeHub and push this project using Windsurf.",
      "",
      tokenNote,
      "",
      ...pasteKeyBlock([
        "Open Windsurf MCP config (`~/.codeium/windsurf/mcp_config.json` or via command palette → Windsurf: Configure MCP Servers).",
        "In the `vibehub` entry, find `headers.Authorization` (remote servers use `serverUrl`, not `url`).",
        `Replace \`${tokenPlaceholder}\` with their full \`vh_…\` token: \`Authorization: Bearer vh_…\`.`,
        "Save, fully quit and reopen Windsurf, then confirm tools in Cascade.",
      ]),
      "## Step 1 — Add VibeHub MCP in Windsurf",
      "",
      "1. Open Windsurf → Configure MCP Servers.",
      "2. Paste (uses `serverUrl`):",
      "",
      "```json",
      buildWindsurfMcpConfig(input.mcpUrl, tokenPlaceholder).trim(),
      "```",
      "",
      "3. Tell the user to replace the placeholder in `headers.Authorization` with their vh_… token.",
      "4. Fully quit and restart Windsurf.",
      "",
      ...push,
    ].join("\n");
  }

  if (agentId === "antigravity") {
    return [
      "Help me connect VibeHub and push this project using Google Antigravity.",
      "",
      tokenNote,
      "",
      ...pasteKeyBlock([
        "Open MCP raw config: agent side panel → … → MCP Servers → Manage MCP Servers → View raw config.",
        "Or edit `~/.gemini/config/mcp_config.json` (global) / `.agents/mcp_config.json` (workspace).",
        "In the `vibehub` entry, find `headers.Authorization` (remote servers must use `serverUrl`).",
        `Replace \`${tokenPlaceholder}\` with their full \`vh_…\` token: \`Authorization: Bearer vh_…\`.`,
        "Save, refresh MCP servers, and confirm vibehub tools appear.",
      ]),
      "## Step 1 — Add VibeHub MCP in Antigravity",
      "",
      "1. Open Antigravity MCP raw config.",
      "2. Paste (uses `serverUrl`):",
      "",
      "```json",
      buildAntigravityMcpConfig(input.mcpUrl, tokenPlaceholder).trim(),
      "```",
      "",
      "3. Tell the user to replace the placeholder in `headers.Authorization` with their vh_… token.",
      "4. Refresh MCP servers and confirm tools.",
      "",
      ...push,
    ].join("\n");
  }

  // other / generic
  return [
    "Help me push this project to VibeHub.",
    "",
    tokenNote,
    "",
    ...pasteKeyBlock([
      `If their tool supports remote HTTP MCP: add server URL \`${input.mcpUrl}\` and set the Authorization header to \`Bearer vh_…\` (paste the full token after Bearer).`,
      "If MCP setup is confusing: ask them to paste the `vh_…` token directly in this chat so you can proceed.",
    ]),
    "## MCP connection",
    `Server URL: ${input.mcpUrl}`,
    "Authentication: Authorization: Bearer vh_… (from VibeHub Settings)",
    "",
    ...push,
  ].join("\n");
}

/** Short prompt for add-project UI — MCP wiring lives in Settings, not here. */
export function buildConcisePushPrompt(input: AgentGuideInput): string {
  const lines = [
    "Push this project to VibeHub using the VibeHub MCP tools.",
    "",
    "IMPORTANT: Push COMPLETE features only — not after every prompt. Only push when I say I'm done building or ask you to push to VibeHub.",
    "",
    input.hasMcpToken
      ? "MCP is configured — use the Bearer token from VibeHub Settings."
      : "If MCP is not connected, ask me for my vh_… token from VibeHub Settings first.",
  ];

  if (input.projectId) {
    lines.push(
      "",
      `Project ID: ${input.projectId}`,
      input.projectUrl ? `Project URL: ${input.projectUrl}` : "",
      input.repoUrl ? `GitHub repo: ${input.repoUrl}` : "",
      "",
      "Feature update workflow:",
      "1. get_project_context(project_id) — note current_version",
      "2. If local based_on_version is behind: pull_diff({ based_on_version }) → apply line diffs → resolve conflicts",
      "3. Ask the user: \"Is this code good? Test it and let me know.\" Wait until they approve.",
      "4. Re-check current_version (main may have moved). If behind, pull_diff again and re-ask for approval.",
      "5. push_code with based_on_version = current_version and user_approved: true",
      "6. Poll get_push_status until merged or failed",
      "",
      "Always pass project_id. Return project_url when done.",
    );
  } else {
    lines.push(
      "",
      "First-time bootstrap:",
      "1. Read `.vibehub/project.json` if it exists — reuse project_id and repo_url.",
      "2. Git remote → GitHub with code pushed → push_to_vibehub({ repo_url, repo_name }).",
      "3. Has shell, no git remote → bootstrap_via_git({ repo_name }) → run git_commands → bootstrap_via_git({ repo_url, wait_for_commits: true }).",
      "4. No shell only → push_to_vibehub({ repo_name, files[] }) — skips lockfiles and node_modules.",
      "Use one repo name from package.json. Do not set private:true unless I ask.",
      "After the first push: save project_config from the response to `.vibehub/project.json`. Never commit VibeHub files.",
      "Auto-append this to `.gitignore` if missing (do it yourself, don't ask):",
      "```gitignore",
      VIBEHUB_GITIGNORE_SNIPPET.trim(),
      "```",
      "Return project_url when done.",
    );
  }

  return lines.filter(Boolean).join("\n");
}

/** Prompt when user finishes a feature and wants to ship to VibeHub. */
export function buildFeaturePushPrompt(input: AgentGuideInput): string {
  return [
    "I'm done building my feature — push it to VibeHub.",
    "",
    input.hasMcpToken
      ? "MCP is configured — use the Bearer token from VibeHub Settings."
      : "If MCP is not connected, ask me for my vh_… token from VibeHub Settings first.",
    "",
    input.projectId ? `Project ID: ${input.projectId}` : "Read `.vibehub/project.json` for project_id.",
    "",
    "Do NOT push partial work — only push when the feature is complete.",
    "",
    "Workflow:",
    "1. get_project_context(project_id) — note current_version (VibeHub is SoT, not git)",
    "2. get_my_task(project_id) — tasks assigned to you",
    "3. pull_snapshot(project_id, version=current_version) if you need SoT files",
    "4. begin_upload with EVERY file the feature touches — markup, styles, assets — declaring each file's byte size",
    "5. upload_file for anything too large to inline, split into parts, then review_push to see the diff against main",
    "6. STOP and ask: \"Ready to push <feature> to VibeHub?\" — wait for an explicit yes, then re-check current_version",
    "7. push_code({ upload_id, based_on_version: current_version, confirm_user_approved: true, confirm_built_on_latest: true, user_approval_quote: \"<my exact words>\" })",
    "8. get_push_status until merged / conflict / failed — then STOP",
    "9. Optional: pull_snapshot to verify. Never git fetch/pull to verify.",
    "",
    "Never sync_project_tasks unless I explicitly asked to create tasks.",
    "Never invent tasks to recover a failed push — fix files and push_code again.",
    "Never commit or push .vibehub/ or MCP config files.",
    "Return project_url when the push merges successfully.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildAgentGuides(input: AgentGuideInput): AgentGuide[] {
  const base = input;

  return [
    {
      id: "cursor",
      name: "Cursor",
      tagline: "Most popular for vibecoding — Agent mode + MCP",
      config_path: "~/.cursor/mcp.json or .cursor/mcp.json",
      config_label: "Cursor MCP config (JSON)",
      config: buildCursorMcpConfig(input.mcpUrl),
      cli_command: null,
      setup_steps: [
        "Create a VibeHub MCP token in Settings (copy it when shown — it won't appear again).",
        "In Cursor, open MCP settings (Customize → MCP), or add an mcp.json in your user config or project `.cursor/` folder.",
        "Paste the config below. Tell yourself: replace vh_YOUR_TOKEN_HERE in headers.Authorization with your full vh_… token.",
        "Restart Cursor. Confirm vibehub shows as connected in MCP settings.",
        "Open your project folder and switch to Agent mode (Ctrl/Cmd+I).",
        "Paste the setup prompt below, or simply say: Push this to VibeHub.",
      ],
      setup_prompt: buildAgentSetupPrompt("cursor", base),
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      tagline: "Anthropic's desktop app — add VibeHub as a connector",
      config_path: "Settings → Connectors (in the app)",
      config_label: "Connector details",
      config: `Name: VibeHub\nURL: ${input.mcpUrl}\nAuth: Bearer token (paste your vh_… token from VibeHub Settings)`,
      cli_command: null,
      setup_steps: [
        "Create a VibeHub MCP token in Settings and copy it.",
        "Open Claude Desktop (download from claude.ai/download if needed).",
        "Open Settings → Connectors (from your profile menu).",
        "Click Add custom connector.",
        `Name it VibeHub. Paste this URL: ${input.mcpUrl}`,
        "When asked for auth, paste your vh_… token as the Bearer token (that is where the MCP key goes).",
        "Fully quit Claude Desktop (don't just close the window) and reopen.",
        "Start a new chat. Look for the tools/hammer icon — that means VibeHub is connected.",
        "Paste the prompt below or say: Push this folder to VibeHub.",
      ],
      setup_prompt: buildAgentSetupPrompt("claude-desktop", base),
    },
    {
      id: "claude-code",
      name: "Claude Code",
      tagline: "Terminal agent — great for repo-aware pushes",
      config_path: ".mcp.json (project root) or ~/.claude.json",
      config_label: "Claude Code .mcp.json",
      config: buildClaudeCodeMcpJson(input.mcpUrl),
      cli_command: `claude mcp add --transport http --scope project --header "Authorization: Bearer YOUR_TOKEN" vibehub ${input.mcpUrl}`,
      setup_steps: [
        "Create a VibeHub MCP token in Settings.",
        "Install Claude Code if you haven't: https://code.claude.com",
        "Open Terminal in your project folder.",
        "Run the command below and replace YOUR_TOKEN with your vh_… key, OR paste the JSON into .mcp.json and put the key in headers.Authorization.",
        "Start Claude Code in this folder: claude",
        "Type /mcp and confirm vibehub is listed and connected.",
        "Paste the setup prompt below, or say: Push this to VibeHub.",
      ],
      setup_prompt: buildAgentSetupPrompt("claude-code", base),
    },
    {
      id: "codex",
      name: "OpenAI Codex",
      tagline: "Codex CLI — uses TOML config, not JSON",
      config_path: "~/.codex/config.toml or .codex/config.toml",
      config_label: "Codex config.toml",
      config: buildCodexMcpConfig(input.mcpUrl),
      cli_command: `export VIBEHUB_MCP_TOKEN=vh_YOUR_TOKEN && codex mcp add vibehub --url ${input.mcpUrl} --bearer-token-env-var VIBEHUB_MCP_TOKEN`,
      setup_steps: [
        "Create a VibeHub MCP token in Settings.",
        "Install Codex CLI: https://developers.openai.com/codex",
        "In Terminal: export VIBEHUB_MCP_TOKEN=vh_… — paste your full MCP key after the equals sign.",
        "Add the TOML block below to ~/.codex/config.toml, OR run the command below (it reads that env var).",
        "Run codex mcp list — vibehub should appear.",
        "Start a Codex session in your project. Type /mcp to verify tools.",
        "Paste the setup prompt below, or say: Push this to VibeHub.",
      ],
      setup_prompt: buildAgentSetupPrompt("codex", base),
    },
    {
      id: "vscode",
      name: "VS Code + Copilot",
      tagline: "GitHub Copilot Agent mode with MCP",
      config_path: ".vscode/mcp.json or user MCP config",
      config_label: "VS Code mcp.json",
      config: buildVsCodeMcpConfig(input.mcpUrl),
      cli_command: null,
      setup_steps: [
        "Create a VibeHub MCP token in Settings.",
        "Open VS Code in your project folder.",
        "Open the command palette (Ctrl/Cmd+Shift+P).",
        "Run MCP: Open User Configuration — or create .vscode/mcp.json in your project.",
        "Paste the config below. Replace vh_YOUR_TOKEN_HERE in headers.Authorization with your vh_… MCP key.",
        "Open Copilot Chat and switch to Agent mode.",
        "Paste the setup prompt below, or say: Push this to VibeHub.",
      ],
      setup_prompt: buildAgentSetupPrompt("vscode", base),
    },
    {
      id: "windsurf",
      name: "Windsurf",
      tagline: "Codeium's IDE — Cascade AI assistant",
      config_path: "~/.codeium/windsurf/mcp_config.json",
      config_label: "Windsurf MCP config",
      config: buildWindsurfMcpConfig(input.mcpUrl),
      cli_command: null,
      setup_steps: [
        "Create a VibeHub MCP token in Settings.",
        "Open Windsurf.",
        "Open the command palette (Ctrl/Cmd+Shift+P) → Windsurf: Configure MCP Servers.",
        "Paste the config below. Replace vh_YOUR_TOKEN_HERE in headers.Authorization with your vh_… MCP key.",
        "Fully quit and restart Windsurf.",
        "Open Cascade and confirm VibeHub tools appear.",
        "Paste the setup prompt below, or say: Push this to VibeHub.",
      ],
      setup_prompt: buildAgentSetupPrompt("windsurf", base),
    },
    {
      id: "antigravity",
      name: "Antigravity",
      tagline: "Google Antigravity IDE — MCP Store + raw config",
      config_path: "~/.gemini/config/mcp_config.json or .agents/mcp_config.json",
      config_label: "Antigravity mcp_config.json",
      config: buildAntigravityMcpConfig(input.mcpUrl),
      cli_command: null,
      setup_steps: [
        "Create a VibeHub MCP token in Settings.",
        "Open Antigravity.",
        "Agent side panel → … → MCP Servers → Manage MCP Servers → View raw config.",
        "Paste the config below. Replace vh_YOUR_TOKEN_HERE in headers.Authorization with your vh_… MCP key.",
        "Refresh MCP servers and confirm vibehub tools appear.",
        "Paste the setup prompt below, or say: Push this to VibeHub.",
      ],
      setup_prompt: buildAgentSetupPrompt("antigravity", base),
    },
    {
      id: "other",
      name: "Other agent",
      tagline: "Any MCP client — or paste token in chat",
      config_path: "Varies by tool",
      config_label: "Connection details",
      config: `URL: ${input.mcpUrl}\nAuthorization: Bearer vh_YOUR_TOKEN_HERE`,
      cli_command: null,
      setup_steps: [
        "Create a VibeHub MCP token in Settings.",
        "If your AI tool supports MCP: add a remote HTTP server with the URL above, and paste your vh_… key after Bearer in the Authorization header.",
        "If MCP setup is confusing: paste your vh_… token in the agent chat, then send the setup prompt below.",
        "The agent can push via MCP tools or guide you through any manual steps.",
        "Say: Push this to VibeHub.",
      ],
      setup_prompt: buildAgentSetupPrompt("other", base),
    },
  ];
}

export function buildAgentPushPrompt(input: {
  mcpUrl: string;
  projectId?: string;
  projectUrl?: string;
  repoUrl?: string | null;
  hasMcpToken?: boolean;
}): string {
  return buildAgentSetupPrompt("cursor", {
    projectId: input.projectId ?? "",
    projectUrl: input.projectUrl ?? "",
    repoUrl: input.repoUrl ?? null,
    repoName: null,
    mcpUrl: input.mcpUrl,
    hasMcpToken: input.hasMcpToken ?? false,
  });
}

export function buildPushKit(input: ProjectConfigInput & { hasMcpToken: boolean }) {
  const guideInput: AgentGuideInput = {
    projectId: input.projectId,
    projectUrl: input.projectUrl,
    repoUrl: input.repoUrl,
    repoName: input.repoName,
    mcpUrl: input.mcpUrl,
    hasMcpToken: input.hasMcpToken,
  };

  const agents = buildAgentGuides(guideInput);
  const defaultAgent = agents[0]!;

  return {
    project_config_path: ".vibehub/project.json",
    project_config: input.projectId ? buildProjectConfigJson(input) : "",
    cursor_mcp_config: buildCursorMcpConfig(input.mcpUrl),
    cursor_rule: buildCursorRule(),
    push_prompt: buildConcisePushPrompt(guideInput),
    feature_push_prompt: buildFeaturePushPrompt(guideInput),
    agent_push_prompt: defaultAgent.setup_prompt,
    agents,
    setup_steps: [
      "Connect GitHub on VibeHub so we can save your code.",
      "Create an MCP token in Settings — copy it when shown.",
      "Pick your AI tool below and follow its steps (or copy one prompt into chat).",
      "Open your project folder and say: Push this to VibeHub.",
      "After the first push, keep .vibehub/project.json local and gitignored — not in your app repo.",
    ],
    gitignore_snippet: buildGitignoreSnippet(),
    has_project: Boolean(input.projectId),
  };
}
