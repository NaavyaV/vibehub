/**
 * Everything that is not the MCP endpoint: the web UI, the JSON API, GitHub
 * login, the OAuth authorize/consent page, and the GitHub Actions callback.
 *
 * This is the OAuth provider's `defaultHandler`.
 */

import { Hono, type Context } from "hono";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";

import { Repo, parseJsonArray } from "./db/repo.js";
import { HttpError, badRequest, forbidden, notFound, unauthorized } from "./lib/errors.js";
import { corsHeaders, withCors, allowedOrigins } from "./lib/cors.js";
import { hmacSign, safeEqual, sha256Hex } from "./lib/crypto.js";
import { newId, randomToken } from "./lib/ids.js";
import {
  clearSessionCookie,
  createSessionCookie,
  userIdFromRequest,
} from "./auth/session.js";
import { exchangeGithubCode, fetchGithubUser, githubAuthorizeUrl, fetchGithubTokenScopes, tokenHasRepoAccess, GITHUB_LOGIN_SCOPES, GITHUB_REPO_SCOPES, GITHUB_PRIVATE_REPO_SCOPES } from "./auth/github-oauth.js";
import { GitHubError } from "./github/client.js";
import { WORKFLOW_PATH, WORKFLOW_YAML } from "./github/workflow-template.js";
import { requireMembership, requireLiveMembership } from "./services/access.js";
import { importFromLocalCode } from "./services/upload.js";
import { buildCursorMcpConfig, buildPushKit } from "./services/agent-kit.js";
import {
  agentPushPrompt,
  bootstrapProjectFromCode,
  importProjectRepo,
  prepareGitPushRepo,
  pushToVibehub,
} from "./services/bootstrap.js";
import {
  createFeature,
  deleteFeature as deleteFeatureService,
  loadGraph,
  mergeFeatures,
  splitFeature,
  syncProjectTasks,
  updateFeatureFields,
} from "./services/features.js";
import {
  connectRepo,
  getProjectContext,
  importPlan,
  parsePlanInput,
  setupProjectRepository,
  pullSnapshot,
  revertToVersion,
  saveSnapshot,
} from "./services/projects.js";
import { purgeStaleProjectsForUser } from "./services/repo-health.js";
import {
  finalizePush,
  getPushStatus,
  pushCode,
  verifyCallbackToken,
} from "./services/push.js";
import { htmlResponse } from "./ui/html.js";
import { consentPage, homePage, messagePage, projectPage } from "./ui/pages.js";
import { IDEA_SCOPING_PROMPT, SCOPING_PROMPT } from "./ui/scoping-prompt.js";
import { toPublicStatus } from "./domain/task-status.js";
import { publicUrl, type AppEnv, type TestMode } from "./types.js";

type Env = AppEnv & { OAUTH_PROVIDER: OAuthHelpers };

/** The single scope this MVP issues: act on the projects you already belong to. */
export const MCP_SCOPE = "vibehub";

const app = new Hono<{ Bindings: Env }>();

// -------------------------------------------------------------- utilities

function repoOf(env: Env): Repo {
  return new Repo(env.DB);
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

async function viewerId(c: { env: Env; req: { raw: Request } }): Promise<string | null> {
  return userIdFromRequest(c.env, c.req.raw);
}

async function requireViewerId(c: { env: Env; req: { raw: Request } }): Promise<string> {
  const userId = await viewerId(c);
  if (!userId) throw unauthorized("Sign in first.");
  return userId;
}

async function viewer(c: { env: Env; req: { raw: Request } }) {
  const userId = await viewerId(c);
  if (!userId) return null;
  const user = await repoOf(c.env).getUser(userId);
  if (!user) return null;

  let hasRepoAccess = false;
  let hasPrivateRepoAccess = false;
  if (user.github_token_enc) {
    try {
      const { decryptSecret } = await import("./lib/crypto.js");
      const token = await decryptSecret(
        user.github_token_enc,
        requireSecret(c.env.ENCRYPTION_KEY, "ENCRYPTION_KEY"),
      );
      const scopes = await fetchGithubTokenScopes(token);
      hasRepoAccess = tokenHasRepoAccess(scopes);
      hasPrivateRepoAccess = scopes.includes("repo");
    } catch {
      hasRepoAccess = false;
      hasPrivateRepoAccess = false;
    }
  }

  return {
    id: user.id,
    displayName: user.display_name,
    githubLogin: user.github_login,
    avatarUrl: user.avatar_url,
    hasGithubToken: Boolean(user.github_token_enc),
    hasRepoAccess,
    hasPrivateRepoAccess,
  };
}

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(c.req.raw, c.env) });
  }
  await next();
  for (const [key, value] of Object.entries(corsHeaders(c.req.raw, c.env))) {
    c.res.headers.set(key, value);
  }
});

app.onError((error, c) => {
  const status =
    error instanceof HttpError
      ? error.status
      : error instanceof GitHubError
        ? error.status >= 400 && error.status < 500
          ? error.status
          : 502
        : 500;
  const message =
    error instanceof HttpError
      ? error.message
      : error instanceof GitHubError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Internal error";
  const publicMessage =
    c.req.path.startsWith("/api/") && message && message !== "Internal error"
      ? message
      : status === 500
        ? "Internal error"
        : message;
  const accepts = c.req.header("Accept") ?? "";
  const wantsJson = c.req.path.startsWith("/api/") || accepts.includes("application/json");
  if (!wantsJson && status !== 500) {
    return withCors(
      htmlResponse(
        messagePage({
          title: "Problem",
          heading: status === 401 || status === 403 ? "Not allowed" : "That did not work",
          kind: "err",
          messages: [publicMessage, ...(error instanceof HttpError && Array.isArray(error.details)
              ? (error.details as string[])
              : [])],
        }),
        status,
      ),
      c.req.raw,
      c.env,
    );
  }
  if (status === 500) console.error("Unhandled error", error);
  return withCors(
    c.json(
      {
        error: publicMessage,
        ...(error instanceof HttpError && error.details !== undefined
          ? { details: error.details }
          : {}),
      },
      status as 400,
    ),
    c.req.raw,
    c.env,
  );
});

// ------------------------------------------------------------------- auth

const NEXT_COOKIE = "vibehub_next";

