/**
 * Feature (task) CRUD and status bookkeeping.
 *
 * Every mutation that can change the shape of the graph goes through
 * `assertGraphValid`, so the invariants enforced at import time (no orphaned
 * dependencies, no cycles) also hold for later edits.
 */

import { Repo, type FeatureWithDeps } from "../db/repo.js";
import { badRequest, notFound } from "../lib/errors.js";
import { FEATURE_SLUG_PATTERN } from "../domain/import.js";
import { buildGraph, findCycle } from "../domain/graph.js";
import { ManifestError, normalizeManifest } from "../domain/manifest.js";
import { fromPublicStatus, isDoneStatus, toPublicStatus } from "../domain/task-status.js";
import type { FeatureRow, FeatureStatus } from "../types.js";

export interface GraphView {
  features: FeatureWithDeps[];
  /** Keyed by slug. */
  graph: Map<string, string[]>;
  mergedSlugs: Set<string>;
}

export async function loadGraph(repo: Repo, projectId: string): Promise<GraphView> {
  const features = await repo.listFeaturesWithDeps(projectId);
  const graph = buildGraph(features.map((f) => ({ node: f.slug, dependsOn: f.dependsOn })));
  const mergedSlugs = new Set(features.filter((f) => isDoneStatus(f.status)).map((f) => f.slug));
  return { features, graph, mergedSlugs };
}

/**
 * A candidate graph, keyed by feature id so that renames cannot invalidate it.
 * Every mutation is checked in this form *before* anything is written, because
 * D1 gives us no transaction to roll back a rejected edit.
 */
export interface ProspectiveNode {
  id: string;
  slug: string;
  dependsOnIds: string[];
}

/** Placeholder id for a feature that does not exist yet. */
const PENDING_ID = "__pending__";

async function loadNodes(repo: Repo, projectId: string): Promise<ProspectiveNode[]> {
  const features = await repo.listFeatures(projectId);
  const edges = await repo.listDependencies(projectId);
  const depsById = new Map<string, string[]>();
  for (const edge of edges) {
    const list = depsById.get(edge.feature_id) ?? [];
    list.push(edge.depends_on_feature_id);
    depsById.set(edge.feature_id, list);
  }
  return features.map((feature) => ({
    id: feature.id,
    slug: feature.slug,
    dependsOnIds: depsById.get(feature.id) ?? [],
  }));
}

/** Throws a 400 describing the first problem, naming features by their plan id. */
export function assertProspectiveValid(nodes: ProspectiveNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const label = (id: string) => byId.get(id)?.slug ?? id;

  for (const node of nodes) {
    for (const dependency of node.dependsOnIds) {
      if (!byId.has(dependency)) {
        throw badRequest(
          `feature '${node.slug}' depends on '${label(dependency)}' which doesn't exist in this project.`,
        );
      }
    }
  }

  const cycle = findCycle(
    buildGraph(nodes.map((node) => ({ node: node.id, dependsOn: node.dependsOnIds }))),
  );
  if (cycle) {
    throw badRequest(`Circular dependency: ${formatCycle(cycle.map(label))}.`);
  }
}

/**
 * Rotates a cycle to start at its alphabetically first feature. The graph is
 * keyed by random ids, so without this the same cycle would be described
 * differently from one run to the next.
 */
function formatCycle(labels: string[]): string {
  const distinct = labels.slice(0, -1);
  if (distinct.length === 0) return labels.join(" -> ");
  let start = 0;
  for (let index = 1; index < distinct.length; index++) {
    if (distinct[index]! < distinct[start]!) start = index;
  }
  const rotated = [...distinct.slice(start), ...distinct.slice(0, start)];
  return [...rotated, rotated[0]].join(" -> ");
}

/**
 * Legacy hook: task status is no longer auto-flipped by dependency graph
 * (Assigned / Working / Done only). Still clears leftover "blocked" rows to Assigned.
 */
export async function recomputeBlockedStatuses(repo: Repo, projectId: string): Promise<void> {
  const view = await loadGraph(repo, projectId);
  for (const feature of view.features) {
    if (feature.status === "blocked") {
      await repo.updateFeature(feature.id, { status: "available" });
    }
  }
}

export async function requireFeature(
  repo: Repo,
  projectId: string,
  idOrSlug: string,
): Promise<FeatureRow> {
  const feature = await repo.findFeature(projectId, idOrSlug);
  if (!feature) throw notFound(`No feature "${idOrSlug}" in this project.`);
  return feature;
}

