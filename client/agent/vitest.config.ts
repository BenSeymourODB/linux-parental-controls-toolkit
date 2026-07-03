import { defineConfig } from "vitest/config";

// Unit-test configuration for the client agent package. Mirrors
// server/vitest.config.ts (80% coverage gate). The bridge has no live-service
// integration tests yet — the WebSocket and AF_UNIX seams are exercised with a
// fake socket factory and a real in-process Unix socket respectively, both of
// which run under the unit harness.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.int.test.ts", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Thin bootstraps (load config + build + start + wait for a shutdown
      // signal); their process-lifecycle wiring can't run under the unit
      // harness. What they build (Bridge, Agent) is covered via tests.
      exclude: ["src/main.ts", "src/agent/main.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
