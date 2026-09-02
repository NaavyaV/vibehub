/**
 * Staged uploads for MCP pushes.
 *
 * A single tool call can only carry so much text, so agents quietly drop big
 * files (stylesheets are the usual casualty) and ship half a feature. An upload
 * fixes that by making the file list a contract: the agent declares every path
 * up front, streams each file in as many chunks as it needs, and the push is
 * refused until every declared path has arrived in full.
 *
 * Chunks live in KV, never D1 — file content never touches a column.
 */

import { badRequest, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { normalizePath, PathError } from "../lib/paths.js";
import { placeholderReason } from "../domain/content-guard.js";
import type { ChangedFile, FileAction } from "../domain/conflicts.js";
import type { AppEnv } from "../types.js";

/** Chunk size we advertise to agents. Comfortably inside MCP message limits. */
export const CHUNK_LIMIT_BYTES = 48_000;
const MAX_FILE_BYTES = 5_000_000;
const UPLOAD_TTL_SECONDS = 60 * 60 * 6;

interface UploadFileState {
  path: string;
  action: FileAction;
  /** Set by the first chunk that arrives; every later chunk must agree. */
  partCount: number | null;
  receivedParts: number[];
  bytes: number;
  /** Size the agent said the local file is. The assembled file must match. */
  declaredBytes: number | null;
  /** Optional stronger contract: sha256 of the whole file. */
  declaredSha256: string | null;
}

interface UploadMeta {
  id: string;
  projectId: string;
  featureIdOrSlug: string;
  userId: string | null;
  files: UploadFileState[];
  createdAt: string;
}

export interface UploadProgress {
  upload_id: string;
  project_id: string;
  feature_id: string;
  complete: boolean;
  chunk_limit_bytes: number;
  files: Array<{
    path: string;
    action: FileAction;
    complete: boolean;
    received_parts: number;
    expected_parts: number | null;
    bytes: number;
    declared_bytes: number | null;
    size_matches_declaration: boolean;
  }>;
  missing_paths: string[];
  next_step: string;
}

const metaKey = (uploadId: string) => `upload:${uploadId}:meta`;
const chunkKey = (uploadId: string, fileIndex: number, partIndex: number) =>
  `upload:${uploadId}:c:${fileIndex}:${partIndex}`;

function cleanPath(value: string): string {
  try {
    return normalizePath(value ?? "");
  } catch (error) {
    throw badRequest(error instanceof PathError ? error.message : `Bad path "${value}".`);
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function readMeta(env: AppEnv, uploadId: string): Promise<UploadMeta> {
  const meta = (await env.PUSH_PAYLOADS.get(metaKey(uploadId), "json")) as UploadMeta | null;
  if (!meta) {
    throw notFound(
      `Upload ${uploadId} not found or expired. Call begin_upload again and re-send the files.`,
    );
  }
  return meta;
}

async function writeMeta(env: AppEnv, meta: UploadMeta): Promise<void> {
  await env.PUSH_PAYLOADS.put(metaKey(meta.id), JSON.stringify(meta), {
    expirationTtl: UPLOAD_TTL_SECONDS,
  });
}

function fileComplete(file: UploadFileState): boolean {
  if (file.action === "delete") return true;
  if (file.partCount === null) return false;
  return file.receivedParts.length === file.partCount;
}

function progressOf(meta: UploadMeta): UploadProgress {
  const missing = meta.files.filter((file) => !fileComplete(file)).map((file) => file.path);
  const complete = missing.length === 0;
  return {
    upload_id: meta.id,
    project_id: meta.projectId,
    feature_id: meta.featureIdOrSlug,
    complete,
    chunk_limit_bytes: CHUNK_LIMIT_BYTES,
    files: meta.files.map((file) => ({
      path: file.path,
      action: file.action,
      complete: fileComplete(file),
      received_parts: file.receivedParts.length,
      expected_parts: file.partCount,
      bytes: file.bytes,
      declared_bytes: file.declaredBytes,
      size_matches_declaration: file.declaredBytes === null || file.bytes === file.declaredBytes,
    })),
    missing_paths: missing,
    next_step: complete
      ? "All declared files received. Call push_code with this upload_id."
      : `Still missing: ${missing.join(", ")}. Send each with upload_file (split into <=${CHUNK_LIMIT_BYTES} byte parts).`,
  };
}

export interface BeginUploadInput {
  projectId: string;
  featureIdOrSlug: string;
  userId: string | null;
  files: Array<{
    path: string;
    action?: FileAction;
    content?: string;
    bytes?: number;
    sha256?: string;
  }>;
}

/**
 * Declares the complete file list for one push. Files small enough to inline can
 * carry their content here, so a small feature is one call plus the push.
 */
export async function beginUpload(env: AppEnv, input: BeginUploadInput): Promise<UploadProgress> {
  if (input.files.length === 0) {
    throw badRequest("Declare at least one file. List every path this feature touches.");
  }

  const uploadId = newId("upl");
  const files: UploadFileState[] = [];
  const seen = new Set<string>();

  for (const file of input.files) {
    const path = cleanPath(file.path);
    if (seen.has(path)) throw badRequest(`Duplicate path in files: "${path}".`);
    seen.add(path);

    const action = file.action ?? "modify";
    const declaredBytes =
      file.bytes ?? (typeof file.content === "string" ? utf8Bytes(file.content) : null);
    if (action !== "delete" && (declaredBytes === null || !Number.isInteger(declaredBytes))) {
      throw badRequest(
        `"${path}": declare bytes — the exact utf-8 size of your local file. The upload is checked against it so a truncated or placeholder body cannot merge.`,
      );
    }

    files.push({
      path,
      action,
      partCount: null,
      receivedParts: [],
      bytes: 0,
      declaredBytes: action === "delete" ? null : declaredBytes,
      declaredSha256: file.sha256?.trim().toLowerCase() ?? null,
    });
  }

  const meta: UploadMeta = {
    id: uploadId,
    projectId: input.projectId,
    featureIdOrSlug: input.featureIdOrSlug,
    userId: input.userId,
    files,
    createdAt: new Date().toISOString(),
  };
  await writeMeta(env, meta);

  for (const [index, file] of input.files.entries()) {
    if (typeof file.content !== "string") continue;
    await uploadChunk(env, {
      uploadId,
      userId: input.userId,
      path: files[index]!.path,
      content: file.content,
      partIndex: 0,
      partCount: 1,
    });
  }

  return progressOf(await readMeta(env, uploadId));
}

export interface UploadChunkInput {
  uploadId: string;
  userId: string | null;
  path: string;
  content: string;
  partIndex?: number;
  partCount?: number;
}

/** Stores one part of one declared file. Parts may arrive in any order. */
export async function uploadChunk(env: AppEnv, input: UploadChunkInput): Promise<UploadProgress> {
  const meta = await readMeta(env, input.uploadId);
  if (meta.userId && input.userId && meta.userId !== input.userId) {
    throw badRequest("This upload belongs to another user.");
  }

  const path = cleanPath(input.path);
  const index = meta.files.findIndex((file) => file.path === path);
  if (index < 0) {
    throw badRequest(
      `"${path}" was not declared in begin_upload. Declared paths: ${meta.files
        .map((file) => file.path)
        .join(", ")}.`,
    );
  }

  const file = meta.files[index]!;
  if (file.action === "delete") {
    throw badRequest(`"${path}" is a delete — do not upload content for it.`);
  }

  const partCount = input.partCount ?? 1;
  const partIndex = input.partIndex ?? 0;
  if (!Number.isInteger(partCount) || partCount < 1) {
    throw badRequest("part_count must be a positive integer.");
  }
  if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= partCount) {
    throw badRequest(`part_index must be between 0 and ${partCount - 1}.`);
  }
  if (file.partCount !== null && file.partCount !== partCount) {
    throw badRequest(
      `"${path}" was already being sent in ${file.partCount} parts; this call says ${partCount}. Restart the file with a consistent part_count.`,
    );
  }

  const bytes = utf8Bytes(input.content);
  if (file.bytes + bytes > MAX_FILE_BYTES) {
    throw badRequest(`"${path}" exceeds the ${MAX_FILE_BYTES / 1_000_000}MB per-file limit.`);
  }

  await env.PUSH_PAYLOADS.put(chunkKey(meta.id, index, partIndex), input.content, {
    expirationTtl: UPLOAD_TTL_SECONDS,
  });

  file.partCount = partCount;
  if (!file.receivedParts.includes(partIndex)) {
    file.receivedParts.push(partIndex);
    file.bytes += bytes;
  }
  await writeMeta(env, meta);

  return progressOf(meta);
}

export async function getUploadStatus(env: AppEnv, uploadId: string): Promise<UploadProgress> {
  return progressOf(await readMeta(env, uploadId));
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The assembled file has to be the file the agent said it was sending. This is
 * what stops a stand-in body or a half-pasted file from reaching the merge.
 */
async function assertRealContent(file: UploadFileState, content: string): Promise<void> {
  const placeholder = placeholderReason(content);
  if (placeholder !== null) {
    throw badRequest(
      `"${file.path}" contains ${placeholder}, not the file's real content. Send the actual utf-8 text — split it across upload_file parts if it is large. Never send a stand-in intending to swap it in later.`,
      { code: "placeholder_content", path: file.path },
    );
  }

  const actualBytes = utf8Bytes(content);
  if (file.declaredBytes !== null && actualBytes !== file.declaredBytes) {
    throw badRequest(
      `"${file.path}" arrived as ${actualBytes} bytes but you declared ${file.declaredBytes}. Something was truncated or a part is missing — re-send the file and push again.`,
      { code: "size_mismatch", path: file.path, declared: file.declaredBytes, received: actualBytes },
    );
  }

  if (file.declaredSha256) {
    const actual = await sha256Hex(content);
    if (actual !== file.declaredSha256) {
      throw badRequest(
        `"${file.path}" does not match the sha256 you declared (got ${actual.slice(0, 12)}…). Re-read the local file and re-upload.`,
        { code: "sha_mismatch", path: file.path },
      );
    }
  }
}

export interface CollectedUpload {
  files: ChangedFile[];
  projectId: string;
  featureIdOrSlug: string;
}

/**
 * Reassembles the declared files. Throws when anything is missing, which is the
 * whole point: a half-uploaded feature must never reach the merge.
 */
export async function collectUpload(
  env: AppEnv,
  uploadId: string,
  userId: string | null,
): Promise<CollectedUpload> {
  const meta = await readMeta(env, uploadId);
  if (meta.userId && userId && meta.userId !== userId) {
    throw badRequest("This upload belongs to another user.");
  }

  const progress = progressOf(meta);
  if (!progress.complete) {
    throw badRequest(
      `Upload ${uploadId} is incomplete — these declared files never arrived: ${progress.missing_paths.join(
        ", ",
      )}. Send them with upload_file before pushing.`,
      progress.missing_paths,
    );
  }

  const files: ChangedFile[] = [];
  for (const [index, file] of meta.files.entries()) {
    if (file.action === "delete") {
      files.push({ path: file.path, action: "delete" });
      continue;
    }
    const parts: string[] = [];
    for (let part = 0; part < (file.partCount ?? 1); part++) {
      const chunk = await env.PUSH_PAYLOADS.get(chunkKey(meta.id, index, part), "text");
      if (chunk === null) {
        throw badRequest(
          `Part ${part + 1} of "${file.path}" expired before the push. Re-upload the file and push again.`,
        );
      }
      parts.push(chunk);
    }

    const content = parts.join("");
    await assertRealContent(file, content);
    files.push({ path: file.path, action: file.action, content, encoding: "utf-8" });
  }

  return { files, projectId: meta.projectId, featureIdOrSlug: meta.featureIdOrSlug };
}

/** Best-effort cleanup once a push has taken the files. */
export async function discardUpload(env: AppEnv, uploadId: string): Promise<void> {
  try {
    const meta = (await env.PUSH_PAYLOADS.get(metaKey(uploadId), "json")) as UploadMeta | null;
    if (!meta) return;
    for (const [index, file] of meta.files.entries()) {
      for (let part = 0; part < (file.partCount ?? 0); part++) {
        await env.PUSH_PAYLOADS.delete(chunkKey(uploadId, index, part));
      }
    }
    await env.PUSH_PAYLOADS.delete(metaKey(uploadId));
  } catch {
    // KV entries expire on their own; cleanup failure is not worth surfacing.
  }
}
