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
    paths: {
      // Root-absolute asset references (`/_app/…`) rather than the default
      // page-relative ones (`./_app/…`). The Fastify mount serves each surface
      // entry page as an SPA fallback for *deep* client-side routes too (e.g. a
      // hard refresh of `/admin/settings`; #59) — a relative `./_app/…` URL
      // would resolve against that deep document base and 404, so assets must be
      // addressed from the root. This also removes the need for the old
      // trailing-slash → canonical redirect (see `server/src/web/frontend.ts`).
      relative: false,
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