/** Resolves dependency references to ids without writing anything. */
function resolveDependencyIds(
  nodes: ProspectiveNode[],
  references: string[],
  selfId: string,
): string[] {
  const ids: string[] = [];
  for (const value of references) {
    const dep = nodes.find((node) => node.id === value || node.slug === value);
    if (!dep) throw badRequest(`Dependency '${value}' doesn't exist in this project.`);
    if (dep.id === selfId) throw badRequest("A feature cannot depend on itself.");
    if (!ids.includes(dep.id)) ids.push(dep.id);
  }
  return ids;
}

export interface FeatureInput {
  slug?: string;
  title?: string;
  description?: string;
  scopeNotes?: string;
  manifest?: unknown;
  testSpec?: string | null;
  status?: FeatureStatus | string;
  assignedTo?: string | null;
  dependsOn?: string[];
}

async function requireProjectMember(repo: Repo, projectId: string, userId: string): Promise<void> {
  const members = await repo.listMembers(projectId);
  if (!members.some((member) => member.id === userId)) {
    throw badRequest("Assignee must be a member of this project.");
  }
}

export async function createFeature(
  repo: Repo,
  projectId: string,
  input: FeatureInput,
): Promise<FeatureRow> {
  const assignedTo = input.assignedTo?.trim() || null;
  if (!assignedTo) {
    throw badRequest("Assign someone when creating a task.");
  }
  await requireProjectMember(repo, projectId, assignedTo);

  const nodes = await loadNodes(repo, projectId);
  const prepared = prepareCreate(nodes, input);

  assertProspectiveValid([
    ...nodes,
    { id: PENDING_ID, slug: prepared.slug, dependsOnIds: prepared.dependsOnIds },
  ]);

  const featureId = await insertPrepared(repo, projectId, prepared, nodes.length, assignedTo);
  await recomputeBlockedStatuses(repo, projectId);
  return requireFeature(repo, projectId, featureId);
}

interface PreparedFeature {
  slug: string;
  title: string;
  description: string;
  scopeNotes: string;
  manifest: unknown;
  testSpec: string | null;
  dependsOnIds: string[];
}

/** Validates and normalizes a create request. Performs no writes. */
function prepareCreate(
  nodes: ProspectiveNode[],
  input: FeatureInput,
  extraTakenSlugs: Set<string> = new Set(),
): PreparedFeature {
  const slug = (input.slug ?? "").trim();
  if (!FEATURE_SLUG_PATTERN.test(slug)) {
    throw badRequest(`Feature id "${slug}" must be lowercase-hyphenated.`);
  }
  if (nodes.some((node) => node.slug === slug) || extraTakenSlugs.has(slug)) {
    throw badRequest(`A feature with id "${slug}" already exists in this project.`);
  }
  const title = (input.title ?? "").trim();
  if (title === "") throw badRequest("Feature title is required.");

  let manifest;
  try {
    manifest = normalizeManifest(input.manifest, slug);
  } catch (error) {
    throw badRequest(error instanceof ManifestError ? error.message : String(error));
  }

  return {
    slug,
    title,
    description: (input.description ?? "").trim(),
    scopeNotes: (input.scopeNotes ?? "").trim(),
    manifest,
    testSpec: input.testSpec?.trim() ? input.testSpec.trim() : null,
    dependsOnIds: resolveDependencyIds(nodes, input.dependsOn ?? [], PENDING_ID),
  };
}

async function insertPrepared(
  repo: Repo,
  projectId: string,
  prepared: PreparedFeature,
  position: number,
  assignedTo: string | null = null,
): Promise<string> {
  const slugToId = await repo.insertFeatures(projectId, [
    {
      slug: prepared.slug,
      title: prepared.title,
      description: prepared.description,
      scopeNotes: prepared.scopeNotes,
      manifest: prepared.manifest,
      testSpec: prepared.testSpec,
      status: "available",
      assignedTo,
      position,
    },
  ]);
  const featureId = slugToId.get(prepared.slug);
  if (!featureId) throw new Error("Feature insert did not return an id");
  if (prepared.dependsOnIds.length > 0) {
    await repo.replaceDependencies(featureId, prepared.dependsOnIds);
  }
  return featureId;
}

