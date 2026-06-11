import { defineConfig } from "vitest/config";

// Integration tests exercise real upstream services (ActivityWatch,
// AdGuard Home, OpenSSH). Bring them up with the Docker Compose recipe in
// docs/testing.md before running `npm run test:integration`.
export default defineConfig({
  test: {
    include: ["tests/**/*.int.test.ts"],
    // Live services can be slow to respond on first hit.
    testTimeout: 30_000,
  },
});
