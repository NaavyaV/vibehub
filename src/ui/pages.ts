import { html, jsonScript, raw, type Raw } from "./html.js";
import { layout } from "./layout.js";
import { SCOPING_PROMPT } from "./scoping-prompt.js";
import type { FeatureWithDeps } from "../db/repo.js";
import { safeManifest } from "../services/features.js";
import type { ProjectRow, SnapshotRow, UserRow, VersionRow } from "../types.js";

interface Viewer {
  id: string;
  displayName: string;
}

function scopingPromptPanel(): Raw {
  return html`<div class="panel">
    <h3>Step 1 — scope it with your own LLM</h3>
    <p class="small muted" style="margin-top:0">
      VibeHub makes no model calls. Copy this prompt into Claude, ChatGPT, Cursor — whatever you
      already use — have the conversation there, then bring back the JSON block it produces.
    </p>
    <div class="copywrap">
      <button class="ghost small" type="button" onclick="copyText(window.VIBEHUB_PROMPT, this)">
        Copy prompt
      </button>
      <pre class="block">${SCOPING_PROMPT}</pre>
    </div>
  </div>`;
}

function importPanel(errors: string[], pasted: string): Raw {
  return html`<div class="panel">
    <h3>Step 2 — paste the JSON block</h3>
    ${errors.length > 0
      ? html`<div class="err" style="margin-bottom:12px">
          <strong>This plan was not imported.</strong> Fix it in your LLM conversation and paste again —
          VibeHub will not guess at repairs.
          <ul>
            ${errors.map((error) => html`<li>${error}</li>`)}
          </ul>
        </div>`
      : raw("")}
    <form method="post" action="/projects/import">
      <label for="plan_text">Plan JSON</label>
      <textarea id="plan_text" name="plan_text" placeholder='{ "project_name": "...", "features": [ ... ] }'>${pasted}</textarea>
      <div class="row" style="margin-top:12px">
        <div style="width:200px">
          <label for="test_mode">Build gate</label>
          <select id="test_mode" name="test_mode">
            <option value="actions">GitHub Actions (default)</option>
            <option value="skip">Skip — accept any green push</option>
          </select>
        </div>
        <button type="submit">Import plan</button>
      </div>
    </form>
  </div>`;
}

