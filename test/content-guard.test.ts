import { describe, expect, it } from "vitest";

import { isDestructiveOverwrite, placeholderReason } from "../src/domain/content-guard.js";
import { validateChangedFiles } from "../src/domain/conflicts.js";

describe("placeholder detection", () => {
  it("catches the exact body that overwrote a stylesheet", () => {
    expect(placeholderReason("PLACEHOLDER")).toBe("PLACEHOLDER");
  });

  it("catches other stand-ins agents reach for", () => {
    expect(placeholderReason("<paste full file content here>")).not.toBeNull();
    expect(placeholderReason("[file contents]")).not.toBeNull();
    expect(placeholderReason("...")).not.toBeNull();
    expect(placeholderReason("TODO: paste the real contents")).not.toBeNull();
    expect(placeholderReason("see /tmp/app-css-payload.txt")).not.toBeNull();
  });

  it("leaves genuine small files alone", () => {
    expect(placeholderReason(".hero { color: red; }\n")).toBeNull();
    expect(placeholderReason("export const ready = true;\n")).toBeNull();
    // An intentionally emptied file is a real edit, not a stand-in.
    expect(placeholderReason("")).toBeNull();
  });

  it("does not flag a long file that merely mentions TODO", () => {
    const real = `${"/* styles */\n".repeat(60)}\n/* TODO: tidy this up */\n`;
    expect(placeholderReason(real)).toBeNull();
  });

  it("rejects the placeholder before it can be recorded as a push", async () => {
    const result = await validateChangedFiles([
      { path: "src/App.css", action: "modify", content: "PLACEHOLDER" },
    ]);
    expect(result.errors[0]).toMatch(/not the file/);
  });
});

describe("destructive overwrite detection", () => {
  it("flags 16KB replaced by an 11-byte body", () => {
    expect(isDestructiveOverwrite(16_384, 11)).toBe(true);
  });

  it("allows an ordinary edit that shrinks a file a little", () => {
    expect(isDestructiveOverwrite(16_384, 15_000)).toBe(false);
  });

  it("allows a real rewrite that keeps most of the file", () => {
    expect(isDestructiveOverwrite(4_000, 3_000)).toBe(false);
  });

  it("ignores small files, where a big ratio change means nothing", () => {
    expect(isDestructiveOverwrite(120, 8)).toBe(false);
  });
});
