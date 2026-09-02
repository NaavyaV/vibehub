/**
 * Smoke test against a running `wrangler dev`. Exercises the full path an agent
 * takes: sign in, import a plan, edit the graph, then push through the gate with
 * the build gate set to "skip" so no repo is required for the metadata flow.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */

const base = process.argv[2] ?? "http://localhost:8787";
let cookie = "";
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function request(method, path, { body, form, redirect = "manual" } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, { method, headers, body: payload, redirect });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    const value = setCookie.split(";")[0];
    if (value.startsWith("vibehub_session=") && !value.endsWith("=")) cookie = value;
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* html or plain text */
  }
  return { status: response.status, text, json, location: response.headers.get("location") };
}

const plan = {
  project_name: "Smoke Storefront",
  features: [
    { id: "cart", title: "Cart", scope_notes: "src/features/cart/**", manifest: { routes: ["/cart"] } },
    {
      id: "checkout",
      title: "Checkout",
      depends_on: ["cart"],
      scope_notes: "src/features/checkout/**",
      manifest: { routes: ["/checkout"], deps: ["stripe@^14.0.0"] },
      test_spec: "Checkout submits an order.",
    },
  ],
  shared_file_warnings: ["Both features format currency."],
};

const health = await request("GET", "/api/health");
record("health endpoint reports zero LLM calls", health.json?.llm_calls === 0, JSON.stringify(health.json));

const landing = await request("GET", "/");
record("landing page renders", landing.status === 200 && landing.text.includes("VibeHub"));
record(
  "scoping prompt is shipped verbatim in the page",
  landing.text.includes("You are helping a team scope a software project"),
);

const metadata = await request("GET", "/.well-known/oauth-authorization-server");
record(
  "OAuth authorization server metadata is published",
  metadata.status === 200 && typeof metadata.json?.authorization_endpoint === "string",
  metadata.json?.authorization_endpoint,
);

const resourceMetadata = await request("GET", "/.well-known/oauth-protected-resource/mcp");
record(
  "protected resource metadata is published for /mcp",
  resourceMetadata.status === 200 && Array.isArray(resourceMetadata.json?.authorization_servers),
);

const unauthenticatedMcp = await request("POST", "/mcp", {
  body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
});
record(
  "unauthenticated MCP request is rejected with 401",
  unauthenticatedMcp.status === 401,
  `status ${unauthenticatedMcp.status}`,
);

const login = await request("POST", "/auth/dev-login", { form: {} });
record("dev login issues a session", login.status === 302 && cookie.length > 0);

const badPlan = await request("POST", "/api/import", {
  body: { plan: { project_name: "Broken", features: [{ id: "checkout", title: "C", depends_on: ["ghost"] }] } },
});
record(
  "an unresolvable dependency is rejected with a specific message",
  badPlan.status === 400 &&
    String(badPlan.json?.details?.[0]).includes("depends on 'ghost' which doesn't exist"),
  String(badPlan.json?.details?.[0] ?? ""),
);

const cyclic = await request("POST", "/api/import", {
  body: {
    plan: {
      project_name: "Loop",
      features: [
        { id: "a", title: "A", depends_on: ["b"] },
        { id: "b", title: "B", depends_on: ["a"] },
      ],
    },
  },
});
record(
  "a circular dependency is rejected",
  cyclic.status === 400 && String(cyclic.json?.details?.[0]).startsWith("Circular dependency"),
  String(cyclic.json?.details?.[0] ?? ""),
);

const fenced = ["Here is the plan:", "```json", JSON.stringify(plan), "```"].join("\n");
const imported = await request("POST", "/api/import", { body: { plan_text: fenced, test_mode: "skip" } });
const projectId = imported.json?.project_id;
record("a fenced plan imports and creates a project", Boolean(projectId), projectId ?? imported.text);
record(
  "shared file warnings are carried through as a heads-up",
  imported.json?.shared_file_warnings?.length === 1,
);

const context = await request("GET", `/api/projects/${projectId}/context`);
const statuses = Object.fromEntries((context.json?.features ?? []).map((f) => [f.id, f.status]));
record(
  "dependent feature starts blocked, independent one available",
  statuses.cart === "available" && statuses.checkout === "blocked",
  JSON.stringify(statuses),
);
record("project starts at version 0", context.json?.project?.current_version === 0);

const created = await request("POST", `/api/projects/${projectId}/features`, {
  body: { slug: "receipts", title: "Receipts", dependsOn: ["checkout"], scopeNotes: "src/features/receipts/**" },
});
record("a feature can be added after import", created.json?.slug === "receipts" && created.json?.status === "blocked");

const cycleEdit = await request("PATCH", `/api/projects/${projectId}/features/cart`, {
  body: { dependsOn: ["receipts"] },
});
record(
  "an edit that would create a cycle is refused",
  cycleEdit.status === 400 && String(cycleEdit.json?.error).startsWith("Circular dependency"),
  String(cycleEdit.json?.error ?? ""),
);

const split = await request("POST", `/api/projects/${projectId}/features/split`, {
  body: {
    source: "cart",
    parts: [
      { slug: "cart-ui", title: "Cart UI", scopeNotes: "src/features/cart-ui/**" },
      { slug: "cart-store", title: "Cart store", scopeNotes: "src/features/cart-store/**" },
    ],
  },
});
const afterSplit = await request("GET", `/api/projects/${projectId}/context`);
const checkoutDeps = afterSplit.json?.features?.find((f) => f.id === "checkout")?.depends_on;
record(
  "splitting a feature repoints its dependents at every part",
  split.status === 200 && JSON.stringify(checkoutDeps) === JSON.stringify(["cart-store", "cart-ui"]),
  JSON.stringify(checkoutDeps),
);

