import { describe, expect, it } from "vitest";
import { validateImportPlan, validateImportText } from "../src/domain/import.js";

const validPlan = {
  project_name: "Storefront",
  features: [
    {
      id: "payments-api",
      title: "Payments API",
      description: "Server-side payment intents.",
      depends_on: [],
      scope_notes: "src/features/payments-api/**",
      manifest: { routes: [], exports: ["createIntent"], deps: ["stripe@^14.0.0"] },
      test_spec: null,
    },
    {
      id: "checkout",
      title: "Checkout",
      description: "Checkout page.",
      depends_on: ["payments-api"],
      scope_notes: "src/features/checkout/**",
      manifest: { routes: ["/checkout"], exports: [], deps: [] },
      test_spec: "Visiting /checkout renders the cart.",
    },
  ],
  shared_file_warnings: ["Both features touch the currency formatter."],
};

describe("plan import", () => {
  it("accepts a well-formed plan and normalizes the manifests", () => {
    const result = validateImportPlan(validPlan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.projectName).toBe("Storefront");
    expect(result.plan.features.map((f) => f.slug)).toEqual(["payments-api", "checkout"]);
    expect(result.plan.sharedFileWarnings).toHaveLength(1);

    const payments = result.plan.features[0]!;
    expect(payments.manifest.deps).toEqual([{ name: "stripe", version: "^14.0.0" }]);
    expect(payments.manifest.exports).toEqual([
      { name: "createIntent", module: "src/features/payments-api/index" },
    ]);

    const checkout = result.plan.features[1]!;
    expect(checkout.manifest.routes).toEqual([
      { path: "/checkout", module: "src/features/checkout/routes" },
    ]);
    expect(checkout.testSpec).toBe("Visiting /checkout renders the cart.");
  });

  it("names the exact unresolvable dependency", () => {
    const result = validateImportPlan({
      ...validPlan,
      features: [{ ...validPlan.features[1]! }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      "feature 'checkout' depends on 'payments-api' which doesn't exist in this plan.",
    );
  });

  it("rejects circular dependencies and shows the loop", () => {
    const result = validateImportPlan({
      project_name: "Loop",
      features: [
        { id: "a", title: "A", depends_on: ["b"] },
        { id: "b", title: "B", depends_on: ["c"] },
        { id: "c", title: "C", depends_on: ["a"] },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/^Circular dependency: a -> b -> c -> a\./);
  });

  it("rejects a self-dependency", () => {
    const result = validateImportPlan({
      project_name: "Self",
      features: [{ id: "a", title: "A", depends_on: ["a"] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('Feature "a" depends on itself.');
  });

  it("rejects ids that are not lowercase-hyphenated", () => {
    const result = validateImportPlan({
      project_name: "Bad ids",
      features: [{ id: "Checkout Flow", title: "Checkout" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/must be lowercase-hyphenated/);
  });

  it("rejects duplicate feature ids", () => {
    const result = validateImportPlan({
      project_name: "Dupes",
      features: [
        { id: "a", title: "A" },
        { id: "a", title: "A again" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('Duplicate feature id "a" — feature ids must be unique.');
  });

  it("reports missing required fields with a path", () => {
    const result = validateImportPlan({ project_name: "X", features: [{ title: "No id" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/^features\[0\]\.id:/);
  });

  it("unwraps a fenced code block", () => {
    const pasted = ["Here you go:", "```json", JSON.stringify(validPlan, null, 2), "```"].join("\n");
    const result = validateImportText(pasted);
    expect(result.ok).toBe(true);
  });

  it("explains prose that is not JSON instead of guessing at it", () => {
    const result = validateImportText("Sure! I think you want three features...");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/does not start with/);
  });

  it("dedupes repeated dependency entries as a warning, not an error", () => {
    const result = validateImportPlan({
      project_name: "Dupe deps",
      features: [
        { id: "a", title: "A" },
        { id: "b", title: "B", depends_on: ["a", "a"] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.features[1]!.dependsOn).toEqual(["a"]);
    expect(result.plan.warnings[0]).toMatch(/more than once/);
  });
});
