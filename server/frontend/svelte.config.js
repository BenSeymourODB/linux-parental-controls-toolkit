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
  },
};

export default config;
