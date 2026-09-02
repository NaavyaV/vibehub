# VibeHub

A version-control coordination layer for teams whose code is written primarily by AI coding agents.
It replaces Git branching and merging with a single source of truth, a dependency-aware task graph,
and a **deterministic, non-AI merge gate**.

Your agents write all the code, locally. VibeHub decides what lands.

**VibeHub makes zero LLM calls, anywhere.** Scoping happens in whatever model the team already uses,
via a fixed prompt VibeHub ships as static text; VibeHub only validates and parses the result.
Merging is pure path arithmetic and code generation.

---

## The three ideas that make it work

**1. Conflicts are decided by file path, not by how stale you are.**
Every merged version records the paths it wrote. A push declares the version it was based on. VibeHub
unions the paths written by every version since, and intersects that with the push. Empty
intersection means it applies cleanly — being forty versions behind is fine. A non-empty
intersection is rejected, and only the overlapping files come back.

**2. Nobody hand-edits shared files.**
A feature never touches the router index, the app root, or `package.json`. It declares a **manifest**
— routes it exposes, symbols it exports, npm packages it needs. VibeHub generates the shared wiring
from the union of all merged manifests. The generation is order-independent and byte-stable, which is
what makes it safe to own those files outright. Two features declaring the same route, or the same
package at different versions, is reported as a conflict rather than resolved by guessing.

**3. The gate is "does it build".**
A push is committed to a staging ref, GitHub Actions builds it, and only a green build fast-forwards
the default branch and bumps the version. A feature's `test_spec` runs but is advisory — it never
blocks a merge.

---

## Architecture

| Concern | Implementation |
| --- | --- |
| API + MCP host | Cloudflare Worker |
| SPA UI | Vite React app in `web/`, served as Worker assets |
| Metadata | Cloudflare D1 — never file content |
| Push payloads | KV (`PUSH_PAYLOADS`) so Stage A survives eviction |
| Code | The project's GitHub repo, via the REST API |
| Agent interface | Remote MCP server (Cloudflare Agents SDK) at `/mcp`, OAuth 2.1 |
| Build gate | GitHub Actions via `repository_dispatch`, reporting to a callback endpoint |
| Auth | GitHub OAuth only (optional `DEV_LOGIN` for local) |
| Model calls | None |

```
src/
  index.ts              OAuth provider wraps /mcp; everything else goes to app.ts
  app.ts                UI routes, JSON API, GitHub login, consent page, build callback
  domain/               Pure logic, no I/O — the independently testable core
    import.ts             plan validation: schema, dependency resolution, cycle detection
    graph.ts              cycle detection, topological order, unlock computation
    conflicts.ts          path-based conflict detection, changed-file validation
    manifest.ts           manifest normalization and union, conflict reporting
    codegen.ts            deterministic generation of shared wiring + package.json merge
  services/             Orchestration shared by the MCP tools and the REST API
    push.ts               the two-stage push gate
    projects.ts           import, agent context, repo connection, snapshots, revert
    features.ts           task CRUD with validate-before-write
  github/client.ts      REST wrapper: trees, blobs, multi-file commits, dispatch
  mcp/server.ts         the MCP tools
  db/repo.ts            D1 queries
  ui/                   server-rendered HTML
migrations/0001_init.sql
```

The `domain/` modules are pure functions over plain data, so each piece is testable without a
database, a network, or a Worker.

---

## Setup

Requires Node 20+ and a Cloudflare account.

```bash
npm install
npm install --prefix web
```

### 1. Create the resources

```bash
npx wrangler d1 create vibehub
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create PUSH_PAYLOADS
```

Put the ids into `wrangler.toml` (`DB`, `OAUTH_KV`, `PUSH_PAYLOADS`).

### 2. Create a GitHub OAuth app

GitHub is the **only** production login (no email/password). One sign-in covers identity and repo access.

At <https://github.com/settings/developers>, create an OAuth App:

| Field | Value |
| --- | --- |
| Homepage URL | `https://vibehub.<your-subdomain>.workers.dev` |
| Authorization callback URL | `https://vibehub.<your-subdomain>.workers.dev/auth/github/callback` |

For local API work (`npm run dev:api`), also add `http://localhost:8787/auth/github/callback`.

