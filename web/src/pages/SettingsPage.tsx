import { useEffect, useState } from "react";
import {
  ApiError,
  api,
  githubLoginUrl,
  githubPrivateRepoAuthUrl,
  githubRepoAuthUrl,
} from "../lib/api";
import { AgentPushPanel, type McpTokenRow, type PushKit } from "../components/AgentPushPanel";
import { Alert, Card, CopyBlock, PageHeader, Shell, Stack } from "../components/ui";

type User = {
  id: string;
  display_name: string;
  github_login: string | null;
  avatar_url: string | null;
  has_github_token: boolean;
  has_repo_access: boolean;
  has_private_repo_access: boolean;
  has_mcp_token: boolean;
};

type TokenRow = McpTokenRow;

type StatusTone = "ok" | "warn" | "muted";

function StatusChip({
  label,
  detail,
  tone,
}: {
  label: string;
  detail?: string;
  tone: StatusTone;
}) {
  return (
    <span className={`status-chip status-chip--${tone}`}>
      <span className="status-chip-dot" aria-hidden />
      <span className="status-chip-text">
        <span className="status-chip-label">{label}</span>
        {detail ? <span className="status-chip-detail">{detail}</span> : null}
      </span>
    </span>
  );
}

export function SettingsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [mcpUrl, setMcpUrl] = useState("");
  const [pushKit, setPushKit] = useState<PushKit | null>(null);
  const [newTokenName, setNewTokenName] = useState("My agent");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [verifyToken, setVerifyToken] = useState("");
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const me = await api<{
      user: User | null;
      mcp_url?: string;
      push_kit?: PushKit;
    }>("/api/me");
    if (!me.user) {
      window.location.href = githubLoginUrl(window.location.href);
      return;
    }
    setUser(me.user);
    setMcpUrl(me.mcp_url ?? "");
    setPushKit(me.push_kit ?? null);
    const list = await api<{ tokens: TokenRow[]; mcp_url: string }>("/api/tokens");
    setTokens(list.tokens);
    setMcpUrl(list.mcp_url);
  }

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  async function createToken() {
    setBusy(true);
    setError(null);
    setRevealedToken(null);
    try {
      const result = await api<{ token: string }>("/api/tokens", {
        method: "POST",
        body: JSON.stringify({ name: newTokenName.trim() || "My agent" }),
      });
      setRevealedToken(result.token);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create token");
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(tokenId: string) {
    if (!window.confirm("Revoke this token? Agents using it will lose access.")) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/tokens/${tokenId}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke token");
    } finally {
      setBusy(false);
    }
  }

  async function testToken() {
    setBusy(true);
    setError(null);
    setVerifyResult(null);
    try {
      const result = await api<{ valid: boolean; reason?: string }>("/api/tokens/verify", {
        method: "POST",
        body: JSON.stringify({ token: verifyToken.trim() }),
      });
      setVerifyResult(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not verify token");
    } finally {
      setBusy(false);
    }
  }

  async function regenerateToken(tokenId: string) {
    if (!window.confirm("Regenerate this token? The old one stops working immediately.")) return;
    setBusy(true);
    setError(null);
    setRevealedToken(null);
    try {
      const result = await api<{ token: string }>(`/api/tokens/${tokenId}/regenerate`, {
        method: "POST",
      });
      setRevealedToken(result.token);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not regenerate token");
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <Shell>
        <p className="loading-line">{error ?? "Loading settings…"}</p>
      </Shell>
    );
  }

  const githubConnected = user.has_repo_access;
  const githubTone: StatusTone = user.github_login ? "ok" : "warn";
  const repoTone: StatusTone = githubConnected ? "ok" : user.github_login ? "warn" : "muted";
  const tokenTone: StatusTone = !githubConnected ? "muted" : tokens.length > 0 ? "ok" : "warn";

  return (
    <Shell
      user={user}
      onLogout={() => {
        void api("/auth/logout", { method: "POST" }).then(() => {
          window.location.href = "/";
        });
      }}
    >
      <div className="settings-page">
        <PageHeader
          back={{ to: "/", label: "Home" }}
          title="Settings"
          subtitle="Connect GitHub, create an MCP token, then wire your AI tool."
        />

        {error ? <Alert variant="error">{error}</Alert> : null}

        <div className="settings-stack">
          <section className="settings-top">
            <Card title="GitHub" className="settings-card">
              <Stack gap="sm">
                <div className="settings-status" role="status" aria-label="Connection status">
                  <StatusChip
                    tone={githubTone}
                    label="GitHub"
                    detail={user.github_login ? `@${user.github_login}` : "Not signed in"}
                  />
                  <StatusChip
                    tone={repoTone}
                    label="Repos"
                    detail={
                      githubConnected
                        ? user.has_private_repo_access
                          ? "Public + private"
                          : "Public"
                        : "Needs access"
                    }
                  />
                  <StatusChip
                    tone={tokenTone}
                    label="MCP tokens"
                    detail={
                      !githubConnected
                        ? "Locked"
                        : tokens.length > 0
                          ? `${tokens.length} active`
                          : "None yet"
                    }
                  />
                </div>
                <p className="muted settings-lede">
                  Repo access lets VibeHub list repositories and push code. Organization access is
                  never requested.
                </p>
                <div className="row row-wrap">
                  {!user.has_github_token ? (
                    <a className="btn btn-primary" href={githubLoginUrl(window.location.href)}>
                      Sign in with GitHub
                    </a>
                  ) : null}
                  {!user.has_repo_access ? (
                    <a className="btn btn-secondary" href={githubRepoAuthUrl(window.location.href)}>
                      Connect repos
                    </a>
                  ) : null}
                  {user.has_repo_access && !user.has_private_repo_access ? (
                    <a
                      className="btn btn-secondary"
                      href={githubPrivateRepoAuthUrl(window.location.href)}
                    >
                      Enable private repos
                    </a>
                  ) : null}
                  {user.has_repo_access ? (
                    <span className="muted text-sm">Repos connected</span>
                  ) : null}
                </div>
              </Stack>
            </Card>

            <Card
              title="MCP tokens"
              description="Agents use these to call VibeHub. Shown once when created."
              className={`settings-card${!githubConnected ? " settings-card--locked" : ""}`}
            >
              {!githubConnected ? (
                <p className="settings-locked-note muted">
                  Connect GitHub repos first to create MCP tokens.
                </p>
              ) : null}
              <fieldset className="settings-fieldset" disabled={!githubConnected}>
                <Stack gap="sm">
                  <div className="token-create-row">
                    <input
                      type="text"
                      className="token-name-input"
                      value={newTokenName}
                      onChange={(event) => setNewTokenName(event.target.value)}
                      placeholder="Token name"
                      aria-label="Token name"
                    />
                    <button
                      type="button"
                      className="btn btn-primary token-create-btn"
                      disabled={busy || !githubConnected}
                      onClick={() => void createToken()}
                    >
                      {busy ? "Working…" : "Create"}
                    </button>
                  </div>

                  {revealedToken ? (
                    <div className="settings-reveal">
                      <p className="settings-reveal-label">Copy now — it won&apos;t be shown again</p>
                      <CopyBlock text={revealedToken} label="Copy token" />
                    </div>
                  ) : null}

                  {tokens.length === 0 ? (
                    <p className="muted">No tokens yet. Create one, then pick your AI tool.</p>
                  ) : (
                    <ul className="token-list">
                      {tokens.map((token) => (
                        <li key={token.id} className="token-list-item">
                          <div className="token-list-meta">
                            <strong>{token.name}</strong>
                            <span className="muted">
                              {formatDate(token.created_at)}
                              {token.last_used_at
                                ? ` · used ${formatDate(token.last_used_at)}`
                                : ""}
                            </span>
                          </div>
                          <div className="token-actions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={busy || !githubConnected}
                              onClick={() => void regenerateToken(token.id)}
                            >
                              Regenerate
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy || !githubConnected}
                              onClick={() => void revokeToken(token.id)}
                            >
                              Revoke
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  <details className="settings-details">
                    <summary>
                      <span className="details-chevron" aria-hidden />
                      Test a token
                    </summary>
                    <div className="token-verify">
                      <label className="field">
                        Paste a <code>vh_…</code> token
                        <input
                          type="password"
                          value={verifyToken}
                          onChange={(event) => setVerifyToken(event.target.value)}
                          placeholder="vh_…"
                          autoComplete="off"
                        />
                      </label>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy || !verifyToken.trim() || !githubConnected}
                        onClick={() => void testToken()}
                      >
                        {busy ? "Testing…" : "Test token"}
                      </button>
                      {verifyResult ? (
                        <Alert variant={verifyResult.valid ? "success" : "error"}>
                          {verifyResult.valid
                            ? "Token works. Put it in your AI tool’s MCP config, then fully restart the app."
                            : (verifyResult.reason ?? "Token invalid.")}
                        </Alert>
                      ) : null}
                    </div>
                  </details>
                </Stack>
              </fieldset>
            </Card>
          </section>

          <section className="settings-bottom">
            {pushKit ? (
              <Card
                title="Connect your AI"
                className={`settings-card settings-card--agent${!githubConnected ? " settings-card--locked" : ""}`}
              >
                <AgentPushPanel
                  mcpUrl={mcpUrl}
                  pushKit={pushKit}
                  tokens={tokens}
                  revealedToken={revealedToken}
                  hasRepoAccess={user.has_repo_access}
                  embedded
                  disabled={!githubConnected}
                />
              </Card>
            ) : (
              <Card title="Connect your AI" className="settings-card">
                <p className="muted">Loading setup guides…</p>
              </Card>
            )}
          </section>
        </div>
      </div>
    </Shell>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}
