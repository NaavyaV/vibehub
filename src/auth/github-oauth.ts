/**
 * GitHub is VibeHub's identity provider. One login gives us both the user's
 * identity and a token with repo access, which is what the push pipeline needs.
 */

import { HttpError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

/** Sign-in only — identity, no repository or organization access. */
export const GITHUB_LOGIN_SCOPES = "read:user";

/** Personal + public repos for import/push. Avoids the broad private `repo` scope (and org prompts). */
export const GITHUB_REPO_SCOPES = "read:user public_repo";

/** Optional upgrade when a user needs their private personal repositories. */
export const GITHUB_PRIVATE_REPO_SCOPES = "read:user repo";

function requireGithubOAuth(env: AppEnv): { clientId: string; clientSecret: string } {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new HttpError(
      503,
      "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (wrangler secret put), and register the callback URL on your GitHub OAuth App.",
    );
  }
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
}

export function githubAuthorizeUrl(
  env: AppEnv,
  redirectUri: string,
  state: string,
  scopes: string = GITHUB_LOGIN_SCOPES,
): string {
  const { clientId } = requireGithubOAuth(env);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function fetchGithubTokenScopes(token: string): Promise<string[]> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "VibeHub",
    },
  });
  if (!response.ok) return [];
  return (response.headers.get("X-OAuth-Scopes") ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function tokenHasRepoAccess(scopes: string[]): boolean {
  return scopes.includes("repo") || scopes.includes("public_repo");
}

export function tokenHasPrivateRepoAccess(scopes: string[]): boolean {
  return scopes.includes("repo");
}

export async function exchangeGithubCode(
  env: AppEnv,
  code: string,
  redirectUri: string,
): Promise<string> {
  const { clientId, clientSecret } = requireGithubOAuth(env);
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body = (await response.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) {
    throw new HttpError(
      502,
      `GitHub token exchange failed: ${body.error_description ?? "no access_token"}. Check the OAuth App callback URL matches this deployment.`,
    );
  }
  return body.access_token;
}

export async function fetchGithubUser(
  token: string,
): Promise<{ login: string; name: string | null; avatar_url: string | null }> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "VibeHub",
    },
  });
  if (!response.ok) throw new Error(`Could not read the GitHub user profile (${response.status})`);
  return (await response.json()) as { login: string; name: string | null; avatar_url: string | null };
}
