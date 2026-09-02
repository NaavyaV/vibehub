/**
 * Helpers for importing an existing GitHub repo.
 * Task lists are NOT inferred from folder names — agents add human-readable tasks instead.
 */

export interface HeuristicFeature {
  slug: string;
  title: string;
  description: string;
  dependsOn: string[];
  scopeNotes: string;
  manifest: { routes: string[]; exports: string[]; deps: string[] };
  testSpec: string | null;
}

/**
 * Returns an empty task list. Folder names like "components" or "App.tsx" are not
 * useful tasks — the pushing agent should call sync_project_tasks with actionable items.
 */
export function inferFeaturesFromPaths(
  _paths: string[],
  _projectName: string,
): HeuristicFeature[] {
  return [];
}

/** Compact tree text for the one-shot LLM prompt (capped). */
export function formatTreeForPrompt(paths: string[], maxLines = 250): string {
  const sorted = [...paths].sort().slice(0, maxLines);
  const lines = sorted.map((path) => path);
  if (paths.length > maxLines) lines.push(`…and ${paths.length - maxLines} more paths`);
  return lines.join("\n");
}
