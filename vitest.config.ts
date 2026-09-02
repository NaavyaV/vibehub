import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        kvNamespaces: ["PUSH_PAYLOADS", "OAUTH_KV"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          SESSION_SECRET: "test-session-secret",
          PUBLIC_URL: "http://localhost:8787",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
