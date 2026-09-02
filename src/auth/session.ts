/**
 * Signed, stateless session cookie for the web UI. The same signed identity is
 * what the OAuth authorize page uses to know who is granting access to an MCP
 * client, so the UI login and the MCP OAuth flow share one notion of "user".
 */

import { hmacSign, safeEqual } from "../lib/crypto.js";
import type { AppEnv } from "../types.js";

const COOKIE_NAME = "vibehub_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

function requireSessionSecret(env: AppEnv): string {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
  return env.SESSION_SECRET;
}

export async function createSessionCookie(env: AppEnv, userId: string, secure: boolean): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const payload = `${userId}.${expiresAt}`;
  const signature = await hmacSign(payload, requireSessionSecret(env));
  const value = `${payload}.${signature}`;
  // SameSite=None so a local Vite SPA (localhost) can call the hosted API with credentials.
  const attributes = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    secure ? "SameSite=None" : "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie(secure = false): string {
  const attributes = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    secure ? "SameSite=None" : "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export async function userIdFromRequest(env: AppEnv, request: Request): Promise<string | null> {
  const raw = readCookie(request.headers.get("Cookie"), COOKIE_NAME);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAt, signature] = parts as [string, string, string];
  const expected = await hmacSign(`${userId}.${expiresAt}`, requireSessionSecret(env));
  if (!safeEqual(expected, signature)) return null;
  if (Number(expiresAt) * 1000 < Date.now()) return null;
  return userId;
}
