import { defineConfig } from "vitest/config";

/**
 * Unit tests for the frontend's pure `/api` layer (the typed fetch client and
 * the auth/users wrappers). These need no DOM, so the `node` environment keeps
 * the harness light — Svelte component behaviour is covered by `svelte-check`
 * and the production `vite build`, not a heavyweight browser/E2E harness.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
