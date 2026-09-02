/**
 * Worker entry point.
 *
 * `/mcp` sits behind the OAuth provider. Everything else — the UI, the JSON API,
 * GitHub login, the authorize/consent page, and the GitHub Actions callback —
 * is handled by `app`.
 *
 * VibeHub makes no model calls anywhere in this Worker.
 */

import { OAuthProvider, ExternalTokenError } from "@cloudflare/workers-oauth-provider";

import app, { MCP_SCOPE } from "./app.js";
import { Repo } from "./db/repo.js";
import { sha256Hex } from "./lib/crypto.js";
import { VibeHubMCP } from "./mcp/server.js";
import { publicUrl, type AppEnv, type McpProps } from "./types.js";

export { VibeHubMCP };

const provider = new OAuthProvider<AppEnv>({
  apiHandlers: {
    "/mcp": VibeHubMCP.serve("/mcp", { binding: "VIBEHUB_MCP" }),
  },
  defaultHandler: app as unknown as ExportedHandler<AppEnv>,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,

  scopesSupported: [MCP_SCOPE],

  /**
   * Personal access tokens generated in the UI, for MCP clients that cannot run
   * a browser OAuth flow. They resolve to the same props an OAuth grant does, so
   * every tool behaves identically either way.
   */
  async resolveExternalToken({ token, env, request }) {
    const cleaned = token.trim();
    if (!cleaned.startsWith("vh_")) return null;
    if (
      cleaned.includes("YOUR_TOKEN") ||
      cleaned.includes("PASTE_") ||
      cleaned.length < 12
    ) {
      throw new ExternalTokenError("invalid_token", {
        description:
          "That is not a real VibeHub token. Create one at VibeHub Settings, copy the vh_… value, and paste it into Cursor MCP config (replace vh_YOUR_TOKEN_HERE).",
        statusCode: 401,
      });
    }
    const repo = new Repo(env.DB);
    const record = await repo.findApiToken(await sha256Hex(cleaned));
    if (!record) {
      throw new ExternalTokenError("invalid_token", {
        description:
          "VibeHub token not recognized (wrong, revoked, or from another account). Regenerate at VibeHub Settings and update ~/.cursor/mcp.json, then restart Cursor.",
        statusCode: 401,
      });
    }
    const user = await repo.getUser(record.user_id);
    if (!user) return null;
    await repo.touchApiToken(record.id);
    const props: McpProps = {
      userId: user.id,
      displayName: user.display_name,
      via: "token",
    };
    return { props, audience: canonicalMcpResource(env, request) };
  },
});

/**
 * The audience an external token is valid for. Must match the resource the
 * provider advertises, which is derived from the request when
 * `resourceMetadata.resource` is not statically configured.
 */
function canonicalMcpResource(env: AppEnv, request: Request): string {
  const base = env.PUBLIC_URL ? publicUrl(env) : new URL(request.url).origin;
  return `${base}/mcp`;
}

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
