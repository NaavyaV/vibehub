/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings the test runner injects on top of the ones wrangler.toml declares.
// Optional so that augmenting the shared `Cloudflare.Env` does not make
// production code look like it must provide them.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS?: import("cloudflare:test").D1Migration[];
  }
}
