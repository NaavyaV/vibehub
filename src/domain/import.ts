/**
 * Validation and parsing of the plan JSON produced by the team's own LLM.
 *
 * This is the only place a plan enters VibeHub, and it is deliberately strict:
 * malformed input is rejected with a specific, human-readable message. Nothing
 * is inferred, repaired, or filled in on the team's behalf.
 */

import { z } from "zod";
import { findCycle, buildGraph } from "./graph.js";
import { ManifestError, normalizeManifest, type NormalizedManifest } from "./manifest.js";

export const FEATURE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RawFeatureSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  scope_notes: z.string().optional(),
  manifest: z.unknown().optional(),
  test_spec: z.string().nullable().optional(),
});

const RawPlanSchema = z.object({
  project_name: z.string(),
  features: z.array(RawFeatureSchema),
  shared_file_warnings: z.array(z.string()).optional(),
});

export interface ImportedFeature {
  slug: string;
  title: string;
  description: string;
  dependsOn: string[];
  scopeNotes: string;
  manifest: NormalizedManifest;
  testSpec: string | null;
}

export interface ImportedPlan {
  projectName: string;
  features: ImportedFeature[];
  sharedFileWarnings: string[];
  /** Non-blocking observations, e.g. duplicate dependency entries that were deduped. */
  warnings: string[];
}

export type ImportResult =
  | { ok: true; plan: ImportedPlan }
  | { ok: false; errors: string[] };

/**
 * Unwraps a fenced code block if present. The scoping prompt asks the LLM to
 * emit ```json … ```, so unwrapping a known wrapper is expected — but it is the
 * only transformation applied to the input.
 */
export function extractJsonText(raw: string): { ok: true; text: string } | { ok: false; errors: string[] } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, errors: ["Nothing was pasted."] };
  if (trimmed.startsWith("{")) return { ok: true, text: trimmed };

  const fence = /```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```/i.exec(trimmed);
  if (fence?.[1]) return { ok: true, text: fence[1].trim() };

  return {
    ok: false,
    errors: [
      "Expected a JSON object (optionally inside a ```json code fence), but the pasted text does not start with `{`. Paste only the JSON block from the final message, with no surrounding prose.",
    ],
  };
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out === "" ? "(root)" : out;
}

/** Validates raw pasted text end to end. */
export function validateImportText(raw: string): ImportResult {
  const extracted = extractJsonText(raw);
  if (!extracted.ok) return { ok: false, errors: extracted.errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.text);
  } catch (error) {
    return {
      ok: false,
      errors: [`The pasted text is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  return validateImportPlan(parsed);
}

/** Validates an already-parsed plan object. */
export function validateImportPlan(input: unknown): ImportResult {
  const shape = RawPlanSchema.safeParse(input);
  if (!shape.success) {
    return {
      ok: false,
      errors: shape.error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`),
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = shape.data;

  const projectName = raw.project_name.trim();
  if (projectName === "") errors.push("project_name must not be empty.");

  if (raw.features.length === 0) {
    errors.push("features must contain at least one feature.");
  }

  const seenSlugs = new Set<string>();
  const features: ImportedFeature[] = [];

  for (const [index, rawFeature] of raw.features.entries()) {
    const slug = rawFeature.id.trim();
    const where = `features[${index}]`;

    if (slug === "") {
      errors.push(`${where}.id must not be empty.`);
      continue;
    }
    if (!FEATURE_SLUG_PATTERN.test(slug)) {
      errors.push(
        `${where}.id "${slug}" must be lowercase-hyphenated (letters, digits, and single hyphens only).`,
      );
      continue;
    }
    if (seenSlugs.has(slug)) {
      errors.push(`Duplicate feature id "${slug}" — feature ids must be unique.`);
      continue;
    }
    seenSlugs.add(slug);

    const title = rawFeature.title.trim();
    if (title === "") errors.push(`Feature "${slug}" has an empty title.`);

    let manifest: NormalizedManifest;
    try {
      manifest = normalizeManifest(rawFeature.manifest, slug);
    } catch (error) {
      errors.push(
        `Feature "${slug}": ${error instanceof ManifestError ? error.message : String(error)}`,
      );
      continue;
    }

    const dependsOn: string[] = [];
    for (const dep of rawFeature.depends_on ?? []) {
      const trimmed = dep.trim();
      if (trimmed === "") {
        errors.push(`Feature "${slug}" has an empty entry in depends_on.`);
        continue;
      }
      if (trimmed === slug) {
        errors.push(`Feature "${slug}" depends on itself.`);
        continue;
      }
      if (dependsOn.includes(trimmed)) {
        warnings.push(`Feature "${slug}" lists "${trimmed}" in depends_on more than once; deduped.`);
        continue;
      }
      dependsOn.push(trimmed);
    }

    features.push({
      slug,
      title,
      description: (rawFeature.description ?? "").trim(),
      dependsOn,
      scopeNotes: (rawFeature.scope_notes ?? "").trim(),
      manifest,
      testSpec: rawFeature.test_spec?.trim() ? rawFeature.test_spec.trim() : null,
    });
  }

  // Unresolvable dependencies, reported by name so the team can fix the plan.
  for (const feature of features) {
    for (const dep of feature.dependsOn) {
      if (!seenSlugs.has(dep)) {
        errors.push(
          `feature '${feature.slug}' depends on '${dep}' which doesn't exist in this plan.`,
        );
      }
    }
  }

  if (errors.length === 0) {
    const graph = buildGraph(features.map((f) => ({ node: f.slug, dependsOn: f.dependsOn })));
    const cycle = findCycle(graph);
    if (cycle) {
      errors.push(`Circular dependency: ${cycle.join(" -> ")}. Features cannot depend on each other in a loop.`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    plan: {
      projectName,
      features,
      sharedFileWarnings: (raw.shared_file_warnings ?? []).map((w) => w.trim()).filter(Boolean),
      warnings,
    },
  };
}
