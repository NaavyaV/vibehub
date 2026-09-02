import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { Repo } from "../src/db/repo.js";
import { validateImportPlan } from "../src/domain/import.js";
import {
  createFeature,
  deleteFeature,
  loadGraph,
  mergeFeatures,
  recomputeBlockedStatuses,
  splitFeature,
  updateFeatureFields,
} from "../src/services/features.js";
import { getMyTask, getProjectContext, importPlan } from "../src/services/projects.js";
import type { HttpError } from "../src/lib/errors.js";
import type { AppEnv } from "../src/types.js";

const plan = {
  project_name: "Storefront",
  features: [
    { id: "auth", title: "Auth", scope_notes: "src/features/auth/**", manifest: { exports: ["useSession"] } },
    { id: "cart", title: "Cart", scope_notes: "src/features/cart/**", manifest: { routes: ["/cart"] } },
    {
      id: "checkout",
      title: "Checkout",
      depends_on: ["auth", "cart"],
      scope_notes: "src/features/checkout/**",
      manifest: { routes: ["/checkout"], deps: ["stripe@^14.0.0"] },
      test_spec: "Checkout submits an order.",
    },
  ],
  shared_file_warnings: ["Both cart and checkout format currency."],
};

async function setup() {
  const repo = new Repo(env.DB);
  const user = await repo.upsertGithubUser({
    githubLogin: `dev-${crypto.randomUUID().slice(0, 8)}`,
    displayName: "Dev",
    avatarUrl: null,
    githubTokenEnc: null,
  });
  const parsed = validateImportPlan(plan);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const { project } = await importPlan(repo, {
    plan: parsed.plan,
    userId: user.id,
    testMode: "skip",
  });
  return { repo, project, userId: user.id };
}

async function expectRejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as HttpError).message;
  }
  throw new Error("Expected the operation to be rejected");
}

describe("project import", () => {
  let context: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    context = await setup();
  });

  it("creates version 0, the features, and the dependency edges", async () => {
    const { repo, project } = context;
    expect(project.current_version).toBe(0);
    expect(await repo.getVersion(project.id, 0)).not.toBeNull();

    const view = await loadGraph(repo, project.id);
    expect(view.features.map((feature) => feature.slug).sort()).toEqual(["auth", "cart", "checkout"]);
    expect(view.features.find((feature) => feature.slug === "checkout")!.dependsOn).toEqual([
      "auth",
      "cart",
    ]);
  });

  it("starts every feature as available (Assigned); deps are advisory via blocked_by", async () => {
    const view = await loadGraph(context.repo, context.project.id);
    const statuses = Object.fromEntries(view.features.map((f) => [f.slug, f.status]));
    expect(statuses).toEqual({ auth: "available", cart: "available", checkout: "available" });
    expect(view.features.find((f) => f.slug === "checkout")!.dependsOn).toEqual(["auth", "cart"]);
  });

  it("surfaces an empty shared file warnings list (legacy field, unused)", async () => {
    const result = await getProjectContext(env as AppEnv, context.repo, context.project.id);
    expect(result.requirements.shared_file_warnings).toEqual([]);
  });

  it("clears legacy blocked status without auto-flipping on deps", async () => {
    const { repo, project } = context;
    const checkout = await repo.findFeature(project.id, "checkout");
    await repo.updateFeature(checkout!.id, { status: "blocked" });
    await recomputeBlockedStatuses(repo, project.id);
    expect((await repo.findFeature(project.id, "checkout"))!.status).toBe("available");
  });
});

