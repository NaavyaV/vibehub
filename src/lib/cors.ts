/** CORS for the Vite SPA on localhost talking to the hosted Worker. */

export function allowedOrigins(env: { CORS_ORIGINS?: string; PUBLIC_URL?: string }): string[] {
  const listed = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const pub = env.PUBLIC_URL?.replace(/\/$/, "");
  if (pub) listed.push(pub);
  return [...new Set(listed)];
}

export function corsHeaders(
  request: Request,
  env: { CORS_ORIGINS?: string; PUBLIC_URL?: string },
): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function withCors(
  response: Response,
  request: Request,
  env: { CORS_ORIGINS?: string; PUBLIC_URL?: string },
): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
