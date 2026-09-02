import { html, raw, type Raw } from "./html.js";

const STYLES = `
:root {
  --bg: #0d1117;
  --panel: #151b23;
  --panel-2: #1c232d;
  --line: #2a323d;
  --text: #e6edf3;
  --muted: #8b98a5;
  --accent: #7c9cff;
  --green: #3fb950;
  --amber: #d29922;
  --red: #f85149;
  --violet: #a371f7;
  --radius: 10px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; }
header.top {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--panel);
}
header.top .brand { font-weight: 650; letter-spacing: -0.01em; font-size: 17px; }
header.top .brand span { color: var(--accent); }
header.top .spacer { flex: 1; }
header.top .who { color: var(--muted); font-size: 13px; }
main { max-width: 1120px; margin: 0 auto; padding: 28px 24px 80px; }
h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: -0.02em; }
h2 { font-size: 17px; margin: 32px 0 12px; letter-spacing: -0.01em; }
h3 { font-size: 14px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
p.lede { color: var(--muted); margin: 0 0 20px; }
.panel {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 18px; margin-bottom: 16px;
}
.panel.tight { padding: 14px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
.row > * { min-width: 0; }
label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
input[type=text], input[type=url], textarea, select {
  width: 100%; background: var(--bg); color: var(--text);
  border: 1px solid var(--line); border-radius: 7px; padding: 8px 10px; font-size: 14px;
  font-family: inherit;
}
textarea { min-height: 180px; resize: vertical; font-family: ui-monospace, monospace; font-size: 13px; }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
button {
  background: var(--accent); color: #0b1020; border: 0; border-radius: 7px;
  padding: 8px 14px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit;
}
button:hover { filter: brightness(1.08); }
button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); font-weight: 500; }
button.ghost:hover { background: var(--panel-2); filter: none; }
button.danger { background: transparent; color: var(--red); border: 1px solid var(--line); font-weight: 500; }
button.small { padding: 4px 9px; font-size: 12px; }
.pill {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 650; letter-spacing: 0.03em; text-transform: uppercase;
}
.pill.available { background: rgba(124,156,255,.16); color: var(--accent); }
.pill.claimed, .pill.in_progress { background: rgba(210,153,34,.16); color: var(--amber); }
.pill.merged { background: rgba(63,185,80,.16); color: var(--green); }
.pill.blocked { background: rgba(248,81,73,.16); color: var(--red); }
.pill.testing { background: rgba(210,153,34,.16); color: var(--amber); }
.pill.conflict { background: rgba(163,113,247,.18); color: var(--violet); }
.pill.failed { background: rgba(248,81,73,.16); color: var(--red); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 0 10px 8px; font-weight: 600; }
td { padding: 10px; border-top: 1px solid var(--line); vertical-align: top; }
pre.block {
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  padding: 14px; overflow: auto; font-size: 12.5px; margin: 0; max-height: 380px;
}
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.warn {
  background: rgba(210,153,34,.1); border: 1px solid rgba(210,153,34,.35);
  border-radius: 8px; padding: 12px 14px; color: #f0d48a; font-size: 13.5px;
}
.err {
  background: rgba(248,81,73,.1); border: 1px solid rgba(248,81,73,.35);
  border-radius: 8px; padding: 12px 14px; color: #ffb3ae; font-size: 13.5px;
}
.err ul, .warn ul { margin: 6px 0 0; padding-left: 20px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 820px) { .grid2 { grid-template-columns: 1fr; } }
.deps { display: flex; gap: 5px; flex-wrap: wrap; }
.dep { background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; font-size: 11.5px; }
.dep.unmet { border-color: rgba(248,81,73,.5); color: #ffb3ae; }
.copywrap { position: relative; }
.copywrap button { position: absolute; top: 10px; right: 10px; }
details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
details[open] summary { margin-bottom: 10px; }
.stat { display: flex; gap: 26px; flex-wrap: wrap; }
.stat div span { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.stat div strong { font-size: 19px; font-weight: 650; }
`;

const COMMON_SCRIPT = `
async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text }; }
  if (!response.ok) {
    const details = parsed && parsed.details ? '\\n- ' + [].concat(parsed.details).join('\\n- ') : '';
    throw new Error(((parsed && parsed.error) || response.statusText) + details);
  }
  return parsed;
}
function copyText(text, button) {
  navigator.clipboard.writeText(text).then(function () {
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(function () { button.textContent = original; }, 1400);
  });
}
`;

export interface LayoutOptions {
  title: string;
  user?: { displayName: string } | null;
  body: Raw;
  script?: string;
}

export function layout(options: LayoutOptions): Raw {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title} · VibeHub</title>
<style>${raw(STYLES)}</style>
</head>
<body>
<header class="top">
  <div class="brand"><a href="/" style="color:inherit">Vibe<span>Hub</span></a></div>
  <div class="spacer"></div>
  ${options.user
    ? html`<div class="who">${options.user.displayName}</div>
        <form method="post" action="/auth/logout" style="margin:0">
          <button class="ghost small" type="submit">Sign out</button>
        </form>`
    : raw("")}
</header>
<main>${options.body}</main>
<script>${raw(COMMON_SCRIPT)}${raw(options.script ?? "")}</script>
</body>
</html>`;
}
