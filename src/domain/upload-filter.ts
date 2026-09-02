/** Paths we never upload — even if missing from .gitignore. */
export const ALWAYS_SKIP_SEGMENTS = new Set([
  ".git",
  ".vibehub",
  "node_modules",
  ".pnpm-store",
  ".yarn",
  ".npm",
  "vendor",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".wrangler",
  "coverage",
  "htmlcov",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  ".tox",
  "target",
  "Pods",
  ".terraform",
  ".serverless",
  ".vercel",
  ".netlify",
  ".idea",
  ".DS_Store",
]);

export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "pdf", "zip", "gz", "tgz",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "wasm", "so", "dylib",
  "exe", "dll", "bin", "dmg", "sqlite", "db", "lockb",
]);

/** Lockfiles are skipped in MCP uploads — run npm install after clone. */
export const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "npm-shrinkwrap.json",
]);

export function isLockfile(path: string): boolean {
  const base = normalizeUploadPath(path).split("/").pop() ?? "";
  return LOCKFILE_BASENAMES.has(base);
}

export const VIBEHUB_GITIGNORE_SNIPPET = `# VibeHub (local integration — not part of your app)
.vibehub/
.cursor/mcp.json
.cursor/rules/vibehub.mdc
`;

export const DEFAULT_GITIGNORE = `# Added by VibeHub
${VIBEHUB_GITIGNORE_SNIPPET}
node_modules/
.pnpm-store/
.yarn/
dist/
build/
out/
.next/
.nuxt/
.turbo/
.cache/
.wrangler/
coverage/
__pycache__/
.venv/
venv/
target/
.dev.vars
.env
.env.*
!.env.example
*.log
.DS_Store
`;

export function normalizeUploadPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

export function hasSkippedSegment(path: string): boolean {
  return normalizeUploadPath(path)
    .split("/")
    .some((segment) => ALWAYS_SKIP_SEGMENTS.has(segment) || segment === ".git");
}

const SECRET_BASENAMES = new Set([".dev.vars", ".env", ".env.local", ".env.development"]);

export function isSecretOrEnvFile(path: string): boolean {
  const base = normalizeUploadPath(path).split("/").pop() ?? "";
  if (SECRET_BASENAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  return false;
}

export function looksBinaryPath(path: string): boolean {
  const normalized = normalizeUploadPath(path);
  const extension = normalized.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "tsbuildinfo") return true;
  return BINARY_EXTENSIONS.has(extension);
}

export function parseGitignore(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
}

export function isGitignored(path: string, rules: string[]): boolean {
  const normalized = normalizeUploadPath(path);
  if (!normalized || normalized.includes("..")) return true;
  for (const rule of rules) {
    if (matchesGitignoreRule(normalized, rule)) return true;
  }
  return false;
}

function matchesGitignoreRule(path: string, rule: string): boolean {
  let pattern = rule.trim();
  if (!pattern) return false;

  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) pattern = pattern.slice(0, -1);

  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);

  const regex = gitignoreRuleToRegex(pattern, directoryOnly);
  if (regex.test(path)) return true;

  // Also match if any suffix of the path matches (gitignore semantics for non-anchored rules).
  if (!anchored) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join("/");
      if (regex.test(suffix)) return true;
    }
  }

  return false;
}

function gitignoreRuleToRegex(pattern: string, directoryOnly: boolean): RegExp {
  let source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*");
  if (directoryOnly) source = `(?:${source})(?:/.*)?`;
  return new RegExp(`^${source}$`);
}

export function shouldUploadPath(path: string, gitignoreRules: string[] = []): boolean {
  const normalized = normalizeUploadPath(path);
  if (!normalized || normalized.includes("..")) return false;
  if (isSecretOrEnvFile(normalized)) return false;
  if (isLockfile(normalized)) return false;
  if (hasSkippedSegment(normalized)) return false;
  if (looksBinaryPath(normalized)) return false;
  if (isGitignored(normalized, gitignoreRules)) return false;
  return true;
}

export function collectGitignoreRules(files: Array<{ path: string; content?: string }>): string[] {
  const rules: string[] = [];
  const sorted = [...files].sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const file of sorted) {
    const base = normalizeUploadPath(file.path);
    if (base !== ".gitignore" && !base.endsWith("/.gitignore")) continue;
    if (!file.content) continue;
    const prefix = base === ".gitignore" ? "" : base.slice(0, -"/.gitignore".length);
    for (const rule of parseGitignore(file.content)) {
      if (!rule) continue;
      if (prefix && !rule.startsWith("/")) {
        rules.push(`${prefix}/${rule}`.replace(/\/+/g, "/"));
      } else {
        rules.push(rule);
      }
    }
  }
  return rules;
}
