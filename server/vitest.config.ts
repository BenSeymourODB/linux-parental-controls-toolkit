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
      // src/main.ts is a thin bootstrap (build app + listen); its socket
      // bind can't run under the unit harness. The app it builds is fully
      // covered via buildApp() in tests/web/app.test.ts.
      exclude: ["src/main.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
