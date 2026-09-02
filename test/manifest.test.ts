import { describe, expect, it } from "vitest";
import { mergeManifests, normalizeManifest } from "../src/domain/manifest.js";

describe("manifest normalization", () => {
  it("accepts shorthand strings and long-form objects alike", () => {
    const manifest = normalizeManifest(
      {
        routes: ["checkout", { path: "/cart", module: "src/cart/routes.tsx", export: "CartPage" }],
        exports: ["Button", { name: "useCart", from: "src/cart/hooks.ts" }],
        deps: ["zod", "stripe@^14.0.0", { name: "@scope/ui", version: "1.2.3" }],
      },
      "cart",
    );

    expect(manifest.routes).toEqual([
      { path: "/cart", module: "src/cart/routes", export: "CartPage" },
      { path: "/checkout", module: "src/features/cart/routes" },
    ]);
    expect(manifest.exports).toEqual([
      { name: "Button", module: "src/features/cart/index" },
      { name: "useCart", module: "src/cart/hooks" },
    ]);
    expect(manifest.deps).toEqual([
      { name: "@scope/ui", version: "1.2.3" },
      { name: "stripe", version: "^14.0.0" },
      { name: "zod", version: "*" },
    ]);
  });

  it("rejects a malformed manifest with a located message", () => {
    expect(() => normalizeManifest({ routes: [{}] }, "cart")).toThrow(
      /manifest\.routes\[0\] is missing a "path"/,
    );
    expect(() => normalizeManifest({ deps: "zod" }, "cart")).toThrow(/manifest\.deps must be an array/);
  });
});

describe("manifest merging", () => {
  const auth = { featureSlug: "auth", manifest: normalizeManifest({ deps: ["zod@^4.0.0"] }, "auth") };
  const cart = { featureSlug: "cart", manifest: normalizeManifest({ deps: ["zod@^4.0.0", "idb"] }, "cart") };

  it("unions dependencies that agree", () => {
    const merged = mergeManifests([auth, cart]);
    expect(merged.deps).toEqual({ idb: "*", zod: "^4.0.0" });
    expect(merged.conflicts).toEqual([]);
  });

  it("is order-independent", () => {
    expect(mergeManifests([auth, cart])).toEqual(mergeManifests([cart, auth]));
  });

  it("flags a dependency version disagreement instead of picking a winner", () => {
    const merged = mergeManifests([
      auth,
      { featureSlug: "cart", manifest: normalizeManifest({ deps: ["zod@^3.0.0"] }, "cart") },
    ]);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]!.kind).toBe("dep");
    expect(merged.conflicts[0]!.message).toMatch(/"\^4\.0\.0".*"\^3\.0\.0"|"\^3\.0\.0".*"\^4\.0\.0"/);
  });

  it("lets an unpinned declaration defer to a pinned one", () => {
    const merged = mergeManifests([
      { featureSlug: "a", manifest: normalizeManifest({ deps: ["zod"] }, "a") },
      { featureSlug: "b", manifest: normalizeManifest({ deps: ["zod@^4.0.0"] }, "b") },
    ]);
    expect(merged.deps).toEqual({ zod: "^4.0.0" });
    expect(merged.conflicts).toEqual([]);
  });

  it("flags two features claiming the same route or export name", () => {
    const merged = mergeManifests([
      { featureSlug: "a", manifest: normalizeManifest({ routes: ["/x"], exports: ["Shared"] }, "a") },
      { featureSlug: "b", manifest: normalizeManifest({ routes: ["/x"], exports: ["Shared"] }, "b") },
    ]);
    expect(merged.conflicts.map((conflict) => conflict.kind).sort()).toEqual(["export", "route"]);
  });
});
