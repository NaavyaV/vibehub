/**
 * Completeness check for a push.
 *
 * The common failure mode is an agent shipping markup that imports a stylesheet
 * it never sent, so the feature merges and visibly does nothing. Every relative
 * import in the pushed files must resolve against the repo as it will look after
 * the merge; anything that does not is a missing file, not a merge conflict.
 */

const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less"];
const INDEX_BASENAMES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"];

const SCRIPT_FILE = /\.(?:[cm]?jsx?|tsx?)$/i;
const STYLE_FILE = /\.(?:css|scss|sass|less)$/i;

/** `from "./x"`, `import "./x"`, `require("./x")`, `import("./x")`. */
const SCRIPT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'](\.[^"']*)["']/g;
/** `@import "./x.css"` and `@import url("./x.css")`. */
const STYLE_SPECIFIER = /@import\s+(?:url\(\s*)?["'](\.[^"']*)["']/g;

export interface PushedFile {
  path: string;
  content?: string;
  action: "add" | "modify" | "delete";
}

export interface MissingImport {
  from: string;
  specifier: string;
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Joins a relative specifier onto a directory, collapsing `.` and `..`. */
function resolveAgainst(dir: string, specifier: string): string | null {
  const segments = dir === "" ? [] : dir.split("/");
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

function candidatesFor(target: string, importedFromStyle: boolean): string[] {
  const extensions = importedFromStyle
    ? [...STYLE_EXTENSIONS, ...SCRIPT_EXTENSIONS]
    : [...SCRIPT_EXTENSIONS, ...STYLE_EXTENSIONS];

  const candidates = [target];
  for (const extension of extensions) candidates.push(`${target}${extension}`);
  for (const basename of INDEX_BASENAMES) candidates.push(`${target}/${basename}`);

  // TypeScript ESM writes `./x.js` for a file that is actually `./x.ts`.
  const jsMatch = /\.(m?)js$/.exec(target);
  if (jsMatch) {
    const stem = target.slice(0, target.length - jsMatch[0].length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`);
  }
  // Sass partials: `./_thing.scss` for `./thing`.
  if (importedFromStyle) {
    const slash = target.lastIndexOf("/");
    const dir = slash < 0 ? "" : target.slice(0, slash + 1);
    const base = slash < 0 ? target : target.slice(slash + 1);
    for (const extension of STYLE_EXTENSIONS) candidates.push(`${dir}_${base}${extension}`);
  }
  return candidates;
}

function specifiersIn(path: string, content: string): Array<{ specifier: string; style: boolean }> {
  const found: Array<{ specifier: string; style: boolean }> = [];
  const isStyle = STYLE_FILE.test(path);
  const isScript = SCRIPT_FILE.test(path);

  if (isScript) {
    for (const match of content.matchAll(SCRIPT_SPECIFIER)) {
      found.push({ specifier: match[1]!, style: false });
    }
  }
  if (isStyle || isScript) {
    for (const match of content.matchAll(STYLE_SPECIFIER)) {
      found.push({ specifier: match[1]!, style: true });
    }
  }
  return found;
}

/**
 * Returns the relative imports in `pushedFiles` that resolve to nothing once the
 * push lands. `existingPaths` is the repo tree the push is based on.
 */
export function findMissingImports(
  pushedFiles: PushedFile[],
  existingPaths: Iterable<string>,
): MissingImport[] {
  const deleted = new Set(
    pushedFiles.filter((file) => file.action === "delete").map((file) => file.path),
  );
  const afterMerge = new Set<string>();
  for (const path of existingPaths) {
    if (!deleted.has(path)) afterMerge.add(path);
  }
  for (const file of pushedFiles) {
    if (file.action !== "delete") afterMerge.add(file.path);
  }

  const missing: MissingImport[] = [];
  const reported = new Set<string>();

  for (const file of pushedFiles) {
    if (file.action === "delete" || typeof file.content !== "string") continue;
    if (!SCRIPT_FILE.test(file.path) && !STYLE_FILE.test(file.path)) continue;

    for (const { specifier, style } of specifiersIn(file.path, file.content)) {
      const target = resolveAgainst(dirnameOf(file.path), specifier);
      // Escapes the repo root — not something we can check, so leave it alone.
      if (target === null || target === "") continue;
      if (candidatesFor(target, style).some((candidate) => afterMerge.has(candidate))) continue;

      const key = `${file.path}→${specifier}`;
      if (reported.has(key)) continue;
      reported.add(key);
      missing.push({ from: file.path, specifier });
    }
  }

  return missing;
}
