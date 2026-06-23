import { sveltekit } from "@sveltejs/kit/vite";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vitest/config";

/**
 * Two test projects, one runner:
 *
 * - **api** — the pure `/api` layer (the typed fetch client and the
 *   auth/users/… wrappers). These touch no DOM, so the `node` environment
 *   keeps them light and fast.
 * - **components** — Svelte component / flow smoke tests (#53's last
 *   acceptance box). These render real `.svelte` components against a mocked
 *   `/api` (no live backend) using `@testing-library/svelte` in a `jsdom`
 *   environment. The SvelteKit plugin compiles the components and resolves the
 *   `$lib` / `$app` aliases the views import; `svelteTesting()` wires
 *   Testing-Library's auto-cleanup between tests.
 *
 * Heavier in-browser E2E (Playwright) is deliberately out of scope — the
 * `implement-issue` guide warns against standing one up as a side effect, and
 * these headless component tests cover the highest-value flows end-to-end.
 */
export default defineConfig({
  plugins: [sveltekit()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "api",
          environment: "node",
          include: ["tests/api/**/*.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [svelteTesting()],
        test: {
          name: "components",
          environment: "jsdom",
          include: ["tests/components/**/*.test.ts"],
          setupFiles: ["./tests/components/setup.ts"],
        },
      },
    ],
  },
});
