import { describe, expect, it } from "vitest";
import {
  changedPathsSince,
  detectPathConflicts,
  validateChangedFiles,
} from "../src/domain/conflicts.js";

const history = [
  { version_number: 1, changed_paths: ["src/features/auth/index.ts"] },
  { version_number: 2, changed_paths: ["src/features/cart/index.ts", "src/lib/money.ts"] },
  { version_number: 3, changed_paths: ["src/features/search/index.ts"] },
];

describe("path-based conflict detection", () => {
  it("unions only the versions newer than based_on_version", () => {
    expect(changedPathsSince(history, 1)).toEqual([
      "src/features/cart/index.ts",
      "src/features/search/index.ts",
      "src/lib/money.ts",
    ]);
    expect(changedPathsSince(history, 3)).toEqual([]);
  });

  it("auto-applies a push that is far behind but touches nothing in common", () => {
    const since = changedPathsSince(history, 0);
    const incoming = ["src/features/profile/index.ts", "src/features/profile/api.ts"];
    expect(detectPathConflicts(since, incoming)).toEqual([]);
  });

  it("reports only the overlapping files, not the whole push", () => {
    const since = changedPathsSince(history, 1);
    const incoming = ["src/lib/money.ts", "src/features/profile/index.ts"];
    expect(detectPathConflicts(since, incoming)).toEqual(["src/lib/money.ts"]);
  });

  it("is unaffected by how many versions behind the pusher is", () => {
    const long = Array.from({ length: 40 }, (_, index) => ({
      version_number: index + 1,
      changed_paths: [`src/features/f${index}/index.ts`],
    }));
    expect(detectPathConflicts(changedPathsSince(long, 0), ["src/features/new/index.ts"])).toEqual([]);
  });
});

describe("changed file validation", () => {
  it("normalizes paths and keeps a sorted unique path list", async () => {
    const result = await validateChangedFiles([
      { path: "./src/b.ts", action: "modify", content: "b" },
      { path: "src/a.ts", action: "add", content: "a" },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.digests).toHaveLength(2);
  });

  it("refuses writes to generated files and explains the alternative", async () => {
    const result = await validateChangedFiles([
      { path: "src/generated/routes.ts", action: "modify", content: "x" },
      { path: "package.json", action: "modify", content: "{}" },
    ]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join("\n")).toMatch(/feature manifest instead/);
  });

  it("rejects path traversal, absolute paths, and duplicates", async () => {
    expect(
      (await validateChangedFiles([{ path: "../etc/passwd", action: "add", content: "" }])).errors,
    ).toHaveLength(1);
    expect(
      (await validateChangedFiles([{ path: "/etc/passwd", action: "add", content: "" }])).errors,
    ).toHaveLength(1);
    expect(
      (
        await validateChangedFiles([
          { path: "src/a.ts", action: "add", content: "1" },
          { path: "src/a.ts", action: "modify", content: "2" },
        ])
      ).errors,
    ).toContain('Duplicate path in changed_files: "src/a.ts"');
  });

  it("requires content for add and modify but not for delete", async () => {
    expect((await validateChangedFiles([{ path: "src/a.ts", action: "modify" }])).errors[0]).toMatch(
      /content is required/,
    );
    expect((await validateChangedFiles([{ path: "src/a.ts", action: "delete" }])).errors).toEqual([]);
  });

  it("treats an empty push as an error", async () => {
    expect((await validateChangedFiles([])).errors).toContain("changed_files is empty; nothing to push");
  });

  it("decodes mistaken base64 on text files into utf-8", async () => {
    const css = ".hero { color: red; }\n";
    const b64 = btoa(css);
    const result = await validateChangedFiles([
      { path: "src/App.css", action: "modify", content: b64, encoding: "base64" },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.files[0]!.encoding).toBe("utf-8");
    expect(result.files[0]!.content).toBe(css);
  });

  it("rejects utf-8 payloads that look like raw base64 for text paths", async () => {
    const fake = btoa(".hero { color: red; }\n".repeat(4));
    const result = await validateChangedFiles([
      { path: "src/App.css", action: "modify", content: fake, encoding: "utf-8" },
    ]);
    expect(result.errors[0]).toMatch(/looks like base64/);
  });
});