export async function updateFeatureFields(
  repo: Repo,
  projectId: string,
  idOrSlug: string,
  input: FeatureInput,
): Promise<FeatureRow> {
  const feature = await requireFeature(repo, projectId, idOrSlug);
  const nodes = await loadNodes(repo, projectId);

  const fields: Parameters<Repo["updateFeature"]>[1] = {};
  if (input.slug !== undefined) {
    const slug = input.slug.trim();
    if (!FEATURE_SLUG_PATTERN.test(slug)) {
      throw badRequest(`Feature id "${slug}" must be lowercase-hyphenated.`);
    }
    if (nodes.some((node) => node.slug === slug && node.id !== feature.id)) {
      throw badRequest(`A feature with id "${slug}" already exists in this project.`);
    }
    fields.slug = slug;
  }
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title === "") throw badRequest("Feature title cannot be empty.");
    fields.title = title;
  }
  if (input.description !== undefined) fields.description = input.description.trim();
  if (input.scopeNotes !== undefined) fields.scope_notes = input.scopeNotes.trim();
  if (input.testSpec !== undefined) {
    fields.test_spec = input.testSpec && input.testSpec.trim() ? input.testSpec.trim() : null;
  }
  if (input.status !== undefined) {
    let nextStatus: FeatureStatus;
    try {
      nextStatus = fromPublicStatus(String(input.status));
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
    if (isDoneStatus(nextStatus)) {
      throw badRequest("A task only becomes Done when a push lands through the gate.");
    }
    if (isDoneStatus(feature.status) && toPublicStatus(nextStatus) === "assigned") {
      // Reopen Done → Assigned
      fields.status = "available";
    } else if (toPublicStatus(nextStatus) === "working") {
      const assignee = input.assignedTo !== undefined ? input.assignedTo : feature.assigned_to;
      if (!assignee) {
        throw badRequest("Assign someone before marking a task Working.");
      }
      fields.status = "in_progress";
    } else {
      fields.status = "available";
    }
  }
  if (input.assignedTo !== undefined) {
    if (input.assignedTo === null || input.assignedTo === "") {
      throw badRequest("Tasks must stay assigned to someone. Reassign instead of clearing.");
    }
    await requireProjectMember(repo, projectId, input.assignedTo);
    fields.assigned_to = input.assignedTo;
  }
  if (input.manifest !== undefined) {
    try {
      fields.manifest = JSON.stringify(normalizeManifest(input.manifest, fields.slug ?? feature.slug));
    } catch (error) {
      throw badRequest(error instanceof ManifestError ? error.message : String(error));
    }
  }

  // Resolve and validate the resulting graph before touching the database.
  let dependsOnIds: string[] | null = null;
  if (input.dependsOn !== undefined) {
    dependsOnIds = resolveDependencyIds(nodes, input.dependsOn, feature.id);
    assertProspectiveValid(
      nodes.map((node) =>
        node.id === feature.id
          ? { ...node, slug: fields.slug ?? node.slug, dependsOnIds: dependsOnIds as string[] }
          : node,
      ),
    );
  }

  await repo.updateFeature(feature.id, fields);
  if (dependsOnIds !== null) await repo.replaceDependencies(feature.id, dependsOnIds);

  await recomputeBlockedStatuses(repo, projectId);
  return requireFeature(repo, projectId, feature.id);
}

export async function deleteFeature(repo: Repo, projectId: string, idOrSlug: string): Promise<void> {
  const feature = await requireFeature(repo, projectId, idOrSlug);
  await repo.deleteFeature(feature.id);
  await recomputeBlockedStatuses(repo, projectId);
}

/** Mark a task Working when an agent starts it (must be assigned to that user). */
export async function startFeatureWork(
  repo: Repo,
  projectId: string,
  idOrSlug: string,
  userId: string,
): Promise<FeatureRow> {
  const feature = await requireFeature(repo, projectId, idOrSlug);
  if (isDoneStatus(feature.status)) {
    throw badRequest(`Task "${feature.slug}" is Done. Reopen it in the UI before working on it again.`);
  }
  if (feature.assigned_to && feature.assigned_to !== userId) {
    throw badRequest(`Task "${feature.slug}" is assigned to someone else.`);
  }
  if (!feature.assigned_to) {
    await requireProjectMember(repo, projectId, userId);
    await repo.updateFeature(feature.id, { assigned_to: userId, status: "in_progress" });
  } else {
    await repo.updateFeature(feature.id, { status: "in_progress" });
  }
  return requireFeature(repo, projectId, feature.id);
}

/**
 * Splits a feature into several. The original is deleted and its dependents are
 * repointed at every new part, which is the only interpretation that cannot
 * silently drop a dependency.
 */