export function homePage(input: {
  viewer: Viewer | null;
  projects: ProjectRow[];
  devLogin: boolean;
  githubConfigured: boolean;
  errors?: string[];
  pasted?: string;
}): Raw {
  const body = input.viewer
    ? html`<h1>Projects</h1>
        <p class="lede">
          One source of truth per project, a dependency-aware task graph, and a deterministic merge
          gate. Your agents do the writing; VibeHub decides what lands.
        </p>
        ${input.projects.length > 0
          ? html`<div class="panel tight">
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Version</th>
                    <th>Repo</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  ${input.projects.map(
                    (project) => html`<tr>
                      <td><a href="/projects/${project.id}"><strong>${project.name}</strong></a></td>
                      <td class="mono">v${project.current_version}</td>
                      <td class="small">
                        ${project.repo_url
                          ? html`<a href="${project.repo_url}" target="_blank" rel="noreferrer"
                              >${project.repo_owner}/${project.repo_name}</a
                            >`
                          : html`<span class="muted">not connected</span>`}
                      </td>
                      <td class="small muted">${project.created_at.slice(0, 10)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
          : html`<div class="panel"><span class="muted">No projects yet. Import a plan below.</span></div>`}
        <h2>New project</h2>
        ${scopingPromptPanel()} ${importPanel(input.errors ?? [], input.pasted ?? "")}`
    : html`<h1>VibeHub</h1>
        <p class="lede">
          Version control for teams whose code is written by AI agents. No branches, no manual
          merges, and no model calls anywhere in VibeHub itself.
        </p>
        <div class="panel">
          <h3>Sign in</h3>
          ${input.githubConfigured
            ? html`<p class="small muted" style="margin-top:0">
                  GitHub is the identity provider and the code store, so one sign-in covers both.
                </p>
                <a href="/auth/github"><button type="button">Continue with GitHub</button></a>`
            : html`<div class="warn">
                GitHub OAuth is not configured. Set <code>GITHUB_CLIENT_ID</code> and
                <code>GITHUB_CLIENT_SECRET</code>.
              </div>`}
          ${input.devLogin
            ? html`<form method="post" action="/auth/dev-login" style="margin-top:12px">
                <button class="ghost" type="submit">Continue as local dev user</button>
              </form>`
            : raw("")}
        </div>
        ${scopingPromptPanel()}`;

  return layout({
    title: input.viewer ? "Projects" : "VibeHub",
    user: input.viewer,
    body,
    script: `window.VIBEHUB_PROMPT = ${JSON.stringify(SCOPING_PROMPT)};`,
  });
}

function statusPill(status: string): Raw {
  return html`<span class="pill ${status}">${status.replace("_", " ")}</span>`;
}

function featureCard(
  feature: FeatureWithDeps,
  mergedSlugs: Set<string>,
  members: Array<UserRow & { role: string }>,
): Raw {
  const manifest = safeManifest(feature);
  const unmet = feature.dependsOn.filter((dep) => !mergedSlugs.has(dep));
  return html`<div class="panel" data-feature="${feature.slug}">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <strong>${feature.title}</strong>
        <span class="mono muted small">${feature.slug}</span>
      </div>
      ${statusPill(feature.status)}
    </div>
    ${feature.description ? html`<p class="small" style="margin:8px 0 10px">${feature.description}</p>` : raw("")}
    ${feature.dependsOn.length > 0
      ? html`<div class="deps" style="margin-bottom:10px">
          <span class="small muted">depends on</span>
          ${feature.dependsOn.map(
            (dep) => html`<span class="dep ${unmet.includes(dep) ? "unmet" : ""}">${dep}</span>`,
          )}
        </div>`
      : raw("")}
    ${feature.scope_notes
      ? html`<div class="small muted mono" style="margin-bottom:10px">${feature.scope_notes}</div>`
      : raw("")}
    <div class="small muted">
      routes ${manifest.routes.length} · exports ${manifest.exports.length} · deps
      ${manifest.deps.length}${feature.test_spec ? " · has test_spec" : ""}
    </div>
    <div class="row" style="margin-top:12px">
      <div style="width:190px">
        <label>Assignee</label>
        <select onchange="assign('${feature.slug}', this.value)">
          <option value="">Unassigned</option>
          ${members.map(
            (member) =>
              html`<option value="${member.id}" ${feature.assigned_to === member.id ? raw("selected") : raw("")}>
                ${member.display_name}
              </option>`,
          )}
        </select>
      </div>
      <div style="width:170px">
        <label>Status</label>
        <select onchange="setStatus('${feature.slug}', this.value)">
          ${["available", "claimed", "in_progress", "blocked", "merged"].map(
            (status) =>
              html`<option value="${status}" ${feature.status === status ? raw("selected") : raw("")}>
                ${status}
              </option>`,
          )}
        </select>
      </div>
      <button class="danger small" type="button" onclick="removeFeature('${feature.slug}')">Delete</button>
    </div>
    <details style="margin-top:12px">
      <summary>Edit scope, manifest, dependencies</summary>
      <div class="row">
        <div style="flex:1 1 320px">
          <label>Title</label>
          <input type="text" value="${feature.title}" data-edit="title" />
        </div>
        <div style="flex:1 1 320px">
          <label>Depends on (comma-separated feature ids)</label>
          <input type="text" value="${feature.dependsOn.join(", ")}" data-edit="dependsOn" />
        </div>
      </div>
      <div style="margin-top:10px">
        <label>Scope notes</label>
        <input type="text" value="${feature.scope_notes}" data-edit="scopeNotes" />
      </div>
      <div style="margin-top:10px">
        <label>Test spec (optional, non-blocking)</label>
        <input type="text" value="${feature.test_spec ?? ""}" data-edit="testSpec" />
      </div>
      <div style="margin-top:10px">
        <label>Manifest JSON</label>
        <textarea data-edit="manifest" style="min-height:120px">${JSON.stringify(manifest, null, 2)}</textarea>
      </div>
      <div style="margin-top:10px">
        <button type="button" onclick="saveFeature(this, '${feature.slug}')">Save changes</button>
      </div>
    </details>
  </div>`;
}

export function projectPage(input: {
  viewer: Viewer;
  project: ProjectRow;
  features: FeatureWithDeps[];
  mergedSlugs: Set<string>;
  members: Array<UserRow & { role: string }>;
  versions: VersionRow[];
  snapshots: SnapshotRow[];
  sharedFileWarnings: string[];
  mcpUrl: string;
  workflowPath: string;
  tokens: Array<{ id: string; name: string; created_at: string; last_used_at: string | null }>;
  newToken?: string | null;
  flash?: { kind: "err" | "warn"; messages: string[] } | null;
}): Raw {
  const { project } = input;
  const merged = input.features.filter((feature) => feature.status === "merged").length;

  const body = html`
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <h1>${project.name}</h1>
        <p class="lede" style="margin-bottom:0">
          ${project.repo_url
            ? html`<a href="${project.repo_url}" target="_blank" rel="noreferrer"
                >${project.repo_owner}/${project.repo_name}</a
              >
              · branch <code>${project.default_branch}</code>`
            : html`<span class="muted">No repo connected yet</span>`}
        </p>
      </div>
      <div class="stat">
        <div><span>Version</span><strong class="mono">v${project.current_version}</strong></div>
        <div><span>Merged</span><strong>${merged}/${input.features.length}</strong></div>
        <div><span>Gate</span><strong class="small">${project.test_mode}</strong></div>
      </div>
    </div>

    ${input.flash
      ? html`<div class="${input.flash.kind}" style="margin-bottom:16px">
          <ul>
            ${input.flash.messages.map((message) => html`<li>${message}</li>`)}
          </ul>
        </div>`
      : raw("")}
    ${input.sharedFileWarnings.length > 0
      ? html`<div class="warn" style="margin-bottom:16px">
          <strong>Shared-file warnings from your plan.</strong> Heads-up only — these do not block
          anything.
          <ul>
            ${input.sharedFileWarnings.map((warning) => html`<li>${warning}</li>`)}
          </ul>
        </div>`
      : raw("")}

    <div class="grid2">
      <div class="panel">
        <h3>GitHub repo</h3>
        ${project.repo_url
          ? html`<p class="small" style="margin-top:0">
                Connected to
                <a href="${project.repo_url}" target="_blank" rel="noreferrer"
                  >${project.repo_owner}/${project.repo_name}</a
                >. All code lives here; VibeHub's database holds only metadata.
              </p>`
          : html`<p class="small muted" style="margin-top:0">
              Connect the repo that will be this project's source of truth. An empty repo gets a
              baseline commit automatically.
            </p>`}
        <form method="post" action="/projects/${project.id}/repo">
          <label for="repo_url">Repo URL or owner/repo</label>
          <input
            id="repo_url"
            name="repo_url"
            type="text"
            placeholder="https://github.com/acme/storefront"
            value="${project.repo_url ?? ""}"
            required
          />
          <div class="row" style="margin-top:10px">
            <button type="submit">${project.repo_url ? "Reconnect" : "Connect repo"}</button>
          </div>
        </form>
        <form method="post" action="/projects/${project.id}/test-mode" style="margin-top:14px">
          <label for="tm">Build gate</label>
          <div class="row">
            <select id="tm" name="test_mode" style="width:auto;flex:1">
              <option value="actions" ${project.test_mode === "actions" ? raw("selected") : raw("")}>
                GitHub Actions
              </option>
              <option value="skip" ${project.test_mode === "skip" ? raw("selected") : raw("")}>
                Skip the gate
              </option>
            </select>
            <button class="ghost" type="submit">Update</button>
          </div>
        </form>
        <p class="small muted" style="margin-bottom:0">
          The Actions gate needs <code>${input.workflowPath}</code> in the repo.
          <a href="/workflow">Download it</a> if VibeHub did not create the repo.
        </p>
      </div>

      <div class="panel">
        <h3>MCP connection</h3>
        <p class="small muted" style="margin-top:0">
          Point your coding agent at this URL. OAuth-capable clients will run the browser flow; for
          everything else, generate a token and send it as a bearer header.
        </p>
        <div class="copywrap">
          <button class="ghost small" type="button" onclick="copyText('${input.mcpUrl}', this)">Copy</button>
          <pre class="block" style="max-height:none">${input.mcpUrl}</pre>
        </div>
        ${input.newToken
          ? html`<div class="warn" style="margin-top:12px">
              <strong>Copy this token now — it is not shown again.</strong>
              <div class="copywrap" style="margin-top:8px">
                <button class="ghost small" type="button" onclick="copyText('${input.newToken}', this)">
                  Copy
                </button>
                <pre class="block" style="max-height:none">${input.newToken}</pre>
              </div>
            </div>`
          : raw("")}
        <form method="post" action="/projects/${project.id}/tokens" style="margin-top:12px">
          <div class="row">
            <div style="flex:1">
              <label for="token_name">New token label</label>
              <input id="token_name" name="name" type="text" placeholder="claude-desktop" />
            </div>
            <button class="ghost" type="submit">Generate</button>
          </div>
        </form>
        ${input.tokens.length > 0
          ? html`<table style="margin-top:12px">
              <tbody>
                ${input.tokens.map(
                  (token) => html`<tr>
                    <td class="small">${token.name || "(unnamed)"}</td>
                    <td class="small muted">
                      ${token.last_used_at ? `used ${token.last_used_at.slice(0, 10)}` : "never used"}
                    </td>
                    <td style="text-align:right">
                      <form
                        method="post"
                        action="/projects/${project.id}/tokens/${token.id}/revoke"
                        style="margin:0"
                      >
                        <button class="danger small" type="submit">Revoke</button>
                      </form>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : raw("")}
      </div>
    </div>

    <h2>Task graph</h2>
    <p class="small muted" style="margin-top:-6px">
      Edits are validated the same way an import is: no dependency on a feature that does not exist,
      and no cycles.
    </p>
    ${input.features.map((feature) => featureCard(feature, input.mergedSlugs, input.members))}

    <details class="panel">
      <summary>Add a feature</summary>
      <div class="row" style="margin-top:10px">
        <div style="flex:1 1 200px">
          <label>Feature id</label>
          <input type="text" id="new_slug" placeholder="checkout-flow" />
        </div>
        <div style="flex:1 1 260px">
          <label>Title</label>
          <input type="text" id="new_title" placeholder="Checkout flow" />
        </div>
        <div style="flex:1 1 260px">
          <label>Depends on (comma-separated)</label>
          <input type="text" id="new_deps" placeholder="payments-api" />
        </div>
      </div>
      <div style="margin-top:10px">
        <label>Scope notes</label>
        <input type="text" id="new_scope" placeholder="src/features/checkout/**" />
      </div>
      <div class="row" style="margin-top:10px">
        <button type="button" onclick="addFeature()">Add feature</button>
      </div>
    </details>

    <details class="panel">
      <summary>Split or combine features</summary>
      <div class="grid2" style="margin-top:10px">
        <div>
          <label>Split this feature id</label>
          <input type="text" id="split_source" placeholder="checkout-flow" />
          <label style="margin-top:8px">Into these parts (JSON array)</label>
          <textarea id="split_parts" style="min-height:120px">
[
  { "slug": "checkout-ui", "title": "Checkout UI", "scopeNotes": "src/features/checkout-ui/**" },
  { "slug": "checkout-api", "title": "Checkout API", "scopeNotes": "src/features/checkout-api/**" }
]</textarea
          >
          <button type="button" style="margin-top:8px" onclick="splitFeature()">Split</button>
        </div>
        <div>
          <label>Combine these feature ids (comma-separated)</label>
          <input type="text" id="merge_sources" placeholder="checkout-ui, checkout-api" />
          <label style="margin-top:8px">New feature id</label>
          <input type="text" id="merge_slug" placeholder="checkout" />
          <label style="margin-top:8px">New title</label>
          <input type="text" id="merge_title" placeholder="Checkout" />
          <button type="button" style="margin-top:8px" onclick="mergeFeatures()">Combine</button>
        </div>
      </div>
    </details>

    <h2>Pushes</h2>
    <div class="panel tight" id="pushes"><span class="muted small">Loading…</span></div>

    <h2>Version history</h2>
    <div class="panel tight">
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th>Feature</th>
            <th>Changed paths</th>
            <th>Commit</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${input.versions.map((version) => {
            const paths = JSON.parse(version.changed_paths) as string[];
            const author = input.features.find((f) => f.id === version.created_by_feature_id);
            return html`<tr>
              <td class="mono">v${version.version_number}</td>
              <td class="small">${author ? author.slug : html`<span class="muted">baseline</span>`}</td>
              <td class="small mono muted">
                ${paths.length === 0
                  ? "—"
                  : paths.slice(0, 4).join(", ") + (paths.length > 4 ? ` +${paths.length - 4} more` : "")}
              </td>
              <td class="small mono muted">${version.commit_sha ? version.commit_sha.slice(0, 8) : "—"}</td>
              <td style="text-align:right">
                ${version.version_number < project.current_version && version.commit_sha
                  ? html`<button
                      class="ghost small"
                      type="button"
                      onclick="revertTo(${version.version_number})"
                    >
                      Revert to this
                    </button>`
                  : raw("")}
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>

    <h2>Snapshots</h2>
    <div class="panel tight">
      ${input.snapshots.length === 0
        ? html`<span class="muted small"
            >None. Agents park unmerged work here with <code>save_snapshot</code>; it never touches
            the source of truth.</span
          >`
        : html`<table>
            <thead>
              <tr>
                <th>Description</th>
                <th>Feature</th>
                <th>Ref</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              ${input.snapshots.map((snapshot) => {
                const feature = input.features.find((f) => f.id === snapshot.feature_id);
                return html`<tr>
                  <td class="small">${snapshot.description || "(none)"}</td>
                  <td class="small">${feature?.slug ?? "—"}</td>
                  <td class="small mono muted">${snapshot.storage_ref}</td>
                  <td class="small muted">${snapshot.created_at.slice(0, 10)}</td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </div>
  `;

  const script = `
const PROJECT = ${jsonScript(project.id).value};

function reportError(error) { alert(error.message || String(error)); }
function reload() { location.reload(); }

async function mutate(work) {
  try { await work(); reload(); } catch (error) { reportError(error); }
}

function parseList(value) {
  return value.split(',').map(function (item) { return item.trim(); }).filter(Boolean);
}

function assign(slug, userId) {
  mutate(function () {
    return api('PATCH', '/api/projects/' + PROJECT + '/features/' + slug, { assignedTo: userId || null });
  });
}

function setStatus(slug, status) {
  mutate(function () {
    return api('PATCH', '/api/projects/' + PROJECT + '/features/' + slug, { status: status });
  });
}

function removeFeature(slug) {
  if (!confirm('Delete feature "' + slug + '"?')) return;
  mutate(function () {
    return api('DELETE', '/api/projects/' + PROJECT + '/features/' + slug);
  });
}

function saveFeature(button, slug) {
  const card = button.closest('[data-feature]');
  const read = function (name) {
    const element = card.querySelector('[data-edit="' + name + '"]');
    return element ? element.value : undefined;
  };
  let manifest;
  try {
    manifest = JSON.parse(read('manifest') || '{}');
  } catch (error) {
    return reportError(new Error('Manifest is not valid JSON: ' + error.message));
  }
  mutate(function () {
    return api('PATCH', '/api/projects/' + PROJECT + '/features/' + slug, {
      title: read('title'),
      scopeNotes: read('scopeNotes'),
      testSpec: read('testSpec') || null,
      dependsOn: parseList(read('dependsOn') || ''),
      manifest: manifest,
    });
  });
}

function addFeature() {
  mutate(function () {
    return api('POST', '/api/projects/' + PROJECT + '/features', {
      slug: document.getElementById('new_slug').value.trim(),
      title: document.getElementById('new_title').value.trim(),
      scopeNotes: document.getElementById('new_scope').value.trim(),
      dependsOn: parseList(document.getElementById('new_deps').value),
    });
  });
}

function splitFeature() {
  let parts;
  try {
    parts = JSON.parse(document.getElementById('split_parts').value);
  } catch (error) {
    return reportError(new Error('Parts are not valid JSON: ' + error.message));
  }
  mutate(function () {
    return api('POST', '/api/projects/' + PROJECT + '/features/split', {
      source: document.getElementById('split_source').value.trim(),
      parts: parts,
    });
  });
}

function mergeFeatures() {
  mutate(function () {
    return api('POST', '/api/projects/' + PROJECT + '/features/combine', {
      sources: parseList(document.getElementById('merge_sources').value),
      target: {
        slug: document.getElementById('merge_slug').value.trim(),
        title: document.getElementById('merge_title').value.trim(),
      },
    });
  });
}

function revertTo(version) {
  if (!confirm('Restore the tree of v' + version + ' as a new version?')) return;
  mutate(function () {
    return api('POST', '/api/projects/' + PROJECT + '/revert', { version: version });
  });
}

function renderPushes(pushes) {
  const container = document.getElementById('pushes');
  if (!pushes.length) {
    container.innerHTML = '<span class="muted small">No pushes yet.</span>';
    return;
  }
  const rows = pushes.map(function (push) {
    const detail = push.status === 'conflict'
      ? (push.conflict_paths || []).join(', ') || (push.reason || '')
      : (push.error || push.reason || '');
    return '<tr>' +
      '<td class="small mono">' + push.feature_id + '</td>' +
      '<td><span class="pill ' + push.status + '">' + push.status + '</span></td>' +
      '<td class="small muted">' + push.stage + '</td>' +
      '<td class="small mono muted">based on v' + push.based_on_version +
        (push.merged_version !== null && push.merged_version !== undefined ? ' → v' + push.merged_version : '') + '</td>' +
      '<td class="small muted">' + (push.changed_paths || []).length + ' files</td>' +
      '<td class="small muted" style="max-width:320px">' + escapeText(detail) + '</td>' +
    '</tr>';
  }).join('');
  container.innerHTML = '<table><thead><tr><th>Feature</th><th>Status</th><th>Stage</th>' +
    '<th>Version</th><th>Files</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function pollPushes() {
  try {
    const data = await api('GET', '/api/projects/' + PROJECT + '/pushes');
    renderPushes(data.pushes);
  } catch (error) {
    document.getElementById('pushes').innerHTML =
      '<span class="muted small">Could not load pushes: ' + escapeText(error.message) + '</span>';
  }
}

pollPushes();
setInterval(pollPushes, 4000);
`;

  return layout({ title: project.name, user: input.viewer, body, script });
}

/** OAuth consent screen shown to an MCP client's authorization request. */
export function consentPage(input: {
  clientName: string;
  displayName: string;
  scopes: string[];
  payload: string;
  signature: string;
  cancelUrl: string | null;
}): Raw {
  return layout({
    title: "Authorize",
    user: { displayName: input.displayName },
    body: html`<h1>Authorize ${input.clientName}</h1>
      <p class="lede">
        This will let <strong>${input.clientName}</strong> act as you on every VibeHub project you
        belong to: read the task graph, pull snapshots, and submit pushes through the merge gate.
      </p>
      <div class="panel">
        <h3>Granting</h3>
        <ul class="small" style="margin:0;padding-left:20px">
          ${input.scopes.map((scope) => html`<li class="mono">${scope}</li>`)}
        </ul>
        <p class="small muted">
          It cannot change project membership, and it cannot bypass the build gate.
        </p>
        <form method="post" action="/authorize/approve" style="margin-top:6px">
          <input type="hidden" name="auth_request" value="${input.payload}" />
          <input type="hidden" name="auth_sig" value="${input.signature}" />
          <div class="row">
            <button type="submit">Approve</button>
            ${input.cancelUrl
              ? html`<a href="${input.cancelUrl}"><button class="ghost" type="button">Cancel</button></a>`
              : raw("")}
          </div>
        </form>
      </div>`,
  });
}

export function messagePage(input: {
  title: string;
  heading: string;
  messages: string[];
  kind: "err" | "warn";
  backHref?: string;
  viewer?: Viewer | null;
}): Raw {
  return layout({
    title: input.title,
    user: input.viewer ?? null,
    body: html`<h1>${input.heading}</h1>
      <div class="${input.kind}">
        <ul>
          ${input.messages.map((message) => html`<li>${message}</li>`)}
        </ul>
      </div>
      <p style="margin-top:18px"><a href="${input.backHref ?? "/"}">← Back</a></p>`,
  });
}
