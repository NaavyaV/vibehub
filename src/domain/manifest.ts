/**
 * Feature manifests: the declarative alternative to hand-editing shared files.
 *
 * A feature never edits the router index, the app root, or package.json. It
 * declares what it exposes, and VibeHub generates the wiring from the union of
 * all merged manifests (see codegen.ts).
 *
 * Manifest entries may be written in shorthand (a bare string) or long form (an
 * object). Normalization here is purely mechanical — no guessing about intent.
 */

export interface RouteEntry {
  /** URL path, e.g. "/checkout". */
  path: string;
  /** Module that provides the route component, repo-relative and extensionless. */
  module: string;
  /** Named export to use as the component. Defaults to the module's default export. */
  export?: string;
}

export interface ExportEntry {
  /** Exported symbol name other features import. */
  name: string;
  /** Module that provides it, repo-relative and extensionless. */
  module: string;
}

export interface DepEntry {
  name: string;
  /** npm version range. `"*"` means the feature did not pin a version. */
  version: string;
}

export interface NormalizedManifest {
  routes: RouteEntry[];
  exports: ExportEntry[];
  deps: DepEntry[];
}

export const EMPTY_MANIFEST: NormalizedManifest = { routes: [], exports: [], deps: [] };

export function defaultRouteModule(featureSlug: string): string {
  return `src/features/${featureSlug}/routes`;
}

export function defaultExportModule(featureSlug: string): string {
  return `src/features/${featureSlug}/index`;
}

function stripExtension(module: string): string {
  return module.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
}

export class ManifestError extends Error {}

function normalizeRoute(raw: unknown, featureSlug: string, index: number): RouteEntry {
  const where = `manifest.routes[${index}]`;
  if (typeof raw === "string") {
    const path = raw.trim();
    if (!path) throw new ManifestError(`${where} is an empty string`);
    return { path: ensureLeadingSlash(path), module: defaultRouteModule(featureSlug) };
  }
  if (!isRecord(raw)) {
    throw new ManifestError(`${where} must be a string or an object, got ${typeName(raw)}`);
  }
  const path = firstString(raw, ["path", "route", "url"]);
  if (!path) throw new ManifestError(`${where} is missing a "path"`);
  const module = firstString(raw, ["module", "file", "component_module", "from"]);
  const exportName = firstString(raw, ["export", "component", "element"]);
  const entry: RouteEntry = {
    path: ensureLeadingSlash(path),
    module: stripExtension(module ?? defaultRouteModule(featureSlug)),
  };
  if (exportName) entry.export = exportName;
  return entry;
}

function normalizeExport(raw: unknown, featureSlug: string, index: number): ExportEntry {
  const where = `manifest.exports[${index}]`;
  if (typeof raw === "string") {
    const name = raw.trim();
    if (!name) throw new ManifestError(`${where} is an empty string`);
    return { name, module: defaultExportModule(featureSlug) };
  }
  if (!isRecord(raw)) {
    throw new ManifestError(`${where} must be a string or an object, got ${typeName(raw)}`);
  }
  const name = firstString(raw, ["name", "export", "symbol"]);
  if (!name) throw new ManifestError(`${where} is missing a "name"`);
  const module = firstString(raw, ["module", "from", "file", "path"]);
  return { name, module: stripExtension(module ?? defaultExportModule(featureSlug)) };
}

function normalizeDep(raw: unknown, index: number): DepEntry {
  const where = `manifest.deps[${index}]`;
  if (typeof raw === "string") {
    const spec = raw.trim();
    if (!spec) throw new ManifestError(`${where} is an empty string`);
    return splitDepSpec(spec);
  }
  if (!isRecord(raw)) {
    throw new ManifestError(`${where} must be a string or an object, got ${typeName(raw)}`);
  }
  const name = firstString(raw, ["name", "package", "dep"]);
  if (!name) throw new ManifestError(`${where} is missing a "name"`);
  const version = firstString(raw, ["version", "range", "spec"]);
  return { name, version: version ?? "*" };
}

