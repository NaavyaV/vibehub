import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, CopyBlock, Stack } from "./ui";

export type AgentId =
  | "cursor"
  | "claude-desktop"
  | "claude-code"
  | "codex"
  | "vscode"
  | "windsurf"
  | "antigravity"
  | "other";

export type AgentGuide = {
  id: AgentId;
  name: string;
  tagline: string;
  config_path: string;
  config_label: string;
  config: string;
  cli_command: string | null;
  setup_steps: string[];
  setup_prompt: string;
};

export type PushKit = {
  project_config_path: string;
  project_config: string;
  cursor_mcp_config: string;
  cursor_rule: string;
  push_prompt: string;
  feature_push_prompt?: string;
  agent_push_prompt: string;
  gitignore_snippet?: string;
  setup_steps: string[];
  agents?: AgentGuide[];
  has_project?: boolean;
};

export type McpTokenRow = {
  id: string;
  name: string;
  created_at: string;
  last_used_at?: string | null;
};

const AGENT_LOGOS: Record<AgentId, { src: string; alt: string }> = {
  cursor: { src: "/agent-logos/cursor.svg", alt: "Cursor" },
  "claude-desktop": { src: "/agent-logos/claude-desktop.svg", alt: "Claude Desktop" },
  "claude-code": { src: "/agent-logos/anthropic.svg", alt: "Claude Code" },
  codex: { src: "/agent-logos/openai.svg", alt: "OpenAI" },
  vscode: { src: "/agent-logos/visualstudiocode.svg", alt: "VS Code" },
  windsurf: { src: "/agent-logos/windsurf.svg", alt: "Windsurf" },
  antigravity: { src: "/agent-logos/antigravity.svg", alt: "Antigravity" },
  other: { src: "/agent-logos/other.svg", alt: "Other agent" },
};

