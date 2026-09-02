/**
 * Dependency graph utilities. Keys are opaque strings so the same code serves
 * both the import-time graph (feature slugs) and the persisted graph (row ids).
 */

export type DependencyGraph = Map<string, string[]>;

export function buildGraph(edges: Iterable<{ node: string; dependsOn: string[] }>): DependencyGraph {
  const graph: DependencyGraph = new Map();
  for (const { node, dependsOn } of edges) graph.set(node, [...dependsOn]);
  return graph;
}

/**
 * Returns a cycle as an ordered path (first node repeated at the end), or null.
 * Deterministic: nodes and edges are visited in sorted order so the reported
 * cycle is stable across runs.
 */
export function findCycle(graph: DependencyGraph): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    const current = state.get(node);
    if (current === "done") return null;
    if (current === "visiting") {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    state.set(node, "visiting");
    stack.push(node);
    for (const dep of [...(graph.get(node) ?? [])].sort()) {
      if (!graph.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };

  for (const node of [...graph.keys()].sort()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

/** Dependency-first ordering. Throws if the graph has a cycle. */
export function topoOrder(graph: DependencyGraph): string[] {
  const cycle = findCycle(graph);
  if (cycle) throw new Error(`Cannot order a cyclic graph: ${cycle.join(" -> ")}`);

  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (node: string) => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const dep of [...(graph.get(node) ?? [])].sort()) {
      if (graph.has(dep)) visit(dep);
    }
    order.push(node);
  };
  for (const node of [...graph.keys()].sort()) visit(node);
  return order;
}

/** Dependencies of `node` that are not yet merged. */
export function unmetDependencies(
  node: string,
  graph: DependencyGraph,
  mergedNodes: ReadonlySet<string>,
): string[] {
  return [...(graph.get(node) ?? [])].filter((dep) => !mergedNodes.has(dep)).sort();
}

export function isUnlocked(
  node: string,
  graph: DependencyGraph,
  mergedNodes: ReadonlySet<string>,
): boolean {
  return unmetDependencies(node, graph, mergedNodes).length === 0;
}

/**
 * Nodes that depend (directly) on `node`. Used to unlock work after a merge.
 */
export function directDependents(node: string, graph: DependencyGraph): string[] {
  const dependents: string[] = [];
  for (const [candidate, deps] of graph) {
    if (deps.includes(node)) dependents.push(candidate);
  }
  return dependents.sort();
}
