/**
 * API base:
 * - Local Vite (`npm run dev`): empty → same-origin proxy to hosted Worker
 * - Production SPA on Worker: empty → same origin
 * - Optional override: VITE_API_URL for direct cross-origin calls
 */
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    const body = data as { error?: string; details?: unknown } | null;
    throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status, body?.details);
  }
  return data as T;
}

export function githubLoginUrl(next?: string): string {
  // Prefer a same-origin relative path so the post-login cookie redirect stays simple.
  const destination =
    next ??
    (typeof window !== "undefined" && window.location.origin.includes("workers.dev")
      ? "/"
      : `${window.location.origin}/`);
  return `${API_BASE}/auth/github?next=${encodeURIComponent(destination)}`;
}

/** Grants access to repos you personally own (public). No organization access. */
export function githubRepoAuthUrl(next?: string): string {
  const destination =
    next ??
    (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/");
  return `${API_BASE}/auth/github/repos?next=${encodeURIComponent(destination)}`;
}

/** Optional upgrade for private personal repos. Deny org access on GitHub's screen. */
export function githubPrivateRepoAuthUrl(next?: string): string {
  const destination =
    next ??
    (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/");
  return `${API_BASE}/auth/github/private?next=${encodeURIComponent(destination)}`;
}
