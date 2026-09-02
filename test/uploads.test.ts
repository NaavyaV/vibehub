import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { findMissingImports } from "../src/domain/imports.js";
import {
  beginUpload,
  collectUpload,
  getUploadStatus,
  uploadChunk,
} from "../src/services/uploads.js";
import type { HttpError } from "../src/lib/errors.js";
import type { AppEnv } from "../src/types.js";

const appEnv = env as unknown as AppEnv;

async function expectRejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as HttpError).message;
  }
  throw new Error("Expected the operation to be rejected");
}

describe("staged uploads", () => {
  it("accepts inline content and reports the upload complete", async () => {
    const progress = await beginUpload(appEnv, {
      projectId: "prj_1",
      featureIdOrSlug: "add-calendar",
      userId: "usr_1",
      files: [{ path: "src/App.jsx", action: "modify", content: "export default null;\n" }],
    });

    expect(progress.complete).toBe(true);
    expect(progress.missing_paths).toEqual([]);

    const collected = await collectUpload(appEnv, progress.upload_id, "usr_1");
    expect(collected.files).toEqual([
      {
        path: "src/App.jsx",
        action: "modify",
        content: "export default null;\n",
        encoding: "utf-8",
      },
    ]);
  });

  it("refuses to collect while a declared file is still missing", async () => {
    const progress = await beginUpload(appEnv, {
      projectId: "prj_1",
      featureIdOrSlug: "add-background",
      userId: "usr_1",
      files: [
        { path: "src/App.jsx", action: "modify", content: "import './App.css';\n" },
        { path: "src/App.css", action: "modify", bytes: 16_384 },
      ],
    });

    expect(progress.complete).toBe(false);
    expect(progress.missing_paths).toEqual(["src/App.css"]);

    const message = await expectRejection(collectUpload(appEnv, progress.upload_id, "usr_1"));
    expect(message).toMatch(/incomplete/);
    expect(message).toMatch(/src\/App\.css/);
  });

  it("reassembles a chunked file in part order, whatever order it arrives in", async () => {
    const started = await beginUpload(appEnv, {
      projectId: "prj_1",
      featureIdOrSlug: "big-stylesheet",
      userId: "usr_1",
      files: [{ path: "src/App.css", action: "modify", bytes: 20 }],
    });

    await uploadChunk(appEnv, {
      uploadId: started.upload_id,
      userId: "usr_1",
      path: "src/App.css",
      content: "second}\n",
      partIndex: 1,
      partCount: 2,
    });
    const midway = await getUploadStatus(appEnv, started.upload_id);
    expect(midway.complete).toBe(false);

    await uploadChunk(appEnv, {
      uploadId: started.upload_id,
      userId: "usr_1",
      path: "src/App.css",
      content: ".hero{first:",
      partIndex: 0,
      partCount: 2,
    });

    const collected = await collectUpload(appEnv, started.upload_id, "usr_1");
    expect(collected.files[0]!.content).toBe(".hero{first:second}\n");
  });

  it("rejects a stand-in body instead of the real file", async () => {
    const started = await beginUpload(appEnv, {
      projectId: "prj_1",
      featureIdOrSlug: "styles",
      userId: "usr_1",
      files: [{ path: "src/App.css", action: "modify", content: "PLACEHOLDER" }],
    });

    const message = await expectRejection(collectUpload(appEnv, started.upload_id, "usr_1"));
    expect(message).toMatch(/not the file's real content/);
  });

  it("rejects an upload that does not match the declared size", async () => {
    const started = await beginUpload(appEnv, {
      projectId: "prj_1",
      featureIdOrSlug: "styles",
      userId: "usr_1",
      files: [{ path: "src/App.css", action: "modify", bytes: 16_384 }],
    });

    await uploadChunk(appEnv, {
      uploadId: started.upload_id,
      userId: "usr_1",
      path: "src/App.css",
      content: ".hero { color: red; }\n",
    });

    const message = await expectRejection(collectUpload(appEnv, started.upload_id, "usr_1"));
    expect(message).toMatch(/arrived as 22 bytes but you declared 16384/);
  });

  it("requires a declared size for files that are not inlined", async () => {
    const message = await expectRejection(
      beginUpload(appEnv, {
        projectId: "prj_1",
        featureIdOrSlug: "styles",
        userId: "usr_1",
        files: [{ path: "src/App.css", action: "modify" }],
      }),
    );
    expect(message).toMatch(/declare bytes/);
  });

  it("rejects a path that was never declared", async () => {
    const started = await beginUpload(appEnv, {
      projectId: "prj_1",
      featureIdOrSlug: "scoped",
      userId: "usr_1",
      files: [{ path: "src/App.jsx", action: "modify", content: "x" }],
    });

    const message = await expectRejection(
      uploadChunk(appEnv, {
        uploadId: started.upload_id,
        userId: "usr_1",
        path: "src/Sneaky.css",
        content: "x",
      }),
    );
    expect(message).toMatch(/was not declared in begin_upload/);
  });
});

describe("push completeness", () => {
  it("flags markup that imports a stylesheet the push never sent", () => {
    const missing = findMissingImports(
      [{ path: "src/App.jsx", action: "modify", content: "import './shapes.css';\n" }],
      ["src/App.jsx", "src/main.jsx"],
    );
    expect(missing).toEqual([{ from: "src/App.jsx", specifier: "./shapes.css" }]);
  });

  it("passes when the stylesheet ships in the same push", () => {
    const missing = findMissingImports(
      [
        { path: "src/App.jsx", action: "modify", content: "import './shapes.css';\n" },
        { path: "src/shapes.css", action: "add", content: ".neon{}" },
      ],
      ["src/App.jsx"],
    );
    expect(missing).toEqual([]);
  });

  it("resolves extensionless and index imports already on main", () => {
    const missing = findMissingImports(
      [
        {
          path: "src/App.tsx",
          action: "modify",
          content: "import { a } from './lib/util';\nimport Panel from './panel';\n",
        },
      ],
      ["src/lib/util.ts", "src/panel/index.tsx"],
    );
    expect(missing).toEqual([]);
  });

  it("ignores package imports and only checks relative ones", () => {
    const missing = findMissingImports(
      [{ path: "src/App.tsx", action: "modify", content: "import React from 'react';\n" }],
      [],
    );
    expect(missing).toEqual([]);
  });

  it("flags a CSS @import with no matching file", () => {
    const missing = findMissingImports(
      [{ path: "src/App.css", action: "modify", content: "@import './tokens.css';\n" }],
      ["src/App.css"],
    );
    expect(missing).toEqual([{ from: "src/App.css", specifier: "./tokens.css" }]);
  });
});