export async function splitFeature(
  repo: Repo,
  projectId: string,
  idOrSlug: string,
  parts: FeatureInput[],
): Promise<FeatureRow[]> {
  if (parts.length < 2) throw badRequest("A split needs at least two parts.");
  const original = await requireFeature(repo, projectId, idOrSlug);
  if (isDoneStatus(original.status)) {
    throw badRequest(`Feature "${original.slug}" is Done and cannot be split.`);
  }

  const nodes = await loadNodes(repo, projectId);
  const remaining = nodes.filter((node) => node.id !== original.id);
  const originalDepIds = nodes.find((node) => node.id === original.id)?.dependsOnIds ?? [];

  // Every part is prepared and validated before a single row is written.
  const taken = new Set<string>();
  const prepared: Array<PreparedFeature & { placeholderId: string }> = [];
  parts.forEach((part, index) => {
    const ready = prepareCreate(
      remaining,
      { ...part, dependsOn: part.dependsOn ?? originalDepIds },
      taken,
    );
    taken.add(ready.slug);
    prepared.push({ ...ready, placeholderId: `${PENDING_ID}${index}` });
  });

  const partIds = prepared.map((part) => part.placeholderId);
  const dependents = remaining.filter((node) => node.dependsOnIds.includes(original.id));

  assertProspectiveValid([
    ...remaining.map((node) =>
      node.dependsOnIds.includes(original.id)
        ? {
            ...node,
            dependsOnIds: [...node.dependsOnIds.filter((id) => id !== original.id), ...partIds],
          }
        : node,
    ),
    ...prepared.map((part) => ({
      id: part.placeholderId,
      slug: part.slug,
      dependsOnIds: part.dependsOnIds,
    })),
  ]);

  const created: FeatureRow[] = [];
  const createdIds: string[] = [];
  for (const [index, part] of prepared.entries()) {
    const id = await insertPrepared(
      repo,
      projectId,
      part,
      remaining.length + index,
      original.assigned_to,
    );
    createdIds.push(id);
    created.push(await requireFeature(repo, projectId, id));
  }

  for (const dependent of dependents) {
    await repo.replaceDependencies(dependent.id, [
      ...dependent.dependsOnIds.filter((id) => id !== original.id),
      ...createdIds,
    ]);
  }

  await repo.deleteFeature(original.id);
  await recomputeBlockedStatuses(repo, projectId);
  return created;
}

/** Merges several features into one new feature, unioning deps and manifests. */
export async function mergeFeatures(
  repo: Repo,
  projectId: string,
  sourceIdsOrSlugs: string[],
  target: FeatureInput,
): Promise<FeatureRow> {
  if (sourceIdsOrSlugs.length < 2) throw badRequest("Merging needs at least two features.");
  const sources: FeatureRow[] = [];
  for (const value of sourceIdsOrSlugs) sources.push(await requireFeature(repo, projectId, value));
  if (sources.some((f) => isDoneStatus(f.status))) {
    throw badRequest("Done features are part of the version history and cannot be combined.");
  }

  const nodes = await loadNodes(repo, projectId);
  const sourceIds = new Set(sources.map((f) => f.id));
  const remaining = nodes.filter((node) => !sourceIds.has(node.id));

  const unionDepIds = new Set<string>();
  for (const node of nodes) {
    if (!sourceIds.has(node.id)) continue;
    for (const dependency of node.dependsOnIds) {
      if (!sourceIds.has(dependency)) unionDepIds.add(dependency);
    }
  }

  const prepared = prepareCreate(remaining, {
    ...target,
    dependsOn: target.dependsOn ?? [...unionDepIds],
    manifest:
      target.manifest ?? {
        routes: sources.flatMap((f) => safeManifest(f).routes),
        exports: sources.flatMap((f) => safeManifest(f).exports),
        deps: sources.flatMap((f) => safeManifest(f).deps),
      },
    scopeNotes:
      target.scopeNotes ??
      sources
        .map((f) => f.scope_notes)
        .filter(Boolean)
        .join("\n"),
  });

  const dependents = remaining.filter((node) =>
    node.dependsOnIds.some((id) => sourceIds.has(id)),
  );

  assertProspectiveValid([
    ...remaining.map((node) =>
      node.dependsOnIds.some((id) => sourceIds.has(id))
        ? {
            ...node,
            dependsOnIds: [...node.dependsOnIds.filter((id) => !sourceIds.has(id)), PENDING_ID],
          }
        : node,
    ),
    { id: PENDING_ID, slug: prepared.slug, dependsOnIds: prepared.dependsOnIds },
  ]);

  const createdId = await insertPrepared(
    repo,
    projectId,
    prepared,
    remaining.length,
    sources.find((s) => s.assigned_to)?.assigned_to ?? null,
  );

  for (const dependent of dependents) {
    await repo.replaceDependencies(dependent.id, [
      ...dependent.dependsOnIds.filter((id) => !sourceIds.has(id)),
      createdId,
    ]);
  }

  for (const source of sources) await repo.deleteFeature(source.id);

  await recomputeBlockedStatuses(repo, projectId);
  return requireFeature(repo, projectId, createdId);
}