describe("task CRUD validation", () => {
  let context: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    context = await setup();
  });

  it("adds a feature as Assigned when someone is assigned", async () => {
    const { repo, project, userId } = context;
    const created = await createFeature(repo, project.id, {
      slug: "receipts",
      title: "Receipts",
      dependsOn: ["checkout"],
      scopeNotes: "src/features/receipts/**",
      assignedTo: userId,
    });
    expect(created.status).toBe("available");
    expect(created.assigned_to).toBe(userId);
  });

  it("requires an assignee when creating a task", async () => {
    const message = await expectRejection(
      createFeature(context.repo, context.project.id, {
        slug: "receipts",
        title: "Receipts",
      }),
    );
    expect(message).toMatch(/Assign someone/);
  });

  it("refuses a dependency on a feature that does not exist", async () => {
    const message = await expectRejection(
      createFeature(context.repo, context.project.id, {
        slug: "receipts",
        title: "Receipts",
        dependsOn: ["ghost"],
        assignedTo: context.userId,
      }),
    );
    expect(message).toBe("Dependency 'ghost' doesn't exist in this project.");
  });

  it("refuses an edit that would create a cycle", async () => {
    const message = await expectRejection(
      updateFeatureFields(context.repo, context.project.id, "auth", { dependsOn: ["checkout"] }),
    );
    expect(message).toMatch(/^Circular dependency: auth -> checkout -> auth\./);
  });

  it("leaves the graph untouched when an edit is refused", async () => {
    const { repo, project, userId } = context;
    const before = await loadGraph(repo, project.id);

    await expectRejection(
      updateFeatureFields(repo, project.id, "auth", { title: "Renamed", dependsOn: ["checkout"] }),
    );

    const after = await loadGraph(repo, project.id);
    expect(after.features.map((f) => ({ slug: f.slug, title: f.title, dependsOn: f.dependsOn }))).toEqual(
      before.features.map((f) => ({ slug: f.slug, title: f.title, dependsOn: f.dependsOn })),
    );
    // A later valid operation must still work, rather than tripping over debris.
    const created = await createFeature(repo, project.id, {
      slug: "receipts",
      title: "Receipts",
      assignedTo: userId,
    });
    expect(created.slug).toBe("receipts");
  });

  it("leaves the graph untouched when a split is refused", async () => {
    const { repo, project } = context;
    const before = await loadGraph(repo, project.id);

    // The second part reuses an existing id, so the whole split must be rejected.
    const message = await expectRejection(
      splitFeature(repo, project.id, "cart", [
        { slug: "cart-ui", title: "Cart UI" },
        { slug: "auth", title: "Clashes with an existing feature" },
      ]),
    );
    expect(message).toMatch(/already exists/);

    const after = await loadGraph(repo, project.id);
    expect(after.features.map((f) => f.slug).sort()).toEqual(
      before.features.map((f) => f.slug).sort(),
    );
  });

  it("refuses a non-hyphenated feature id", async () => {
    const message = await expectRejection(
      createFeature(context.repo, context.project.id, {
        slug: "Bad Id",
        title: "Bad",
        assignedTo: context.userId,
      }),
    );
    expect(message).toMatch(/must be lowercase-hyphenated/);
  });

  it("allows deleting a Done feature", async () => {
    const { repo, project } = context;
    const auth = await repo.findFeature(project.id, "auth");
    await repo.updateFeature(auth!.id, { status: "merged" });
    await deleteFeature(repo, project.id, "auth");
    expect(await repo.findFeature(project.id, "auth")).toBeNull();
  });

  it("deletes a feature that already created a version and has push history", async () => {
    const { repo, project, userId } = context;
    const auth = (await repo.findFeature(project.id, "auth"))!;
    await repo.insertVersion({
      projectId: project.id,
      versionNumber: 1,
      commitSha: "abc123",
      createdByFeatureId: auth.id,
      changedPaths: ["src/features/auth/index.ts"],
    });
    await repo.createPush({
      projectId: project.id,
      featureId: auth.id,
      basedOnVersion: 0,
      changedPaths: ["src/features/auth/index.ts"],
      notes: null,
      callbackTokenHash: null,
      webhookUrl: null,
      createdBy: userId,
    });
    await repo.updateFeature(auth.id, { status: "merged" });

    await deleteFeature(repo, project.id, "auth");

    expect(await repo.findFeature(project.id, "auth")).toBeNull();
    // History survives; it just no longer points at a feature.
    expect(await repo.getVersion(project.id, 1)).not.toBeNull();
  });

  it("reopens a Done feature to Assigned", async () => {
    const { repo, project, userId } = context;
    const auth = await repo.findFeature(project.id, "auth");
    await repo.updateFeature(auth!.id, { status: "merged", assigned_to: userId });
    const reopened = await updateFeatureFields(repo, project.id, "auth", { status: "assigned" });
    expect(reopened.status).toBe("available");
  });

  it("splits a feature and repoints its dependents at every part", async () => {
    const { repo, project } = context;
    await splitFeature(repo, project.id, "cart", [
      { slug: "cart-ui", title: "Cart UI", scopeNotes: "src/features/cart-ui/**" },
      { slug: "cart-store", title: "Cart store", scopeNotes: "src/features/cart-store/**" },
    ]);

    const view = await loadGraph(repo, project.id);
    expect(view.features.map((f) => f.slug)).not.toContain("cart");
    expect(view.features.find((f) => f.slug === "checkout")!.dependsOn).toEqual([
      "auth",
      "cart-store",
      "cart-ui",
    ]);
  });

  it("combines features, unioning their dependencies and manifests", async () => {
    const { repo, project, userId } = context;
    await createFeature(repo, project.id, {
      slug: "receipts",
      title: "Receipts",
      dependsOn: ["checkout"],
      assignedTo: userId,
    });

    const combined = await mergeFeatures(repo, project.id, ["auth", "cart"], {
      slug: "foundation",
      title: "Foundation",
    });
    expect(combined.slug).toBe("foundation");

    const view = await loadGraph(repo, project.id);
    expect(view.features.find((f) => f.slug === "checkout")!.dependsOn).toEqual(["foundation"]);
    const manifest = JSON.parse(combined.manifest) as { routes: unknown[]; exports: unknown[] };
    expect(manifest.routes).toHaveLength(1);
    expect(manifest.exports).toHaveLength(1);
  });
});