Scopes used: `read:user` and `repo`.

### 3. Set secrets

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ENCRYPTION_KEY   # base64 32 bytes, see below
npx wrangler secret put SESSION_SECRET   # any long random string
```

Generate the encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set `PUBLIC_URL` in `wrangler.toml` to the deployed origin (update after the first deploy if the workers.dev hostname differs).

### 4. Migrate, build UI, deploy

```bash
npm run db:migrate:remote
npm run deploy          # builds web/dist then wrangler deploy
```

### Local development

**Frontend against hosted API** (default):

```bash
cp .dev.vars.example .dev.vars   # secrets for optional local API only
npm run dev                      # Vite on http://localhost:5173 → proxies to PUBLIC_URL
```

Vite proxies `/api`, `/auth`, `/mcp`, etc. to `VITE_API_URL` (default: the workers.dev URL in `web/vite.config.ts`). After GitHub login on the hosted Worker, set the OAuth `next` redirect back to `http://localhost:5173/` (the SPA does this automatically).

**Local Worker API** (optional):

```bash
npm run db:migrate:local
npm run dev:api                  # wrangler on :8787
```

`DEV_LOGIN=1` enables local-only “Local dev login” in the SPA / `POST /auth/dev-login`. That user has **no** GitHub token, so repo import/connect will not work until you use real GitHub OAuth.

---

## Using it

### 1. Sign in with GitHub

Open the deployed site (or `npm run dev`) and click **Continue with GitHub**.

### 2. Add your project

- **Vibecoding with AI:** connect MCP once, then tell your agent *“Push this to VibeHub.”* The agent calls `push_to_vibehub`.
- **Already on GitHub:** pick your repo in the web UI.
- **Local folder:** git push or ask your agent (advanced paths in the UI).

### 3. Connect agents (MCP)

On the project page: create an MCP token, then add the server URL (`/mcp`) with `Authorization: Bearer vh_…`. Works in Cursor, Claude Desktop, or any MCP client — the bootstrap tools (`prepare_git_push`, `import_project_repo`) are available before you have a project.

### 4. Assign work on the task tree

Claim features on the visual graph, then let agents pull / push through the gate.

### 5. The agent loop

```
get_my_task      what to build, the version to base on, what your dependencies expose
pull_snapshot    read the repo at that version
   …agent writes code locally…
push_feature     submit only the files you changed → { push_id, status: "testing" }
get_push_status  poll → merged | conflict | failed
```

On `conflict`, the response contains the current content of *only* the overlapping files. The local
agent re-merges those narrowly and pushes again. VibeHub never attempts the merge itself.

---

## MCP tools

| Tool | Purpose |
| --- | --- |
| `push_to_vibehub(repo_name?, files[]?, repo_url?, …)` | **Start here.** User says "push to VibeHub" — agent uploads files, creates project + task tree |
| `prepare_git_push(repo_name, private?, folder_path?)` | Create an empty GitHub repo; returns `git_commands` to push from a local folder |
| `import_project_repo(repo_url, project_name?)` | Connect a repo after push; auto-build task tree; returns `agent_guide` |
| `bootstrap_project_from_code(repo_name, files[], private?, project_name?)` | One-shot when git is unavailable: create repo, push files, import |
| `get_project_context(project_id)` | Requirements, current version, every feature with status and dependencies, the generated shared wiring, recent version history |
| `get_my_task(project_id, user_id?)` | Assigned features with `scope_notes`, manifest shape, the version to base a push on, and each dependency's exposed interface |
| `pull_snapshot(project_id, version?, paths?)` | Read-only repo tree at a version |
| `push_feature(project_id, feature_id, based_on_version, changed_files, manifest?, notes?, webhook_url?)` | Returns `{push_id, status}` immediately |
| `get_push_status(push_id)` | Poll; on conflict returns the overlapping files' current content |
| `report_blocker(project_id, feature_id, reason)` | Flags for human attention, no auto-retry |
| `save_snapshot(project_id, feature_id?, description, changed_files, based_on_version?)` | Parks unmerged work on a side branch |

`changed_files` entries are `{path, action: "add" | "modify" | "delete", content?, encoding?}` — the
files you changed, never a full snapshot.

Every tool checks that the caller is a member of the project. That is the only permission in this
MVP: you are on the project or you are not.

