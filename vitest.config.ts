import { defineConfig } from "vitest/config";

// This repo had no vitest config — `npm test` invoked vitest with its defaults. The only reason
// this file exists is to carry the coverage block; test discovery and behavior are unchanged
// (`npm test` still passes the __tests__/ path explicitly).
export default defineConfig({
  test: {
    coverage: {
      // v8, not istanbul. These tests are hermetic — pure wire-codec and relay state-machine
      // checks that run in plain Node, not under @cloudflare/vitest-pool-workers. The istanbul
      // provider is only required where tests execute inside workerd, which does not expose V8's
      // profiler (cloudflare/workers-sdk#14463).
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      // `tools/moq-client/src/**` still surfaced under the include above (the v8 provider reports
      // files loaded during the run), so it is excluded explicitly. It is a standalone CLI with its
      // own tsconfig and its own `test:client` script — not part of the Worker bundle. Kept in sync
      // with the `tools/**` entry in codecov.yml.
      exclude: ["src/**/*.d.ts", "worker-configuration.d.ts", "tools/**"],
    },
  },
});
