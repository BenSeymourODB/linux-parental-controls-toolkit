import { defineConfig } from "vitest/config";

// Unit-test configuration. Integration tests (*.int.test.ts) need live
// services and run via vitest.integration.config.ts instead — see
// docs/testing.md.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.int.test.ts", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