/** Handles scoped packages: "@scope/pkg@^1.0.0" -> { "@scope/pkg", "^1.0.0" }. */
function splitDepSpec(spec: string): DepEntry {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: "*" };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) || "*" };
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** Accepts the loose manifest shape from an imported plan and tightens it. */
export function normalizeManifest(raw: unknown, featureSlug: string): NormalizedManifest {
  if (raw === undefined || raw === null) return { routes: [], exports: [], deps: [] };
  if (!isRecord(raw)) {
    throw new ManifestError(`manifest must be an object, got ${typeName(raw)}`);
  }
  const routes = asArray(raw.routes, "manifest.routes").map((entry, i) =>
    normalizeRoute(entry, featureSlug, i),
  );
  const exports = asArray(raw.exports, "manifest.exports").map((entry, i) =>
    normalizeExport(entry, featureSlug, i),
  );
  const deps = asArray(raw.deps ?? raw.dependencies, "manifest.deps").map((entry, i) =>
    normalizeDep(entry, i),
  );
  return {
    routes: sortBy(routes, (r) => r.path),
    exports: sortBy(exports, (e) => e.name),
    deps: sortBy(deps, (d) => d.name),
  };
}

function asArray(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ManifestError(`${where} must be an array`);
  return value;
}

function sortBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export interface ManifestConflict {
  kind: "route" | "export" | "dep";
  key: string;
  message: string;
}

export interface MergedManifest {
  routes: (RouteEntry & { featureSlug: string })[];
  exports: (ExportEntry & { featureSlug: string })[];
  /** name -> resolved version range. */
  deps: Record<string, string>;
  conflicts: ManifestConflict[];
}

export interface ManifestSource {
  featureSlug: string;
  manifest: NormalizedManifest;
}

/**
 * Unions manifests across features. Deterministic: output ordering depends only
 * on route path / export name / dep name, not on input ordering or merge order.
 *
 * Version mismatches are reported as conflicts rather than resolved by picking a
 * winner — VibeHub never guesses.
 */
export function mergeManifests(sources: ManifestSource[]): MergedManifest {
  const conflicts: ManifestConflict[] = [];
  const routes = new Map<string, RouteEntry & { featureSlug: string }>();
  const exports = new Map<string, ExportEntry & { featureSlug: string }>();
  const deps = new Map<string, { version: string; featureSlug: string }>();

  const ordered = sortBy(sources, (s) => s.featureSlug);

  for (const { featureSlug, manifest } of ordered) {
    for (const route of manifest.routes) {
      const existing = routes.get(route.path);
      if (existing && existing.featureSlug !== featureSlug) {
        conflicts.push({
          kind: "route",
          key: route.path,
          message: `Route "${route.path}" is declared by both "${existing.featureSlug}" and "${featureSlug}"`,
        });
        continue;
      }
      routes.set(route.path, { ...route, featureSlug });
    }

    for (const exported of manifest.exports) {
      const existing = exports.get(exported.name);
      if (existing && existing.featureSlug !== featureSlug) {
        conflicts.push({
          kind: "export",
          key: exported.name,
          message: `Export "${exported.name}" is declared by both "${existing.featureSlug}" and "${featureSlug}"`,
        });
        continue;
      }
      exports.set(exported.name, { ...exported, featureSlug });
    }

    for (const dep of manifest.deps) {
      const existing = deps.get(dep.name);
      if (!existing) {
        deps.set(dep.name, { version: dep.version, featureSlug });
        continue;
      }
      if (existing.version === dep.version) continue;
      // An unpinned declaration ("*") defers to a pinned one — that is a union,
      // not a disagreement.
      if (existing.version === "*") {
        deps.set(dep.name, { version: dep.version, featureSlug });
        continue;
      }
      if (dep.version === "*") continue;
      conflicts.push({
        kind: "dep",
        key: dep.name,
        message: `Dependency "${dep.name}" is requested as "${existing.version}" by "${existing.featureSlug}" and "${dep.version}" by "${featureSlug}"`,
      });
    }
  }

  return {
    routes: sortBy([...routes.values()], (r) => r.path),
    exports: sortBy([...exports.values()], (e) => e.name),
    deps: Object.fromEntries(
      sortBy([...deps.entries()], ([name]) => name).map(([name, value]) => [name, value.version]),
    ),
    conflicts: sortBy(conflicts, (c) => `${c.kind}:${c.key}`),
  };
}