export function safeManifest(feature: FeatureRow) {
  try {
    return normalizeManifest(JSON.parse(feature.manifest), feature.slug);
  } catch {
    return { routes: [], exports: [], deps: [] };
  }
}

export interface TaskSyncInput {
  title: string;
  description?: string;
  dependsOn?: string[];
  slug?: string;
  assignedTo?: string;
}

function slugFromTitle(title: string, taken: Set<string>): string {
  let base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!base || !FEATURE_SLUG_PATTERN.test(base)) base = "task";
  let slug = base;
  let suffix = 2;
  while (taken.has(slug)) {
    slug = `${base.slice(0, 40)}-${suffix}`;
    suffix += 1;
  }
  taken.add(slug);
  return slug;
}

/**
 * Upsert open tasks from an agent-authored list. Never call this as deploy recovery.
 * - Matches existing open tasks by slug or title and preserves assignee + Working status.
 * - Only deletes open tasks that are absent from the new list.
 * - Done tasks are never touched.
 * Passing an empty array is a no-op.
 */
export async function syncProjectTasks(
  repo: Repo,
  projectId: string,
  tasks: TaskSyncInput[],
  defaultAssignee?: string | null,
): Promise<{ created: number; updated: number; deleted: number; skipped: true } | { created: number; updated: number; deleted: number; skipped: false }> {
  if (tasks.length === 0) {
    return { created: 0, updated: 0, deleted: 0, skipped: true };
  }

  const existing = await repo.listFeatures(projectId);
  const done = existing.filter((feature) => isDoneStatus(feature.status));
  const open = existing.filter((feature) => !isDoneStatus(feature.status));
  const taken = new Set(done.map((feature) => feature.slug));

  const prepared: Array<{
    slug: string;
    title: string;
    description: string;
    dependsOn: string[];
    assignedTo: string | null;
    matchId?: string;
    keepStatus?: FeatureStatus;
  }> = [];

  for (const task of tasks) {
    const title = task.title.trim();
    if (title === "") continue;
    const titleKey = title.toLowerCase();
    const match =
      open.find(
        (feature) =>
          (task.slug && feature.slug === task.slug.trim()) ||
          feature.title.trim().toLowerCase() === titleKey,
      ) ?? null;

    let slug: string;
    if (match) {
      slug = match.slug;
      taken.add(slug);
    } else if (task.slug?.trim() && FEATURE_SLUG_PATTERN.test(task.slug.trim()) && !taken.has(task.slug.trim())) {
      slug = task.slug.trim();
      taken.add(slug);
    } else {
      slug = slugFromTitle(title, taken);
    }

    prepared.push({
      slug,
      title,
      description: task.description?.trim() ?? "",
      dependsOn: task.dependsOn ?? [],
      assignedTo: task.assignedTo?.trim() || match?.assigned_to || defaultAssignee || null,
      matchId: match?.id,
      keepStatus: match?.status,
    });
  }

  const keepIds = new Set(prepared.map((item) => item.matchId).filter(Boolean) as string[]);
  let deleted = 0;
  for (const feature of open) {
    if (keepIds.has(feature.id)) continue;
    await repo.deleteFeature(feature.id);
    deleted += 1;
  }

  let created = 0;
  let updated = 0;
  for (const item of prepared) {
    if (item.matchId) {
      await updateFeatureFields(repo, projectId, item.matchId, {
        title: item.title,
        description: item.description,
        dependsOn: item.dependsOn,
        ...(item.assignedTo ? { assignedTo: item.assignedTo } : {}),
        // Keep Working if it was Working; otherwise leave Assigned.
        status: item.keepStatus === "in_progress" || item.keepStatus === "working" ? "working" : "assigned",
      });
      updated += 1;
    } else {
      if (!item.assignedTo) {
        throw badRequest(
          `Task "${item.title}" needs an assignee. Pass assignedTo or call sync_project_tasks as the project member who should own new tasks.`,
        );
      }
      await createFeature(repo, projectId, {
        slug: item.slug,
        title: item.title,
        description: item.description,
        dependsOn: item.dependsOn,
        assignedTo: item.assignedTo,
      });
      created += 1;
    }
  }

  await recomputeBlockedStatuses(repo, projectId);
  return { created, updated, deleted, skipped: false };
}