const noRepoPush = await request("POST", `/api/projects/${projectId}/pushes`, {
  body: {
    feature_id: "cart-ui",
    based_on_version: 0,
    changed_files: [{ path: "src/features/cart-ui/index.ts", action: "add", content: "export {};\n" }],
  },
});
record("push_feature returns a push_id immediately", noRepoPush.status === 202 && Boolean(noRepoPush.json?.push_id));
record("push_feature returns status testing", noRepoPush.json?.status === "testing");

await new Promise((resolve) => setTimeout(resolve, 700));
const pushStatus = await request("GET", `/api/pushes/${noRepoPush.json?.push_id}`);
record(
  "a push with no connected repo fails with an actionable message",
  pushStatus.json?.status === "failed" && /GitHub repo/.test(String(pushStatus.json?.error)),
  String(pushStatus.json?.error ?? ""),
);

const generatedWrite = await request("POST", `/api/projects/${projectId}/pushes`, {
  body: {
    feature_id: "cart-ui",
    based_on_version: 0,
    changed_files: [{ path: "src/generated/routes.ts", action: "modify", content: "hacked\n" }],
  },
});
record(
  "writing a generated file is rejected synchronously",
  generatedWrite.status === 400 &&
    String(generatedWrite.json?.details?.[0]).includes("generated by VibeHub"),
  String(generatedWrite.json?.details?.[0] ?? ""),
);

const projectPage = await request("GET", `/projects/${projectId}`);
record(
  "project page renders the graph, MCP URL, and warnings",
  projectPage.status === 200 &&
    projectPage.text.includes("Task graph") &&
    projectPage.text.includes(`${base}/mcp`) &&
    projectPage.text.includes("Both features format currency."),
);

const workflow = await request("GET", "/workflow");
record(
  "the build-gate workflow is downloadable",
  workflow.status === 200 && workflow.text.includes("repository_dispatch"),
);

const otherUserAccess = await (async () => {
  const saved = cookie;
  cookie = "";
  const anonymous = await request("GET", `/api/projects/${projectId}/context`);
  cookie = saved;
  return anonymous;
})();
record(
  "project context requires authentication",
  otherUserAccess.status === 401,
  `status ${otherUserAccess.status}`,
);

// ---- MCP over a personal access token -------------------------------------

const tokenPage = await request("POST", `/projects/${projectId}/tokens`, { form: { name: "smoke" } });
const mcpToken = new URL(tokenPage.location ?? "", base).searchParams.get("token");
record("a personal access token can be generated", Boolean(mcpToken?.startsWith("vh_")));

async function mcp(token, message, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const text = await response.text();
  // Streamable HTTP may answer as SSE; pull the first data frame out.
  const frame = text.includes("data:") ? text.split("data:")[1]?.split("\n")[0] : text;
  let json = null;
  try {
    json = frame ? JSON.parse(frame.trim()) : null;
  } catch {
    /* leave null */
  }
  return { status: response.status, json, text, sessionId: response.headers.get("mcp-session-id") };
}

const initialized = await mcp(mcpToken, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
});
record(
  "MCP initialize succeeds with a bearer token",
  initialized.status === 200 && initialized.json?.result?.serverInfo?.name === "vibehub",
  initialized.json?.result?.serverInfo?.name ?? `status ${initialized.status}`,
);

const session = initialized.sessionId ?? undefined;
if (session) {
  await mcp(mcpToken, { jsonrpc: "2.0", method: "notifications/initialized" }, session);
}

const tools = await mcp(mcpToken, { jsonrpc: "2.0", id: 2, method: "tools/list" }, session);
const toolNames = (tools.json?.result?.tools ?? []).map((tool) => tool.name).sort();
record(
  "every documented MCP tool is registered",
  [
    "get_my_task",
    "get_project_context",
    "get_push_status",
    "pull_snapshot",
    "push_feature",
    "report_blocker",
    "save_snapshot",
  ].every((name) => toolNames.includes(name)),
  toolNames.join(", "),
);

const toolCall = await mcp(
  mcpToken,
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_project_context", arguments: { project_id: projectId } },
  },
  session,
);
const toolText = toolCall.json?.result?.content?.[0]?.text ?? "";
let toolPayload = null;
try {
  toolPayload = JSON.parse(toolText);
} catch {
  /* leave null */
}
record(
  "an MCP tool call returns the project context",
  toolPayload?.project?.id === projectId,
  toolPayload?.project?.name ?? toolText.slice(0, 120),
);

const wrongProject = await mcp(
  mcpToken,
  {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "get_project_context", arguments: { project_id: "prj_does_not_exist" } },
  },
  session,
);
record(
  "an MCP tool refuses a project the caller is not a member of",
  wrongProject.json?.result?.isError === true &&
    String(wrongProject.json?.result?.content?.[0]?.text).includes("do not have access"),
  String(wrongProject.json?.result?.content?.[0]?.text ?? "").slice(0, 90),
);

const badToken = await mcp("vh_not_a_real_token", { jsonrpc: "2.0", id: 5, method: "tools/list" });
record("an unknown bearer token is rejected", badToken.status === 401, `status ${badToken.status}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