describe("agent-facing context", () => {
  it("tells an assignee what to build, what blocks it, and what its deps expose", async () => {
    const { repo, project, userId } = await setup();
    const checkout = await repo.findFeature(project.id, "checkout");
    await repo.updateFeature(checkout!.id, { assigned_to: userId, status: "in_progress" });

    const task = await getMyTask(repo, project.id, userId);
    expect(task.based_on_version).toBe(0);
    expect(task.assigned_features).toHaveLength(1);

    const assigned = task.assigned_features[0]!;
    expect(assigned.id).toBe("checkout");
    expect(assigned.scope_notes).toBe("src/features/checkout/**");
    expect(assigned.status).toBe("working");
    expect(assigned.blocked_by).toEqual(["auth", "cart"]);
    expect(assigned.test_spec).toBe("Checkout submits an order.");
    expect(assigned.dependency_context.map((dep) => dep.id)).toEqual(["auth", "cart"]);
    expect(assigned.dependency_context[0]!.manifest!.exports).toEqual([
      { name: "useSession", module: "src/features/auth/index" },
    ]);
    expect(task.unclaimed_available.map((f) => f.id)).toEqual(["auth", "cart"]);
    expect(task.available_to_you.some((f) => f.id === "checkout")).toBe(true);
  });

  it("reports the generated shared wiring built from merged manifests only", async () => {
    const { repo, project } = await setup();
    const cart = await repo.findFeature(project.id, "cart");

    let context = await getProjectContext(env as AppEnv, repo, project.id);
    expect(context.shared_wiring.routes).toEqual([]);

    await repo.updateFeature(cart!.id, { status: "merged" });
    context = await getProjectContext(env as AppEnv, repo, project.id);
    expect(context.shared_wiring.routes).toEqual([
      { path: "/cart", module: "src/features/cart/routes", featureSlug: "cart" },
    ]);
  });
});
