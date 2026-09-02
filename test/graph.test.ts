import { describe, expect, it } from "vitest";
import {
  buildGraph,
  directDependents,
  findCycle,
  isUnlocked,
  topoOrder,
  unmetDependencies,
} from "../src/domain/graph.js";

const graph = buildGraph([
  { node: "auth", dependsOn: [] },
  { node: "profile", dependsOn: ["auth"] },
  { node: "cart", dependsOn: [] },
  { node: "checkout", dependsOn: ["cart", "auth"] },
]);

describe("dependency graph", () => {
  it("finds no cycle in a valid graph", () => {
    expect(findCycle(graph)).toBeNull();
  });

  it("reports a cycle as an ordered path", () => {
    const cyclic = buildGraph([
      { node: "a", dependsOn: ["b"] },
      { node: "b", dependsOn: ["a"] },
    ]);
    expect(findCycle(cyclic)).toEqual(["a", "b", "a"]);
  });

  it("orders dependencies before their dependents", () => {
    const order = topoOrder(graph);
    expect(order.indexOf("auth")).toBeLessThan(order.indexOf("profile"));
    expect(order.indexOf("cart")).toBeLessThan(order.indexOf("checkout"));
  });

  it("computes what still blocks a feature", () => {
    expect(unmetDependencies("checkout", graph, new Set())).toEqual(["auth", "cart"]);
    expect(unmetDependencies("checkout", graph, new Set(["auth"]))).toEqual(["cart"]);
    expect(isUnlocked("checkout", graph, new Set(["auth", "cart"]))).toBe(true);
    expect(isUnlocked("auth", graph, new Set())).toBe(true);
  });

  it("finds the features a merge unlocks", () => {
    expect(directDependents("auth", graph)).toEqual(["checkout", "profile"]);
    expect(directDependents("profile", graph)).toEqual([]);
  });

  it("ignores dependencies on nodes outside the graph when detecting cycles", () => {
    const dangling = buildGraph([{ node: "a", dependsOn: ["ghost"] }]);
    expect(findCycle(dangling)).toBeNull();
  });
});
