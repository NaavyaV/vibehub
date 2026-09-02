import {
  hasSkippedSegment,
  normalizeUploadPath,
  shouldUploadPath,
  parseGitignore,
} from "./upload-filter";

const MAX_FILE_BYTES = 400_000;
export const MAX_UPLOAD_FILES = 200;

export type LocalFolderResult = {
  files: Array<{ path: string; content: string }>;
  scanned: number;
  skipped: number;
};

function stripPickerRoot(relative: string, root: string): string {
  if (root && relative.startsWith(`${root}/`)) return relative.slice(root.length + 1);
  return relative;
}

/** Reads a folder from `<input webkitdirectory />` into upload payloads. */
export async function readLocalFolder(fileList: FileList): Promise<LocalFolderResult> {
  const entries = Array.from(fileList);
  if (entries.length === 0) return { files: [], scanned: 0, skipped: 0 };

  const root =
    entries
      .map((file) => file.webkitRelativePath || file.name)
      .find(Boolean)
      ?.split("/")[0] ?? "";

  const candidates: Array<{ path: string; file: File }> = [];
  let skipped = 0;

  for (const file of entries) {
    const relative = file.webkitRelativePath || file.name;
    const path = normalizeUploadPath(stripPickerRoot(relative, root));
    if (!path) continue;

    // Fast path: never read content from huge/vendor trees.
    if (hasSkippedSegment(path)) {
      skipped++;
      continue;
    }

    candidates.push({ path, file });
  }

  // Load project .gitignore (must not treat ".gitignore" as a ".git" path).
  const gitignoreRules: string[] = [];
  for (const candidate of candidates) {
    const base = candidate.path.split("/").pop() ?? candidate.path;
    if (base !== ".gitignore") continue;
    if (candidate.file.size > MAX_FILE_BYTES) continue;
    try {
      const content = await candidate.file.text();
      const prefix =
        candidate.path === ".gitignore"
          ? ""
          : candidate.path.slice(0, candidate.path.lastIndexOf("/"));
      for (const rule of parseGitignore(content)) {
        if (!rule) continue;
        gitignoreRules.push(
          prefix && !rule.startsWith("/")
            ? `${prefix}/${rule}`.replace(/\/+/g, "/")
            : rule,
        );
      }
    } catch {
      // Ignore unreadable gitignore.
    }
  }

  const uploads: Array<{ path: string; content: string }> = [];
  for (const candidate of candidates) {
    if (!shouldUploadPath(candidate.path, gitignoreRules)) {
      skipped++;
      continue;
    }
    if (candidate.file.size > MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    if (uploads.length >= MAX_UPLOAD_FILES) {
      skipped++;
      continue;
    }

    try {
      const content = await candidate.file.text();
      if (!content.trim()) {
        skipped++;
        continue;
      }
      uploads.push({ path: candidate.path, content });
    } catch {
      skipped++;
    }
  }

  return {
    files: uploads,
    scanned: entries.length,
    skipped,
  };
}