## HTTP API

The same operations, for scripting and for testing pieces in isolation.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/import` | `{plan_text}` or `{plan}`, plus `test_mode` |
| `POST` | `/api/projects/prepare-git-push` | `{repo_name, private?, folder_hint?}` — empty repo + git commands |
| `POST` | `/api/projects/from-existing` | `{repo_url, project_name?}` — import after git push |
| `POST` | `/api/projects/bootstrap-from-code` | `{repo_name, files[], ...}` — agent one-shot bootstrap |
| `POST` | `/api/projects/from-local/push` | Browser upload step 1 (fallback) |
| `GET` | `/api/projects/:id/context` | |
| `POST` `PATCH` `DELETE` | `/api/projects/:id/features[/:feature]` | Task CRUD |
| `POST` | `/api/projects/:id/features/split` | `{source, parts[]}` |
| `POST` | `/api/projects/:id/features/combine` | `{sources[], target}` |
| `GET` | `/api/projects/:id/snapshot?version=N` | |
| `POST` | `/api/projects/:id/snapshots` | Park work |
| `POST` | `/api/projects/:id/revert` | `{version}` |
| `POST` | `/api/projects/:id/pushes` | REST equivalent of `push_feature` |
| `GET` | `/api/pushes/:pushId` | |
| `POST` | `/api/pushes/:pushId/build-result` | Called by GitHub Actions with its one-time token |
| `GET` | `/workflow` | The build-gate workflow YAML |

---

## How a push is processed

`push_feature` validates structure, records a `pushes` row, and returns. Structural problems (a bad
path, a write to a generated file, an unknown feature, a `based_on_version` ahead of the project) are
rejected synchronously so the agent gets them immediately. Everything the team must actually react to
arrives through `get_push_status`.

**Stage A** runs in the background:

1. Reject if any dependency has not merged.
2. Union the paths written since `based_on_version`; intersect with the push. Overlap → `conflict`.
3. Merge this feature's manifest with every merged feature's. Disagreement → `conflict`.
4. Regenerate the shared wiring and commit the feature's files plus that wiring to
   `refs/heads/vibehub/push/<push_id>`.
5. Fire `repository_dispatch` at the repo with a one-time callback token. Status stays `testing`.

**Stage B** runs when the Actions callback arrives:

- **Red** → `failed` with the build output. The default branch and `current_version` are untouched.
- **Green** → re-check conflicts against anything that landed while the build ran. If the head moved,
  replay this push onto the new head (reading its own files back out of the staging commit — no code
  content ever enters D1). Then take the version counter with a compare-and-swap, fast-forward the
  branch, record the version, mark the feature merged, and unlock dependents.

The version counter is the concurrency lock: whoever wins the CAS owns the transition from N to N+1
and only then touches the branch. A loser re-checks conflicts against the winner's result and retries.

---

## Generated files

VibeHub owns these. A push that writes one is rejected with a pointer to the manifest.

| Path | Contents |
| --- | --- |
| `src/generated/routes.ts` | `GeneratedRoute[]` with `path`, owning `feature`, and a lazy import — shaped for React Router's `lazy`, but a plain array anything can consume |
| `src/generated/exports.ts` | Barrel re-exporting every declared shared export |
| `src/generated/manifest.json` | Machine-readable union of routes, exports, and dependencies |
| `package.json` | `dependencies` merged from all manifests, sorted; other fields untouched |

Manifest entries accept shorthand or long form:

```json
{
  "routes": ["/checkout", { "path": "/cart", "module": "src/cart/routes.tsx", "export": "CartPage" }],
  "exports": ["CheckoutButton", { "name": "useCart", "from": "src/cart/hooks.ts" }],
  "deps": ["zod", "stripe@^14.0.0", { "name": "@scope/ui", "version": "1.2.3" }]
}
```

Omitted modules default to `src/features/<feature-id>/routes` and `src/features/<feature-id>/index`.
An unpinned dependency (`"zod"`) defers to a pinned one; two different pins conflict.

---

## Testing

```bash
npm run typecheck
npm test          # 72 tests: pure domain logic + D1-backed integration
npm run dev       # in one terminal
npm run smoke     # in another: 29 checks against the running Worker
```

The unit tests cover the import validator, the dependency graph, path-based conflict detection,
manifest merging, and codegen determinism. `test/push.test.ts` drives the entire push gate against an
in-memory GitHub (`test/github-fake.ts`), including clean auto-apply, stale-but-disjoint pushes,
overlapping rejections, manifest conflicts, replay onto a moved head, and build failure leaving the
branch untouched. `scripts/smoke.mjs` exercises the deployed surface: OAuth metadata, the MCP
handshake with a real token, tool registration, tool calls, and access control.

---

## Engineering decisions

Things the spec left open, and why they went this way.

- **`wrangler.toml`** as specified, though Cloudflare now recommends `wrangler.jsonc`. Everything used
  here — D1, Durable Objects, KV, migrations — is expressible in TOML.
- **A KV namespace (`OAUTH_KV`) was added** to the stack. `@cloudflare/workers-oauth-provider`
  requires it for grants, tokens, and clients. It stores no code and no project metadata.
- **GitHub is the identity provider.** One sign-in yields both an identity and a token with repo
  access. A project's repo token is the connecting user's OAuth token, encrypted at rest with
  AES-GCM. A GitHub App installation token would be better for production, since this one is tied to
  one person's account.
- **Tables not in the spec's model:** `users`, `project_members` (needed for "scoped to the projects
  they belong to"), `blockers` (needed for `report_blocker`), `api_tokens`. `features` gained a `slug`
  column because plan ids like `checkout` are only unique within a project, so they cannot be the
  primary key. Every API accepts either the slug or the internal id.
- **`pushes.stage`** (`queued`/`applying`/`building`/`done`) tracks progress within `testing` so that
  `pushes.status` stays exactly the four values the spec names.
- **Commits land on a staging ref first,** then fast-forward on green. The spec's ordering would leave
  a red commit on the branch every agent pulls from. Every step still happens in the specified order.
- **Replay instead of rejection when the head moves mid-build.** The push's files are already in the
  staging commit, so they can be replayed onto the new head without D1 ever holding code.
- **Push file contents live only in memory during stage A.** This is the cost of "never store code
  content in the DB": if the Worker is evicted mid-stage-A, the push is marked `failed` with a message
  telling the agent to re-push, rather than being silently resumable.
- **Per-project `test_mode`** (`actions` | `skip`). `skip` accepts any cleanly-applying push, which
  makes the merge logic testable without CI and gives repos without the workflow a usable path.
- **An eighth MCP tool, `save_snapshot`,** because snapshot-parking is one of the required flows and
  is otherwise unreachable from an agent. `pull_snapshot` gained an optional `paths` filter, since
  large files are omitted from the full tree and need a way to be fetched individually.
- **Personal access tokens alongside OAuth,** via the provider's `resolveExternalToken` hook, for MCP
  clients that cannot run a browser flow. Both paths produce identical tool behaviour.
- **Hono** is used as the HTTP router. It is a routing library, not a substitution for anything in the
  stack, and the MCP SDK already depends on it.
- **Validation happens before any write.** D1 has no multi-statement transactions, so a rejected edit
  that had already written its dependency rows would corrupt the graph for every later operation.
  Feature mutations build the prospective graph in memory, validate it, and only then persist.
- **Snapshots are git refs** (`refs/heads/vibehub/snapshot/<id>`), so `snapshots.storage_ref` is a
  pointer and not content.
- **Revert creates a new commit reusing the old tree.** History is never rewritten.
- **`pull_snapshot` caps output** at 1.5 MB total and 200 KB per file, and lists binary and oversized
  files without inlining them.

## Known limitations

- `split` and `combine` validate the full resulting graph up front, but the writes themselves are not
  atomic — D1 offers no transaction spanning them.
- Very large repos can return a truncated tree from GitHub; `pull_snapshot` reports
  `truncated_tree: true` when that happens.
- Membership is all-or-nothing per project, by design for this MVP.
- Concurrent pushes are serialized at the version counter, so a burst of simultaneous merges resolves
  one at a time.

## Non-goals

No AI-driven conflict resolution — real file-level conflicts go back to the local agent for a narrow
re-merge. No internal LLM calls of any kind. GitHub only, no Drive or Dropbox. No permissions beyond
project membership. No custom container infrastructure. No mandatory tests.
