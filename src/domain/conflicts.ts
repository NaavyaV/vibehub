/**
 * File-path-based conflict detection.
 *
 * The rule: a push is only in conflict if a path it touches was also touched by
 * a version merged after the pusher's `based_on_version`. How many versions
 * behind the pusher is has no bearing on the outcome — being 40 versions behind
 * with no path overlap auto-applies cleanly.
 */

import { normalizePath, PathError, partitionReserved, sortedUnique } from "../lib/paths.js";
import { placeholderReason } from "./content-guard.js";

export type FileAction = "add" | "modify" | "delete";

export interface ChangedFile {
  path: string;
  /** Omitted (or ignored) for `delete`. */
  content?: string;
  action: FileAction;
  /** "utf-8" (default) or "base64" for true binary files only. */
  encoding?: "utf-8" | "base64";
  /** Optional integrity check — must match SHA-256 hex of the utf-8 content bytes. */
  content_sha256?: string;
}

export interface VersionPaths {
  version_number: number;
  /** Repo-relative paths written by that version. */
  changed_paths: string[];
}

/** Union of paths written by every version strictly newer than `basedOnVersion`. */
export function changedPathsSince(versions: VersionPaths[], basedOnVersion: number): string[] {
  const paths = new Set<string>();
  for (const version of versions) {
    if (version.version_number <= basedOnVersion) continue;
    for (const path of version.changed_paths) paths.add(path);
  }
  return sortedUnique(paths);
}

/** The overlapping paths, or an empty array when the push can auto-apply. */
export function detectPathConflicts(
  pathsChangedSince: Iterable<string>,
  incomingPaths: Iterable<string>,
): string[] {
  const since = new Set(pathsChangedSince);
  const overlap = new Set<string>();
  for (const path of incomingPaths) {
    if (since.has(path)) overlap.add(path);
  }
  return sortedUnique(overlap);
}

export interface ValidatedFiles {
  files: (ChangedFile & { path: string; encoding: "utf-8" | "base64" })[];
  paths: string[];
  digests: Array<{ path: string; sha256: string; bytes: number }>;
  errors: string[];
}

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".svg",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".csv",
  ".env",
  ".gitignore",
  ".npmrc",
  ".editorconfig",
]);

function looksLikeTextPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (base.startsWith(".") && !base.includes(".", 1)) return true;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

function looksLikeBase64Payload(value: string): boolean {
  const trimmed = value.replace(/\s+/g, "");
  if (trimmed.length < 32 || trimmed.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return false;
  // Real source rarely is pure base64 alphabet for long stretches without spaces/newlines.
  return !/[\n\r\t ]/.test(value.slice(0, 200)) && trimmed.length === value.replace(/\s+/g, "").length;
}

function decodeBase64Utf8(value: string): string | null {
  try {
    const binary = atob(value.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function sha256HexOfUtf8(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Normalizes incoming paths and rejects anything structurally invalid, a
 * duplicate, reserved/generated file, or text content wrongly sent as base64.
 */
export async function validateChangedFiles(files: ChangedFile[]): Promise<ValidatedFiles> {
  const errors: string[] = [];
  const normalized: ValidatedFiles["files"] = [];
  const digests: ValidatedFiles["digests"] = [];
  const seen = new Set<string>();

  if (files.length === 0) errors.push("changed_files is empty; nothing to push");

  for (const [index, file] of files.entries()) {
    let path: string;
    try {
      path = normalizePath(file.path ?? "");
    } catch (error) {
      errors.push(error instanceof PathError ? error.message : `changed_files[${index}]: bad path`);
      continue;
    }
    if (seen.has(path)) {
      errors.push(`Duplicate path in changed_files: "${path}"`);
      continue;
    }
    if (file.action !== "add" && file.action !== "modify" && file.action !== "delete") {
      errors.push(`changed_files[${index}] ("${path}"): action must be add, modify, or delete`);
      continue;
    }
    if (file.action !== "delete" && typeof file.content !== "string") {
      errors.push(`changed_files[${index}] ("${path}"): content is required for ${file.action}`);
      continue;
    }

    let encoding: "utf-8" | "base64" = file.encoding ?? "utf-8";
    let content = file.content;

    if (file.action !== "delete" && typeof content === "string") {
      const isText = looksLikeTextPath(path);

      if (encoding === "base64") {
        if (isText) {
          const decoded = decodeBase64Utf8(content);
          if (decoded == null) {
            errors.push(
              `changed_files[${index}] ("${path}"): invalid base64. Text files (.css, .ts, …) must use encoding "utf-8" with plain source text — never base64.`,
            );
            continue;
          }
          // Recover: accept decoded utf-8 so a mistaken base64 push doesn't corrupt main.
          content = decoded;
          encoding = "utf-8";
        }
      } else if (isText && looksLikeBase64Payload(content) && !content.includes("{") && !content.includes(";")) {
        errors.push(
          `changed_files[${index}] ("${path}"): content looks like base64. Send the real utf-8 source text with encoding "utf-8" (or omit encoding).`,
        );
        continue;
      }

      const placeholder = placeholderReason(content);
      if (placeholder !== null) {
        errors.push(
          `changed_files[${index}] ("${path}"): content is ${placeholder}, not the file. Paste the real utf-8 text — if it is too large for one call, declare it in begin_upload and send it with upload_file in chunks.`,
        );
        continue;
      }

      const sha256 = await sha256HexOfUtf8(content);
      if (file.content_sha256 && file.content_sha256.toLowerCase() !== sha256) {
        errors.push(
          `changed_files[${index}] ("${path}"): content_sha256 mismatch (got ${sha256.slice(0, 12)}…, expected ${file.content_sha256.slice(0, 12)}…). Re-read the file and push again.`,
        );
        continue;
      }
      digests.push({ path, sha256, bytes: new TextEncoder().encode(content).byteLength });
    }

    seen.add(path);
    normalized.push({
      ...file,
      path,
      content,
      encoding,
    });
  }

  const { reserved } = partitionReserved([...seen]);
  for (const path of reserved) {
    errors.push(
      `"${path}" is generated by VibeHub and cannot be pushed directly. Declare routes, exports, and npm deps in your feature manifest instead.`,
    );
  }

  return { files: normalized, paths: sortedUnique(seen), digests, errors };
}
