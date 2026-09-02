/**
 * Repo-relative path handling. Every path that enters the system is normalized
 * here first, so conflict detection compares apples to apples.
 */

/** Directory whose contents VibeHub generates from merged manifests. */
export const GENERATED_DIR = "src/generated/";

/** Files VibeHub owns. A feature push that touches one of these is rejected. */
export const RESERVED_PATHS = ["package.json"] as const;

export class PathError extends Error {}

export function normalizePath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (trimmed === "") throw new PathError("Empty file path");
  if (trimmed.startsWith("/")) throw new PathError(`Path must be repo-relative: "${raw}"`);
  const withoutDotSlash = trimmed.replace(/^\.\//, "");
  const segments = withoutDotSlash.split("/");
  if (segments.some((s) => s === "..")) {
    throw new PathError(`Path may not contain "..": "${raw}"`);
  }
  if (segments.some((s) => s === "" || s === ".")) {
    throw new PathError(`Path contains an empty segment: "${raw}"`);
  }
  if (segments[0] === ".git") throw new PathError(`Path may not be inside .git: "${raw}"`);
  return segments.join("/");
}

export function isGeneratedPath(path: string): boolean {
  return path.startsWith(GENERATED_DIR) || (RESERVED_PATHS as readonly string[]).includes(path);
}

/**
 * Splits normalized paths into the ones a feature may write and the ones
 * VibeHub reserves for generated shared wiring.
 */
export function partitionReserved(paths: string[]): { allowed: string[]; reserved: string[] } {
  const allowed: string[] = [];
  const reserved: string[] = [];
  for (const path of paths) (isGeneratedPath(path) ? reserved : allowed).push(path);
  return { allowed, reserved };
}

export function sortedUnique(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