/** Encode so URLs with "." don't break cookie parsing. */
function encodeNext(next: string): string {
  const bytes = new TextEncoder().encode(next);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeNext(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((encoded.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Cookie value: `state.nextB64.tier.signature` — next is base64url so it never
 * contains "." (URLs like https://host/ previously broke split-on-dot verify).
 */
function packLoginCookie(state: string, next: string, tier: string, signature: string): string {
  return encodeURIComponent(`${state}.${encodeNext(next)}.${tier}.${signature}`);
}

function unpackLoginCookie(
  raw: string,
): { state: string; next: string; tier: string; signature: string } | null {
  const decoded = decodeURIComponent(raw);
  const first = decoded.indexOf(".");
  const last = decoded.lastIndexOf(".");
  if (first <= 0 || last <= first) return null;

  const secondLast = decoded.lastIndexOf(".", last - 1);
  if (secondLast > first) {
    const state = decoded.slice(0, first);
    const nextB64 = decoded.slice(first + 1, secondLast);
    const tier = decoded.slice(secondLast + 1, last);
    const signature = decoded.slice(last + 1);
    if (!state || !nextB64 || !tier || !signature) return null;
    try {
      return { state, next: decodeNext(nextB64), tier, signature };
    } catch {
      return null;
    }
  }

  const state = decoded.slice(0, first);
  const nextB64 = decoded.slice(first + 1, last);
  const signature = decoded.slice(last + 1);
  if (!state || !nextB64 || !signature) return null;
  try {
    return { state, next: decodeNext(nextB64), tier: "login", signature };
  } catch {
    return null;
  }
}

async function startGithubOAuth(
  c: Context<{ Bindings: Env }>,
  scopes: string,
  tier: string,
): Promise<Response> {
  const state = newId("st");
  const next = c.req.query("next") ?? "/";
  const redirectUri = `${publicUrl(c.env)}/auth/github/callback`;
  const signature = await hmacSign(
    `${state}.${encodeNext(next)}.${tier}`,
    requireSecret(c.env.SESSION_SECRET, "SESSION_SECRET"),
  );
  const cookie = [
    `${NEXT_COOKIE}=${packLoginCookie(state, next, tier, signature)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=600",
    ...(isSecure(c.req.raw) ? ["Secure"] : []),
  ].join("; ");
  return new Response(null, {
    status: 302,
    headers: { Location: githubAuthorizeUrl(c.env, redirectUri, state, scopes), "Set-Cookie": cookie },
  });
}

app.get("/auth/github", (c) => startGithubOAuth(c, GITHUB_LOGIN_SCOPES, "login"));

/** Grants access to the user's own public repos (no organization access). */
app.get("/auth/github/repos", (c) => startGithubOAuth(c, GITHUB_REPO_SCOPES, "repos"));

/** Optional: private personal repos. User should deny org access on GitHub's screen. */
app.get("/auth/github/private", (c) => startGithubOAuth(c, GITHUB_PRIVATE_REPO_SCOPES, "private"));

app.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) throw badRequest("GitHub did not return an authorization code.");

  const cookie = readCookie(c.req.header("Cookie") ?? null, NEXT_COOKIE);
  if (!cookie) throw badRequest("Login session expired. Try signing in again.");
  const unpacked = unpackLoginCookie(cookie);
  if (!unpacked) throw badRequest("Login state did not verify. Try signing in again.");
  const { state: cookieState, next, tier, signature } = unpacked;
  const expected = await hmacSign(
    `${cookieState}.${encodeNext(next)}.${tier}`,
    requireSecret(c.env.SESSION_SECRET, "SESSION_SECRET"),
  );
  if (!safeEqual(expected, signature) || cookieState !== state) {
    throw badRequest("Login state did not verify. Try signing in again.");
  }

  const token = await exchangeGithubCode(c.env, code, `${publicUrl(c.env)}/auth/github/callback`);
  const profile = await fetchGithubUser(token);
  const { encryptSecret } = await import("./lib/crypto.js");
  const user = await repoOf(c.env).upsertGithubUser({
    githubLogin: profile.login,
    displayName: profile.name || profile.login,
    avatarUrl: profile.avatar_url,
    githubTokenEnc: await encryptSecret(token, requireSecret(c.env.ENCRYPTION_KEY, "ENCRYPTION_KEY")),
  });

  const headers = new Headers({ Location: safeNext(next ?? "/", c.env) });
  headers.append("Set-Cookie", await createSessionCookie(c.env, user.id, isSecure(c.req.raw)));
  headers.append(
    "Set-Cookie",
    `${NEXT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(c.req.raw) ? "; Secure" : ""}`,
  );
  return new Response(null, { status: 302, headers });
});

app.post("/auth/logout", async (c) => {
  const wantsJson = (c.req.header("Accept") ?? "").includes("application/json");
  const cookie = clearSessionCookie(isSecure(c.req.raw));
  if (wantsJson) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": cookie,
      },
    });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": cookie },
  });
});

app.post("/auth/dev-login", async (c) => {
  if (c.env.DEV_LOGIN !== "1") throw forbidden("Dev login is disabled.");
  const user = await repoOf(c.env).upsertGithubUser({
    githubLogin: "local-dev",
    displayName: "Local Dev",
    avatarUrl: null,
    githubTokenEnc: null,
  });
  const wantsJson = (c.req.header("Accept") ?? "").includes("application/json");
  const cookie = await createSessionCookie(c.env, user.id, isSecure(c.req.raw));
  if (wantsJson) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
    });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": cookie },
  });
});

// -------------------------------------------------- OAuth authorize page

app.get("/authorize", async (c) => {
  let authRequest: AuthRequest;
  try {
    authRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) return c.text(error.description, 400);
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }

  const userId = await viewerId(c);
  if (!userId) {
    const url = new URL(c.req.url);
    return new Response(null, {
      status: 302,
      headers: { Location: `/auth/github?next=${encodeURIComponent(url.pathname + url.search)}` },
    });
  }

  const client = await c.env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return c.text("Unknown OAuth client", 400);

  const payload = JSON.stringify(authRequest);
  const signature = await hmacSign(payload, requireSecret(c.env.SESSION_SECRET, "SESSION_SECRET"));
  const user = await repoOf(c.env).getUser(userId);

  return htmlResponse(
    consentPage({
      clientName: client.clientName ?? authRequest.clientId,
      displayName: user?.display_name ?? "you",
      scopes: authRequest.scope.length > 0 ? authRequest.scope : [MCP_SCOPE],
      payload,
      signature,
      cancelUrl: null,
    }),
  );
});

app.post("/authorize/approve", async (c) => {
  const userId = await requireViewerId(c);
  const form = await c.req.formData();
  const payload = String(form.get("auth_request") ?? "");
  const signature = String(form.get("auth_sig") ?? "");
  const expected = await hmacSign(payload, requireSecret(c.env.SESSION_SECRET, "SESSION_SECRET"));
  if (!safeEqual(expected, signature)) throw badRequest("Consent form did not verify.");

  const authRequest = JSON.parse(payload) as AuthRequest;
  const user = await repoOf(c.env).getUser(userId);

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId,
    metadata: { grantedAt: new Date().toISOString() },
    scope: authRequest.scope.length > 0 ? authRequest.scope : [MCP_SCOPE],
    props: { userId, displayName: user?.display_name ?? userId, via: "oauth" },
  });
  return Response.redirect(redirectTo, 302);
});

// ------------------------------------------------------------------- UI

app.get("/", async (c) => {
  const person = await viewer(c);
  const repo = repoOf(c.env);
  return htmlResponse(
    homePage({
      viewer: person,
      projects: person ? await repo.listProjectsForUser(person.id) : [],
      devLogin: c.env.DEV_LOGIN === "1",
      githubConfigured: Boolean(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET),
    }),
  );
});

app.get("/scoping-prompt", (c) => c.text(SCOPING_PROMPT));

/** The build-gate workflow, for repos that were not bootstrapped by VibeHub. */
app.get("/workflow", (c) =>
  c.text(WORKFLOW_YAML, 200, {
    "Content-Disposition": 'attachment; filename="vibehub-build.yml"',
  }),
);

app.post("/projects/import", async (c) => {
  const userId = await requireViewerId(c);
  const form = await c.req.formData();
  const planText = String(form.get("plan_text") ?? "");
  const testMode = String(form.get("test_mode") ?? "actions") === "skip" ? "skip" : "actions";

  const result = parsePlanInput({ plan_text: planText });
  const repo = repoOf(c.env);
  if (!result.ok) {
    const person = await viewer(c);
    return htmlResponse(
      homePage({
        viewer: person,
        projects: person ? await repo.listProjectsForUser(person.id) : [],
        devLogin: c.env.DEV_LOGIN === "1",
        githubConfigured: Boolean(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET),
        errors: result.errors,
        pasted: planText,
      }),
      400,
    );
  }

  const { project } = await importPlan(repo, { plan: result.plan, userId, testMode });
  // Non-blocking observations from validation (e.g. deduped dependency entries)
  // are carried to the project page rather than silently dropped.
  const query =
    result.plan.warnings.length > 0
      ? `?warn=${encodeURIComponent(result.plan.warnings.join("\n"))}`
      : "";
  return new Response(null, { status: 302, headers: { Location: `/projects/${project.id}${query}` } });
});

app.get("/projects/:id", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  const project = await requireMembership(repo, projectId, userId);
  const view = await loadGraph(repo, projectId);
  const user = await repo.getUser(userId);

  return htmlResponse(
    projectPage({
      viewer: { id: userId, displayName: user?.display_name ?? userId },
      project,
      features: view.features,
      mergedSlugs: view.mergedSlugs,
      members: await repo.listMembers(projectId),
      versions: await repo.listVersions(projectId),
      snapshots: await repo.listSnapshots(projectId),
      sharedFileWarnings: parseJsonArray(project.shared_file_warnings),
      mcpUrl: `${publicUrl(c.env)}/mcp`,
      workflowPath: WORKFLOW_PATH,
      tokens: await repo.listApiTokens(userId),
      newToken: c.req.query("token") ?? null,
      flash: c.req.query("warn")
        ? { kind: "warn", messages: c.req.query("warn")!.split("\n").filter(Boolean) }
        : null,
    }),
  );
});

app.post("/projects/:id/repo", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);

  const form = await c.req.formData();
  const repoUrl = String(form.get("repo_url") ?? "").trim();
  const user = await repo.getUser(userId);
  if (!user?.github_token_enc) {
    throw badRequest(
      "Your VibeHub account has no GitHub token. Sign in with GitHub (not dev login) to connect a repo.",
    );
  }
  const { decryptSecret } = await import("./lib/crypto.js");
  const githubToken = await decryptSecret(
    user.github_token_enc,
    requireSecret(c.env.ENCRYPTION_KEY, "ENCRYPTION_KEY"),
  );

  await connectRepo(c.env, repo, projectId, { repoUrl, githubToken });
  return new Response(null, { status: 302, headers: { Location: `/projects/${projectId}` } });
});

app.post("/projects/:id/test-mode", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const form = await c.req.formData();
  const testMode: TestMode = String(form.get("test_mode")) === "skip" ? "skip" : "actions";
  await repo.setTestMode(projectId, testMode);
  return new Response(null, { status: 302, headers: { Location: `/projects/${projectId}` } });
});

app.post("/projects/:id/tokens", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const form = await c.req.formData();
  const token = `vh_${randomToken(32)}`;
  await repo.createApiToken({
    userId,
    name: String(form.get("name") ?? "").trim(),
    tokenHash: await sha256Hex(token),
  });
  return new Response(null, {
    status: 302,
    headers: { Location: `/projects/${projectId}?token=${encodeURIComponent(token)}` },
  });
});

app.post("/projects/:id/tokens/:tokenId/revoke", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  await repo.revokeApiToken(userId, c.req.param("tokenId"));
  return new Response(null, { status: 302, headers: { Location: `/projects/${projectId}` } });
});

// ------------------------------------------------------------------- API

app.get("/api/config", (c) =>
  c.json({
    public_url: publicUrl(c.env),
    github_oauth: Boolean(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET),
    dev_login: c.env.DEV_LOGIN === "1",
    mcp_url: `${publicUrl(c.env)}/mcp`,
    scoping_prompt_url: `${publicUrl(c.env)}/scoping-prompt`,
  }),
);

function filterLegacySharedFileWarnings(_warnings: string[]): string[] {
  return [];
}

app.get("/api/me", async (c) => {
  const person = await viewer(c);
  if (!person) return c.json({ user: null });
  const tokens = person.id ? await repoOf(c.env).listApiTokens(person.id) : [];
  const pendingInvites =
    person.id ? await repoOf(c.env).listInvitesForUser(person.id) : [];
  const mcpUrl = `${publicUrl(c.env)}/mcp`;
  return c.json({
    user: {
      id: person.id,
      display_name: person.displayName,
      github_login: person.githubLogin,
      avatar_url: person.avatarUrl,
      has_github_token: person.hasGithubToken,
      has_repo_access: person.hasRepoAccess,
      has_private_repo_access: person.hasPrivateRepoAccess,
      has_mcp_token: tokens.length > 0,
    },
    pending_invites: pendingInvites.map((invite) => ({
      id: invite.id,
      project_id: invite.project_id,
      project_name: invite.project_name,
      role: invite.role,
      inviter_name: invite.inviter_name,
      inviter_github: invite.inviter_github,
      created_at: invite.created_at,
    })),
    mcp_url: mcpUrl,
    agent_push_prompt: agentPushPrompt(mcpUrl, tokens.length > 0),
    cursor_mcp_config: buildCursorMcpConfig(mcpUrl),
    push_kit: buildPushKit({
      projectId: "",
      projectUrl: publicUrl(c.env),
      repoUrl: null,
      repoName: null,
      mcpUrl,
      hasMcpToken: tokens.length > 0,
    }),
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      created_at: t.created_at,
      last_used_at: t.last_used_at,
    })),
  });
});

/** Create a personal MCP token (works before you have a project). */
app.post("/api/tokens", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const token = `vh_${randomToken(32)}`;
  const record = await repo.createApiToken({
    userId,
    name: String(body.name ?? "My agent").trim() || "My agent",
    tokenHash: await sha256Hex(token),
  });
  return c.json({
    token,
    id: record.id,
    name: String(body.name ?? "My agent").trim() || "My agent",
    mcp_url: `${publicUrl(c.env)}/mcp`,
    note: "Copy this token now. VibeHub will not show it again.",
  });
});

/** Test whether a pasted vh_… token is valid before wiring MCP. */
app.post("/api/tokens/verify", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  const token = String(body.token ?? "").trim();
  if (!token.startsWith("vh_")) {
    return c.json({ valid: false, reason: "Token must start with vh_" });
  }
  if (token.includes("YOUR_TOKEN") || token.includes("PASTE_")) {
    return c.json({
      valid: false,
      reason: "That is still the placeholder — paste your real token from Settings.",
    });
  }
  const record = await repo.findApiToken(await sha256Hex(token));
  if (!record) {
    return c.json({
      valid: false,
      reason: "Not found or revoked. Regenerate in Settings and update your MCP config.",
    });
  }
  if (record.user_id !== userId) {
    return c.json({ valid: false, reason: "This token belongs to a different VibeHub account." });
  }
  await repo.touchApiToken(record.id);
  return c.json({ valid: true, mcp_url: `${publicUrl(c.env)}/mcp` });
});

app.get("/api/tokens", async (c) => {
  const userId = await requireViewerId(c);
  const tokens = await repoOf(c.env).listApiTokens(userId);
  return c.json({
    tokens,
    mcp_url: `${publicUrl(c.env)}/mcp`,
  });
});

app.delete("/api/tokens/:tokenId", async (c) => {
  const userId = await requireViewerId(c);
  await repoOf(c.env).revokeApiToken(userId, c.req.param("tokenId"));
  return c.json({ revoked: true });
});

app.post("/api/tokens/:tokenId/regenerate", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const tokenId = c.req.param("tokenId");
  const existing = await repo.getApiToken(userId, tokenId);
  if (!existing) throw notFound("Token not found.");
  await repo.revokeApiToken(userId, tokenId);
  const token = `vh_${randomToken(32)}`;
  const record = await repo.createApiToken({
    userId,
    name: existing.name,
    tokenHash: await sha256Hex(token),
  });
  return c.json({
    token,
    id: record.id,
    name: existing.name,
    mcp_url: `${publicUrl(c.env)}/mcp`,
    note: "Copy this token now. VibeHub will not show it again.",
  });
});

app.get("/api/projects", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  // Return the list first; GitHub existence checks can take seconds and used to
  // block the home page long enough to feel like a stuck empty state.
  const projects = await repo.listProjectsForUser(userId);
  c.executionCtx.waitUntil(
    purgeStaleProjectsForUser(c.env, repo, userId).catch(() => [] as string[]),
  );
  return c.json({
    removed_stale_project_ids: [] as string[],
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      repo_url: project.repo_url,
      current_version: project.current_version,
      test_mode: project.test_mode,
      created_at: project.created_at,
      role: project.role,
    })),
  });
});

app.get("/api/scoping-prompt", (c) =>
  c.json({ prompt: IDEA_SCOPING_PROMPT, idea_prompt: IDEA_SCOPING_PROMPT }),
);

app.post("/api/import", async (c) => {
  const userId = await requireViewerId(c);
  const body = (await c.req.json()) as {
    plan_text?: string;
    plan?: unknown;
    test_mode?: string;
    repo_setup?: "connect" | "create";
    repo_url?: string;
    private?: boolean;
  };
  const result = parsePlanInput(body);
  if (!result.ok) return c.json({ error: "The plan is not valid.", details: result.errors }, 400);
  const repo = repoOf(c.env);
  const { project } = await importPlan(repo, {
    plan: result.plan,
    userId,
    testMode: body.test_mode === "skip" ? "skip" : "actions",
  });

  const repoSetup = body.repo_setup === "connect" ? "connect" : "create";
  const user = userId ? await repo.getUser(userId) : null;
  if (!user?.github_token_enc) {
    throw badRequest("Connect GitHub first so VibeHub can create or link a repository.");
  }

  const { decryptSecret } = await import("./lib/crypto.js");
  const githubToken = await decryptSecret(
    user.github_token_enc,
    requireSecret(c.env.ENCRYPTION_KEY, "ENCRYPTION_KEY"),
  );

  let repo_url: string | null = null;
  try {
    if (repoSetup === "connect") {
      const connectUrl = String(body.repo_url ?? "").trim();
      if (!connectUrl) {
        throw badRequest("Pick a GitHub repository to connect.");
      }
      const linked = await setupProjectRepository(c.env, repo, project.id, githubToken, {
        mode: "connect",
        repoUrl: connectUrl,
      });
      repo_url = linked.repo_url;
    } else {
      const linked = await setupProjectRepository(c.env, repo, project.id, githubToken, {
        mode: "create",
        private: body.private === true,
      });
      repo_url = linked.repo_url;
    }
  } catch (err) {
    // Project row may already be linked if the GitHub repo was created before a
    // later step failed — surface that so the client can open a working board.
    const refreshed = await repo.getProject(project.id);
    if (refreshed?.repo_url) {
      return c.json({
        project_id: project.id,
        name: project.name,
        current_version: project.current_version,
        repo_url: refreshed.repo_url,
        warnings: [
          ...result.plan.warnings,
          err instanceof Error ? err.message : "Repository linked with limited setup.",
        ],
      });
    }
    if (err instanceof HttpError) throw err;
    throw badRequest(err instanceof Error ? err.message : "Could not set up GitHub repository.");
  }

  return c.json({
    project_id: project.id,
    name: project.name,
    current_version: project.current_version,
    repo_url,
    warnings: result.plan.warnings,
  });
});

app.post("/api/projects/from-existing", async (c) => {
  const userId = await requireViewerId(c);
  const body = (await c.req.json()) as {
    repo_url?: string;
    project_name?: string;
    test_mode?: string;
  };
  const repoUrl = String(body.repo_url ?? "").trim();
  if (!repoUrl) throw badRequest("Pick a repository first.");

  const result = await importProjectRepo(c.env, repoOf(c.env), userId, {
    repoUrl,
    projectName: body.project_name,
    testMode: body.test_mode === "actions" ? "actions" : "skip",
  });
  return c.json(result);
});

/** One-shot: push code to GitHub + create VibeHub project (agent or API). */
app.post("/api/projects/push-to-vibehub", async (c) => {
  const userId = await requireViewerId(c);
  let body: {
    repo_name?: string;
    project_name?: string;
    private?: boolean;
    test_mode?: string;
    repo_url?: string;
    project_id?: string;
    files?: Array<{ path?: string; content?: string }>;
    tasks?: Array<{ title?: string; description?: string; depends_on?: string[] }>;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    throw badRequest("Invalid JSON body.");
  }

  const result = await pushToVibehub(c.env, repoOf(c.env), userId, {
    projectId: body.project_id,
    repoName: body.repo_name,
    projectName: body.project_name,
    private: body.private === true,
    testMode: body.test_mode === "actions" ? "actions" : "skip",
    repoUrl: body.repo_url,
    files: body.files?.map((file) => ({
      path: String(file.path ?? ""),
      content: String(file.content ?? ""),
    })),
    tasks: body.tasks
      ?.filter((task) => String(task.title ?? "").trim())
      .map((task) => ({
        title: String(task.title ?? "").trim(),
        description: task.description?.trim(),
        dependsOn: task.depends_on,
      })),
  });
  return c.json(result);
});

app.post("/api/projects/:id/tasks/sync", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const body = (await c.req.json()) as {
    tasks?: Array<{ title?: string; description?: string; depends_on?: string[] }>;
  };
  const tasks = (body.tasks ?? [])
    .filter((task) => String(task.title ?? "").trim())
    .map((task) => ({
      title: String(task.title ?? "").trim(),
      description: task.description?.trim(),
      dependsOn: task.depends_on,
    }));
  const result = await syncProjectTasks(repo, projectId, tasks, userId);
  return c.json(result);
});

/** Create an empty GitHub repo and return git push commands (step 1 of folder import). */
app.post("/api/projects/prepare-git-push", async (c) => {
  const userId = await requireViewerId(c);
  const body = (await c.req.json()) as {
    repo_name?: string;
    private?: boolean;
    folder_hint?: string;
  };

  const result = await prepareGitPushRepo(c.env, repoOf(c.env), userId, {
    repoName: String(body.repo_name ?? ""),
    private: body.private === true,
    folderHint: body.folder_hint,
  });
  return c.json(result);
});

/** Agent path: create repo, push supplied files, import project + task tree. */
app.post("/api/projects/bootstrap-from-code", async (c) => {
  const userId = await requireViewerId(c);
  let body: {
    repo_name?: string;
    private?: boolean;
    project_name?: string;
    test_mode?: string;
    files?: Array<{ path?: string; content?: string }>;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    throw badRequest("Invalid JSON body.");
  }

  const result = await bootstrapProjectFromCode(c.env, repoOf(c.env), userId, {
    repoName: String(body.repo_name ?? ""),
    private: body.private === true,
    projectName: body.project_name,
    testMode: body.test_mode === "actions" ? "actions" : "skip",
    files: (body.files ?? []).map((file) => ({
      path: String(file.path ?? ""),
      content: String(file.content ?? ""),
    })),
  });
  return c.json(result);
});

/** Push local files to a new GitHub repo (step 1 of local import). */
app.post("/api/projects/from-local/push", async (c) => {
  const userId = await requireViewerId(c);
  let body: {
    repo_name?: string;
    private?: boolean;
    files?: Array<{ path?: string; content?: string }>;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    throw badRequest(
      "Upload payload is too large or invalid. node_modules and build folders are excluded — choose your project source folder, not the whole drive.",
    );
  }

  const user = await repoOf(c.env).getUser(userId);
  if (!user?.github_token_enc) {
    throw badRequest("Sign in with GitHub and connect your repos before uploading code.");
  }
  const { decryptSecret } = await import("./lib/crypto.js");
  const { pushLocalCodeToGithub } = await import("./services/upload.js");
  const githubToken = await decryptSecret(
    user.github_token_enc,
    requireSecret(c.env.ENCRYPTION_KEY, "ENCRYPTION_KEY"),
  );

  const result = await pushLocalCodeToGithub({
    repoName: String(body.repo_name ?? ""),
    private: body.private === true,
    githubToken,
    files: (body.files ?? []).map((file) => ({
      path: String(file.path ?? ""),
      content: String(file.content ?? ""),
    })),
  });
  return c.json(result);
});

/** Create a GitHub repo, push local files, and import as a project. */
app.post("/api/projects/from-local", async (c) => {
  const userId = await requireViewerId(c);
  let body: {
    repo_name?: string;
    private?: boolean;
    project_name?: string;
    test_mode?: string;
    files?: Array<{ path?: string; content?: string }>;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    throw badRequest(
      "Upload payload is too large or invalid. node_modules and build folders are excluded — choose your project source folder, not the whole drive.",
    );
  }

  const user = await repoOf(c.env).getUser(userId);
  if (!user?.github_token_enc) {
    throw badRequest("Sign in with GitHub and connect your repos before uploading code.");
  }
  const { decryptSecret } = await import("./lib/crypto.js");
  const githubToken = await decryptSecret(
    user.github_token_enc,
    requireSecret(c.env.ENCRYPTION_KEY, "ENCRYPTION_KEY"),
  );

  const result = await importFromLocalCode(c.env, repoOf(c.env), {
    repoName: String(body.repo_name ?? ""),
    private: body.private === true,
    githubToken,
    userId,
    projectName: body.project_name,
    testMode: body.test_mode === "actions" ? "actions" : "skip",
    files: (body.files ?? []).map((file) => ({
      path: String(file.path ?? ""),
      content: String(file.content ?? ""),
    })),
  });
  return c.json(result);
});

/** Repos visible to the signed-in GitHub user (for the picker UI). */
app.get("/api/github/repos", async (c) => {
  const userId = await requireViewerId(c);
  const user = await repoOf(c.env).getUser(userId);
  if (!user?.github_token_enc) {
    throw badRequest(
      "Connect your GitHub repos first (we only ask for your personal public repos—not organization access).",
    );
  }
  const { decryptSecret } = await import("./lib/crypto.js");
  const { listGithubReposForToken } = await import("./github/client.js");
  const { fetchGithubTokenScopes, tokenHasRepoAccess } = await import("./auth/github-oauth.js");
  const githubToken = await decryptSecret(
    user.github_token_enc,
    requireSecret(c.env.ENCRYPTION_KEY, "ENCRYPTION_KEY"),
  );
  const scopes = await fetchGithubTokenScopes(githubToken);
  if (!tokenHasRepoAccess(scopes)) {
    throw badRequest(
      "Grant repo access to list your repositories. Use Connect GitHub repos—we never request organization access.",
    );
  }
  const repos = await listGithubReposForToken(githubToken, {
    githubLogin: user.github_login ?? undefined,
  });
  return c.json({ repos });
});

app.get("/api/projects/:id/context", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireLiveMembership(c.env, repo, projectId, userId);
  return c.json(await getProjectContext(c.env, repo, projectId));
});

app.get("/api/projects/:id/board", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  const project = await requireLiveMembership(c.env, repo, projectId, userId);
  const view = await loadGraph(repo, projectId);
  const members = await repo.listMembers(projectId);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const tokens = await repo.listApiTokens(userId);
  const viewerRole = await repo.getMemberRole(projectId, userId);
  const versions = await repo.listVersions(projectId);
  const features = await repo.listFeatures(projectId);
  const bySlug = new Map(features.map((feature) => [feature.id, feature.slug]));
  const recentPushes = (await repo.listPushes(projectId)).slice(0, 15);
  const pendingInvites = await repo.listPendingInvitesForProject(projectId);
  const mcpUrl = `${publicUrl(c.env)}/mcp`;
  const projectUrl = `${publicUrl(c.env)}/projects/${projectId}`;
  const pushKit = buildPushKit({
    projectId: project.id,
    projectUrl,
    repoUrl: project.repo_url,
    repoName: project.repo_name,
    mcpUrl,
    hasMcpToken: tokens.length > 0,
  });

  return c.json({
    viewer: { role: viewerRole ?? "member" },
    project: {
      id: project.id,
      name: project.name,
      repo_url: project.repo_url,
      repo_name: project.repo_name,
      current_version: project.current_version,
      default_branch: project.default_branch,
      test_mode: project.test_mode,
      shared_file_warnings: filterLegacySharedFileWarnings(
        parseJsonArray(project.shared_file_warnings),
      ),
    },
    push_kit: pushKit,
    features: view.features.map((feature) => {
      const assignee = feature.assigned_to ? memberById.get(feature.assigned_to) : null;
      return {
        id: feature.slug,
        internal_id: feature.id,
        title: feature.title,
        description: feature.description,
        status: toPublicStatus(feature.status),
        assigned_to: feature.assigned_to,
        assigned_name: assignee?.display_name ?? null,
        assigned_github: assignee?.github_login ?? null,
        assigned_avatar: assignee?.avatar_url ?? null,
        scope_notes: feature.scope_notes,
        depends_on: feature.dependsOn,
        blocked_by: feature.dependsOn.filter((dep) => !view.mergedSlugs.has(dep)),
        test_spec: feature.test_spec,
      };
    }),
    members: members.map((m) => ({
      id: m.id,
      display_name: m.display_name,
      github_login: m.github_login,
      avatar_url: m.avatar_url,
      role: m.role,
    })),
    pending_invites: pendingInvites.map((invite) => ({
      id: invite.id,
      invitee_id: invite.invitee_user_id,
      invitee_name: invite.invitee_name,
      invitee_github: invite.invitee_github,
      invitee_avatar: invite.invitee_avatar,
      role: invite.role,
      created_at: invite.created_at,
    })),
    mcp: {
      url: mcpUrl,
      has_token: tokens.length > 0,
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        created_at: t.created_at,
        last_used_at: t.last_used_at,
      })),
    },
    workflow_path: WORKFLOW_PATH,
    versions: versions.slice(0, 20).map((version) => ({
      version: version.version_number,
      commit_sha: version.commit_sha,
      created_by_feature: version.created_by_feature_id
        ? bySlug.get(version.created_by_feature_id) ?? null
        : null,
      changed_paths: parseJsonArray(version.changed_paths),
      created_at: version.created_at,
    })),
    pushes: recentPushes.map((push) => {
      const actor = push.created_by ? memberById.get(push.created_by) : null;
      return {
        push_id: push.id,
        feature_id: bySlug.get(push.feature_id) ?? push.feature_id,
        status: push.status,
        stage: push.stage,
        based_on_version: push.based_on_version,
        merged_version: push.merged_version,
        changed_paths: parseJsonArray(push.changed_paths),
        error: push.error,
        created_at: push.created_at,
        created_by: push.created_by,
        created_by_name: actor?.display_name ?? null,
        created_by_github: actor?.github_login ?? null,
        created_by_avatar: actor?.avatar_url ?? null,
      };
    }),
  });
});

app.delete("/api/projects/:id", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const role = await repo.getMemberRole(projectId, userId);
  if (role !== "owner") throw forbidden("Only project owners can delete a project.");
  await repo.deleteProject(projectId);
  return c.json({
    deleted: true,
    github_untouched: true,
    message:
      "Project removed from VibeHub. Your GitHub repository was not deleted or modified.",
  });
});

app.post("/api/projects/:id/members", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const role = await repo.getMemberRole(projectId, userId);
  if (role !== "owner") throw forbidden("Only project owners can invite members.");
  const body = (await c.req.json()) as { github_login?: string; role?: string };
  const login = String(body.github_login ?? "").trim();
  if (!login) throw badRequest("github_login is required.");
  const invitee = await repo.getUserByGithubLogin(login);
  if (!invitee) {
    throw badRequest(`${login} has not signed in to VibeHub yet. Ask them to sign in first.`);
  }
  const existingRole = await repo.getMemberRole(projectId, invitee.id);
  if (existingRole) throw badRequest(`${login} is already on this project.`);
  const pending = await repo.getPendingInvite(projectId, invitee.id);
  if (pending) throw badRequest(`${login} already has a pending invite.`);
  const memberRole = body.role === "owner" ? "owner" : "member";
  let invite;
  try {
    invite = await repo.createProjectInvite({
      projectId,
      inviteeUserId: invitee.id,
      invitedBy: userId,
      role: memberRole,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INVITE_PENDING") {
      throw badRequest(`${login} already has a pending invite.`);
    }
    throw err;
  }
  const inviter = await repo.getUser(userId);
  return c.json({
    invite: {
      id: invite.id,
      status: invite.status,
      role: invite.role,
      invitee: {
        id: invitee.id,
        display_name: invitee.display_name,
        github_login: invitee.github_login,
        avatar_url: invitee.avatar_url,
      },
      invited_by_name: inviter?.display_name ?? null,
      created_at: invite.created_at,
    },
  });
});

app.get("/api/invites", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const invites = await repo.listInvitesForUser(userId);
  return c.json({
    invites: invites.map((invite) => ({
      id: invite.id,
      project_id: invite.project_id,
      project_name: invite.project_name,
      role: invite.role,
      inviter_name: invite.inviter_name,
      inviter_github: invite.inviter_github,
      created_at: invite.created_at,
    })),
  });
});

app.post("/api/invites/:id/accept", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const inviteId = c.req.param("id");
  const invite = await repo.getInvite(inviteId);
  if (!invite) throw notFound("Invite not found.");
  if (invite.invitee_user_id !== userId) throw forbidden("This invite is not for you.");
  if (invite.status !== "pending") throw badRequest("This invite is no longer pending.");
  const existingRole = await repo.getMemberRole(invite.project_id, userId);
  if (existingRole) {
    await repo.respondToInvite(inviteId, "accepted");
    return c.json({ project_id: invite.project_id, already_member: true });
  }
  const updated = await repo.respondToInvite(inviteId, "accepted");
  if (!updated) throw badRequest("Could not accept invite.");
  await repo.addMember(invite.project_id, userId, invite.role);
  return c.json({ project_id: invite.project_id, accepted: true });
});

app.post("/api/invites/:id/decline", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const inviteId = c.req.param("id");
  const invite = await repo.getInvite(inviteId);
  if (!invite) throw notFound("Invite not found.");
  if (invite.invitee_user_id !== userId) throw forbidden("This invite is not for you.");
  if (invite.status !== "pending") throw badRequest("This invite is no longer pending.");
  await repo.respondToInvite(inviteId, "declined");
  return c.json({ declined: true });
});

app.delete("/api/projects/:id/members/:memberId", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  const memberId = c.req.param("memberId");
  await requireMembership(repo, projectId, userId);
  const viewerRole = await repo.getMemberRole(projectId, userId);
  const isSelf = memberId === userId;
  if (!isSelf && viewerRole !== "owner") {
    throw forbidden("Only owners can remove other members.");
  }
  const targetRole = await repo.getMemberRole(projectId, memberId);
  if (!targetRole) throw notFound("Member not found.");
  const members = await repo.listMembers(projectId);
  const ownerCount = members.filter((member) => member.role === "owner").length;
  if (targetRole === "owner" && ownerCount <= 1) {
    throw badRequest("This project needs at least one owner.");
  }
  await repo.removeMember(projectId, memberId);
  return c.json({ removed: true });
});

app.post("/api/projects/:id/test-mode", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const body = (await c.req.json()) as { test_mode?: string };
  const testMode: TestMode = body.test_mode === "actions" ? "actions" : "skip";
  await repo.setTestMode(projectId, testMode);
  return c.json({ test_mode: testMode });
});

app.post("/api/projects/:id/repo", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);

  const body = (await c.req.json()) as { repo_url?: string };
  const repoUrl = String(body.repo_url ?? "").trim();
  if (!repoUrl) throw badRequest("repo_url is required.");

  const user = await repo.getUser(userId);
  if (!user?.github_token_enc) {
    throw badRequest(
      "Your VibeHub account has no GitHub token. Sign in with GitHub (not local dev login) to connect a repo.",
    );
  }
  const { decryptSecret } = await import("./lib/crypto.js");
  const githubToken = await decryptSecret(
    user.github_token_enc,
    requireSecret(c.env.ENCRYPTION_KEY, "ENCRYPTION_KEY"),
  );

  await connectRepo(c.env, repo, projectId, { repoUrl, githubToken });
  return c.json({ connected: true, repo_url: repoUrl });
});

app.get("/api/projects/:id/pushes", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const features = await repo.listFeatures(projectId);
  const bySlug = new Map(features.map((feature) => [feature.id, feature.slug]));
  return c.json({
    pushes: (await repo.listPushes(projectId)).map((push) => ({
      push_id: push.id,
      feature_id: bySlug.get(push.feature_id) ?? push.feature_id,
      status: push.status,
      stage: push.stage,
      based_on_version: push.based_on_version,
      merged_version: push.merged_version,
      changed_paths: parseJsonArray(push.changed_paths),
      conflict_paths: parseJsonArray(push.conflict_paths),
      reason: push.conflict_reason,
      error: push.error,
      created_at: push.created_at,
    })),
  });
});

app.post("/api/projects/:id/features", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const body = (await c.req.json()) as Record<string, unknown>;
  const assignedTo =
    (typeof body.assignedTo === "string" ? body.assignedTo : null) ??
    (typeof body.assigned_to === "string" ? body.assigned_to : null);
  return c.json(
    await createFeature(repo, projectId, {
      slug: typeof body.slug === "string" ? body.slug : undefined,
      title: typeof body.title === "string" ? body.title : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      scopeNotes: typeof body.scopeNotes === "string" ? body.scopeNotes : undefined,
      dependsOn: Array.isArray(body.dependsOn) ? (body.dependsOn as string[]) : undefined,
      assignedTo,
      manifest: body.manifest,
      testSpec: typeof body.testSpec === "string" ? body.testSpec : body.testSpec === null ? null : undefined,
    }).then((feature) => ({ ...feature, status: toPublicStatus(feature.status) })),
  );
});

app.patch("/api/projects/:id/features/:feature", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const body = (await c.req.json()) as Record<string, unknown>;
  const assignedTo =
    body.assignedTo === undefined && body.assigned_to === undefined
      ? undefined
      : ((typeof body.assignedTo === "string" ? body.assignedTo : null) ??
        (typeof body.assigned_to === "string" ? body.assigned_to : null));
  const updated = await updateFeatureFields(repo, projectId, c.req.param("feature"), {
    slug: typeof body.slug === "string" ? body.slug : undefined,
    title: typeof body.title === "string" ? body.title : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    scopeNotes: typeof body.scopeNotes === "string" ? body.scopeNotes : undefined,
    dependsOn: Array.isArray(body.dependsOn) ? (body.dependsOn as string[]) : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
    assignedTo,
    manifest: body.manifest,
    testSpec: typeof body.testSpec === "string" ? body.testSpec : body.testSpec === null ? null : undefined,
  });
  return c.json({ ...updated, status: toPublicStatus(updated.status) });
});

app.delete("/api/projects/:id/features/:feature", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  await deleteFeatureService(repo, projectId, c.req.param("feature"));
  return c.json({ deleted: true });
});

app.post("/api/projects/:id/features/split", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const body = (await c.req.json()) as { source: string; parts: unknown[] };
  return c.json({
    features: await splitFeature(repo, projectId, body.source, body.parts as never[]),
  });
});

app.post("/api/projects/:id/features/combine", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const body = (await c.req.json()) as { sources: string[]; target: Record<string, unknown> };
  return c.json(await mergeFeatures(repo, projectId, body.sources, body.target as never));
});

app.get("/api/projects/:id/snapshot", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const version = c.req.query("version");
  return c.json(
    await pullSnapshot(c.env, repo, projectId, {
      version: version === undefined ? undefined : Number(version),
    }),
  );
});

app.post("/api/projects/:id/snapshots", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const body = (await c.req.json()) as {
    feature_id?: string;
    description?: string;
    based_on_version?: number;
    changed_files: never[];
  };
  return c.json(
    await saveSnapshot(c.env, repo, projectId, {
      featureIdOrSlug: body.feature_id ?? null,
      description: body.description ?? "",
      basedOnVersion: body.based_on_version,
      changedFiles: body.changed_files,
      userId,
    }),
  );
});

app.post("/api/projects/:id/revert", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const body = (await c.req.json()) as { version: number };
  return c.json(await revertToVersion(c.env, repo, projectId, body.version));
});

app.post("/api/projects/:id/pushes", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const body = (await c.req.json()) as {
    feature_id: string;
    based_on_version: number;
    changed_files: never[];
    manifest?: unknown;
    notes?: string;
    webhook_url?: string;
    confirm_user_approved?: boolean;
    confirm_built_on_latest?: boolean;
  };
  // Same gate as the MCP tools: a push only lands with both confirmations.
  const result = await pushCode(
    c.env,
    repo,
    {
      projectId,
      featureIdOrSlug: body.feature_id,
      basedOnVersion: body.based_on_version,
      changedFiles: body.changed_files,
      manifest: body.manifest,
      notes: body.notes ?? null,
      webhookUrl: body.webhook_url ?? null,
      userId,
      userApproved: body.confirm_user_approved === true,
      confirmedLatestVersion: body.confirm_built_on_latest === true,
    },
    (work) => c.executionCtx.waitUntil(work),
  );
  return c.json(result, 202);
});

app.get("/api/pushes/:pushId", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const push = await repo.getPush(c.req.param("pushId"));
  if (!push) throw badRequest("No such push.");
  await requireMembership(repo, push.project_id, userId);
  return c.json(await getPushStatus(c.env, repo, push.id));
});

/**
 * Called by the GitHub Actions run. Authenticated with the one-time token that
 * was handed to the workflow in the repository_dispatch payload, so it needs no
 * user session.
 */
app.post("/api/pushes/:pushId/build-result", async (c) => {
  const pushId = c.req.param("pushId");
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const repo = repoOf(c.env);
  if (!token || !(await verifyCallbackToken(repo, pushId, token))) {
    throw unauthorized("Invalid or expired build callback token.");
  }
  const body = (await c.req.json()) as { success?: boolean; conclusion?: string; output?: string };
  const success = body.success ?? body.conclusion === "success";
  c.executionCtx.waitUntil(finalizePush(c.env, repo, pushId, { success, output: body.output }));
  return c.json({ received: true });
});

app.post("/api/projects/:id/tokens", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  const projectId = c.req.param("id");
  await requireMembership(repo, projectId, userId);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const token = `vh_${randomToken(32)}`;
  const record = await repo.createApiToken({
    userId,
    name: String(body.name ?? "Cursor MCP").trim() || "Cursor MCP",
    tokenHash: await sha256Hex(token),
  });
  return c.json({
    token,
    id: record.id,
    name: String(body.name ?? "Cursor MCP").trim() || "Cursor MCP",
    mcp_url: `${publicUrl(c.env)}/mcp`,
    note: "Copy this token now. VibeHub will not show it again.",
  });
});

app.delete("/api/projects/:id/tokens/:tokenId", async (c) => {
  const userId = await requireViewerId(c);
  const repo = repoOf(c.env);
  await requireMembership(repo, c.req.param("id"), userId);
  await repo.revokeApiToken(userId, c.req.param("tokenId"));
  return c.json({ revoked: true });
});

app.get("/api/health", (c) => c.json({ ok: true, llm_calls: 0 }));

app.all("*", (c) => c.text("Not found", 404));

function requireSecret(value: string | undefined, name: string): string {
  if (!value) {
    throw new HttpError(
      500,
      `${name} is not configured. Set it with: wrangler secret put ${name}`,
    );
  }
  return value;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * After login, allow relative paths or absolute URLs whose origin is in
 * CORS_ORIGINS / PUBLIC_URL (so a local Vite app can receive the redirect).
 */
function safeNext(next: string, env: Env): string {
  if (next.startsWith("/") && !next.startsWith("//")) return next;
  try {
    const url = new URL(next);
    if (allowedOrigins(env).includes(url.origin)) return next;
  } catch {
    /* ignore */
  }
  return "/";
}

export default app;