export function AgentPushPanel({
  mcpUrl,
  pushKit,
  tokens,
  revealedToken,
  hasRepoAccess = true,
  compact = false,
  embedded = false,
  disabled = false,
}: {
  mcpUrl: string;
  pushKit: PushKit;
  tokens: McpTokenRow[];
  revealedToken?: string | null;
  hasRepoAccess?: boolean;
  compact?: boolean;
  embedded?: boolean;
  disabled?: boolean;
}) {
  const agents = pushKit.agents ?? [];
  const [selectedId, setSelectedId] = useState<AgentId>(agents[0]?.id ?? "cursor");
  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? agents[0],
    [agents, selectedId],
  );

  const hasToken = tokens.length > 0 || Boolean(revealedToken);
  const checklist = [
    {
      id: "github",
      label: "GitHub",
      detail: hasRepoAccess ? "Connected" : "Needed",
      done: hasRepoAccess,
    },
    {
      id: "token",
      label: "Token",
      detail: hasToken ? tokens.map((t) => t.name).join(", ") || "Ready" : "Needed",
      done: hasToken,
    },
    {
      id: "agent",
      label: "AI tool",
      detail: selected?.name ?? "Pick one",
      done: hasToken && Boolean(selected),
    },
    {
      id: "push",
      label: "Push",
      detail: hasRepoAccess && hasToken ? "Ready" : "Pending",
      done: hasRepoAccess && hasToken,
    },
  ];

  return (
    <div
      className={[
        "agent-panel",
        embedded ? "agent-panel--embedded" : "",
        disabled ? "settings-locked" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {disabled ? (
        <p className="settings-locked-note muted">
          Connect GitHub repos above before configuring your AI tool.
        </p>
      ) : null}

      <ol className="setup-checklist-list setup-checklist-list--tight" aria-label="Setup checklist">
        {checklist.map((item, index) => (
          <li
            key={item.id}
            className={`setup-checklist-item${item.done ? " setup-checklist-item--done" : ""}`}
          >
            <span className="setup-checklist-num" aria-hidden>
              {item.done ? "✓" : index + 1}
            </span>
            <div className="setup-checklist-copy">
              <strong>{item.label}</strong>
              <span className="muted">{item.detail}</span>
            </div>
          </li>
        ))}
      </ol>

      {!embedded && revealedToken ? (
        <>
          <Alert variant="success">Copy this token now — it won&apos;t be shown again.</Alert>
          <CopyBlock text={revealedToken} label="Copy MCP token" />
        </>
      ) : null}

      {!embedded && !hasToken ? (
        <Alert variant="warn">
          No MCP token yet.{" "}
          <Link to="/settings">Create one in Settings</Link>, then come back here — or paste the
          token in your agent chat.
        </Alert>
      ) : null}

      {agents.length > 0 ? (
        <>
          <div className="agent-picker">
            <p className="agent-picker-label">Which AI are you using?</p>
            <div className="agent-picker-grid" role="tablist" aria-label="AI agent setup">
              {agents.map((agent) => {
                const logo = AGENT_LOGOS[agent.id];
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="tab"
                    aria-selected={selected?.id === agent.id}
                    disabled={disabled}
                    className={`agent-picker-btn${selected?.id === agent.id ? " agent-picker-btn--active" : ""}`}
                    onClick={() => setSelectedId(agent.id)}
                  >
                    <img
                      className="agent-picker-logo"
                      src={logo.src}
                      alt=""
                      width={22}
                      height={22}
                      loading="lazy"
                    />
                    <span className="agent-picker-name">{agent.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {selected ? (
            <div className="agent-guide" role="tabpanel">
              <header className="agent-guide-banner">
                <img
                  className="agent-guide-logo"
                  src={AGENT_LOGOS[selected.id].src}
                  alt=""
                  width={22}
                  height={22}
                />
                <div className="agent-guide-banner-text">
                  <h4 className="agent-guide-name">{selected.name}</h4>
                  <p className="muted">{selected.tagline}</p>
                </div>
                <p className="agent-guide-config-path muted">
                  <span>Config</span> <code>{selected.config_path}</code>
                </p>
              </header>

              <section className="agent-prompt-card">
                <div className="agent-prompt-card-head">
                  <h4 className="section-title section-title--sm">
                    One prompt for {selected.name}
                  </h4>
                  <p className="muted">
                    Paste this into chat — it connects VibeHub and pushes for you.
                  </p>
                </div>
                {!hasToken ? (
                  <p className="muted agent-prompt-tip">
                    Tip: paste your <code>vh_…</code> token in chat first if MCP isn&apos;t set up
                    yet.
                  </p>
                ) : null}
                <CopyBlock text={selected.setup_prompt} label={`Copy ${selected.name} prompt`} />
              </section>

              <h5 className="agent-diy-heading">Do it yourself:</h5>

              <div className="agent-guide-split">
                <div className="agent-guide-col agent-guide-col--steps">
                  <h5 className="agent-guide-col-title">Setup steps</h5>
                  <ol className="agent-guide-steps">
                    {selected.setup_steps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                  {!compact && !pushKit.has_project ? (
                    <p className="muted agent-guide-note">
                      After the first push, keep <code>{pushKit.project_config_path}</code> local so
                      later pushes stay on the same project.
                    </p>
                  ) : null}
                </div>

                <div className="agent-guide-col agent-guide-col--mcp">
                  <h5 className="agent-guide-col-title">MCP config</h5>
                  <p className="muted agent-guide-paste-hint">
                    Paste your <code>vh_…</code> key where the config says{" "}
                    <code>vh_YOUR_TOKEN_HERE</code> (in the Authorization header).
                  </p>
                  <CopyBlock text={selected.config} label={`Copy ${selected.config_label}`} />
                  {selected.cli_command ? (
                    <CopyBlock text={selected.cli_command} label="Copy terminal command" />
                  ) : null}
                </div>
              </div>

              <div className="agent-guide-extras">
                {!compact && selected.id === "cursor" ? (
                  <details className="agent-kit-block">
                    <summary>
                      <span className="details-chevron" aria-hidden />
                      Optional project rule
                    </summary>
                    <CopyBlock text={pushKit.cursor_rule} label="Copy project rule" />
                  </details>
                ) : null}

                <details className="agent-kit-block">
                  <summary>
                    <span className="details-chevron" aria-hidden />
                    Getting 401 Unauthorized?
                  </summary>
                  <ol className="agent-guide-steps">
                    <li>
                      {embedded ? (
                        <>
                          Regenerate a token above and copy the full <code>vh_…</code> string.
                        </>
                      ) : (
                        <>
                          Go to <Link to="/settings">Settings</Link> → regenerate → copy the full{" "}
                          <code>vh_…</code> string.
                        </>
                      )}
                    </li>
                    <li>
                      Replace <code>vh_YOUR_TOKEN_HERE</code> in your tool&apos;s MCP config{" "}
                      <code>Authorization</code> header.
                    </li>
                    <li>Use Settings → Test a token to confirm it works.</li>
                    <li>Fully quit and reopen your AI app.</li>
                  </ol>
                </details>

                {!compact && pushKit.has_project && pushKit.project_config ? (
                  <details className="agent-kit-block">
                    <summary>
                      <span className="details-chevron" aria-hidden />
                      Pin this project
                    </summary>
                    <Stack gap="sm">
                      <p className="muted">
                        Save as <code>{pushKit.project_config_path}</code> so every agent reuses the
                        same project.
                      </p>
                      <CopyBlock text={pushKit.project_config} label="Copy project config" />
                    </Stack>
                  </details>
                ) : null}
              </div>

              <p className="agent-mcp-meta muted">
                MCP URL: <code>{mcpUrl}</code>
                {!embedded ? (
                  <>
                    {" "}
                    · <Link to="/settings">Manage tokens</Link>
                  </>
                ) : null}
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <CopyBlock text={pushKit.cursor_mcp_config} label="Copy MCP config" />
          <p className="agent-mcp-meta muted">
            MCP URL: <code>{mcpUrl}</code>
          </p>
        </>
      )}
    </div>
  );
}
