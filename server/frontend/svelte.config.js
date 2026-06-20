import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * Static-only build: the dashboard frontend is compiled to plain HTML/JS
 * assets at image-build time and served by the Fastify backend (no Node
 * frontend toolchain in the runtime image — see CLAUDE.md → frontend
 * split). adapter-static prerenders every route into `build/`.
 *
 * `strict: true` fails the build if any page is not prerenderable, which
 * keeps us honest: the runtime image is a static file server for these
 * assets, so a route that needs SSR would be a silent regression.
 *
 * Only `/admin` and `/app` are owned by this project; `/` and `/api` are
 * served by Fastify directly, so the prerender crawler is pointed at the
 * two surface roots rather than the default `/` entry (which has no page
 * here).
 *
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: "build",
      assets: "build",
      fallback: undefined,
      precompress: false,
      strict: true,
    }),
    prerender: {
      entries: ["/admin", "/app"],
    },
    // The service worker (`src/service-worker.ts`) is still bundled, but we
    // register it manually from the `/app` layout (prod-only) so the `/admin`
    // surface — which is not a PWA — never installs a worker unless the user
    // actually opens `/app`. See `src/routes/app/+layout.svelte`.
    serviceWorker: {
      register: false,
    },
  },
};

export default config;
