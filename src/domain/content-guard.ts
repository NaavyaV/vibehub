/**
 * Guards against pushing something that is not the file.
 *
 * Two real failure modes, both of which have already cost a version:
 *
 *   1. The agent stages the real content somewhere else and sends a stand-in
 *      like "PLACEHOLDER", meaning to swap it in later. It never does.
 *   2. The agent sends a truncated file — a few hundred bytes where the repo has
 *      sixteen kilobytes — and the merge quietly destroys the original.
 *
 * Neither is a merge conflict, so nothing else in the pipeline catches them.
 */

/** Content this short is judged against the placeholder patterns. */
const SUSPICIOUS_LENGTH = 400;

const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^place_?holder$/i, label: "PLACEHOLDER" },
  { pattern: /^<+\s*place_?holder\s*>+$/i, label: "<placeholder>" },
  { pattern: /^(?:todo|tbd|fixme)\b/i, label: "TODO/TBD marker" },
  { pattern: /^replace_?me$/i, label: "REPLACE_ME" },
  { pattern: /^content_?here$/i, label: "CONTENT_HERE" },
  { pattern: /^\.{3,}$/, label: "an ellipsis" },
  { pattern: /^<[^>]*\b(?:paste|content|file|full)\b[^>]*>$/i, label: "an angle-bracket stand-in" },
  { pattern: /^\[[^\]]*\b(?:paste|content|file|full)\b[^\]]*\]$/i, label: "a bracketed stand-in" },
  {
    pattern: /\b(?:paste|insert|swap)\s+(?:the\s+)?(?:real|full|actual)?\s*(?:file\s+)?contents?\b/i,
    label: "an instruction to paste the content later",
  },
  { pattern: /\bsee\s+\/tmp\//i, label: "a reference to a staged temp file" },
];

/**
 * A short human-readable reason when `content` looks like a stand-in rather than
 * a real file, or null when it looks like genuine content.
 */
export function placeholderReason(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed === "") return null; // Deliberately emptying a file is a real edit.
  if (trimmed.length > SUSPICIOUS_LENGTH) return null;

  for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) return label;
  }
  return null;
}

export interface OverwriteRisk {
  path: string;
  existing_bytes: number;
  new_bytes: number;
  removed_bytes: number;
}

/** Existing files below this are too small for a shrink to mean anything. */
const MIN_EXISTING_BYTES = 512;
/** Keeping less than this share of a file is treated as a wipe, not an edit. */
const MAX_SHRINK_RATIO = 0.25;

/**
 * True when replacing `existing` with `next` destroys most of the file. Callers
 * let it through only when the agent explicitly said the shrink is intended.
 */
export function isDestructiveOverwrite(existingBytes: number, newBytes: number): boolean {
  if (existingBytes < MIN_EXISTING_BYTES) return false;
  return newBytes < existingBytes * MAX_SHRINK_RATIO;
}

export function describeOverwriteRisk(risk: OverwriteRisk): string {
  const kept = risk.existing_bytes === 0 ? 0 : Math.round((risk.new_bytes / risk.existing_bytes) * 100);
  return `${risk.path}: main has ${risk.existing_bytes} bytes, your push has ${risk.new_bytes} (${kept}% of it, ${risk.removed_bytes} bytes removed)`;
}
