/**
 * Serve the prerendered SvelteKit build at the `/admin` and `/app` surfaces
 * (#40).
 *
 * The frontend is one SvelteKit project built with `adapter-static`
 * (`server/frontend/`, see `CLAUDE.md` → frontend split). Its prerender
 * crawler is pointed at `/admin` and `/app`, so the build emits:
 *
 * - `admin.html` and `app.html` — the two surface entry pages,
 * - `_app/…` — the shared, hashed JS/CSS chunks both pages reference,
 * - any files under `static/` (e.g. `favicon.png`).
 *
 * `@fastify/static` serves files by URL path, so the hashed assets and static
 * files map one-to-one (`GET /_app/immutable/x.js` → `<root>/_app/immutable/x.js`).
 * The extensionless surface URLs do not, so each surface gets explicit routes
 * that send the matching `*.html`. `/` and `/healthz` (and, in a later phase,
 * `/api/*`) stay owned by the backend: the exact and more-specific routes win
 * over the static plugin's `GET /*` wildcard, and `index: false` stops the
 * plugin from registering its own `GET /` (which would collide with the
 * landing route).
 *
 * SPA fallback (#59): a *deep* client-side route on a hard refresh — e.g.
 * `GET /admin/settings`, a path that exists only inside the hydrated SvelteKit
 * app, not as a prerendered file — must serve the surface entry page so the
 * client router can take over, rather than 404. So beyond the exact surface
 * URL, each surface also owns a `…/*` wildcard that sends the same entry page.
 * Per-surface (not a single shared SPA fallback page) because `/admin` and
 * `/app` must fall back to *their own* entry page. The fallback only ever
 * shadows paths under the surface prefix; the shared `/_app/…` assets and the
 * root-level static files (`/service-worker.js`, `/app.webmanifest`,
 * `/app-icons/…`) live at the root, not under `/admin/` or `/app/`, so they are
 * untouched.
 *
 * This works because the prerendered pages reference their assets with
 * **root-absolute** URLs (`/_app/…`, via `kit.paths.relative = false` in
 * `svelte.config.js`), so the entry HTML loads its assets regardless of the
 * document URL's depth. With absolute assets there is no asset-resolution
 * reason to canonicalise the trailing slash, so `/admin/` and `/app/` simply
 * fall through the `…/*` wildcard and serve the entry page like any other deep
 * path (no redirect).
 *
 * Static-asset requests flow through the same pino request logging the app
 * already configures (`./logger.ts`, #11) — there is no frontend-specific
 * logger. The only non-request line here is a startup warning, emitted via the
 * shared component child logger rather than `console.*`.
 *
 * License boundary: none touched — this is plain Fastify static file serving.
 */
import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Settings } from "../config.js";
import { componentLogger } from "./logger.js";

/** Maps each served surface URL to its prerendered entry page. */
const SURFACES: readonly { url: string; page: string }[] = [
  { url: "/admin", page: "admin.html" },
  { url: "/app", page: "app.html" },
];

/**
 * Mount the prerendered frontend build at `/admin` and `/app`.
 *
 * If `settings.frontendRoot` does not exist (dev/CI without a build, or a
 * misconfigured deployment), the mount is skipped with a warning and the
 * surfaces 404 — startup is never blocked on the presence of build output.
 * The runtime image always carries the build, so this is the normal path
 * there; tests point `frontendRoot` at a fixture directory.
 */
export function registerFrontend(app: FastifyInstance, settings: Settings): void {
  const root = settings.frontendRoot;

  if (!existsSync(root)) {
    componentLogger(app, "web/frontend").warn(
      { frontendRoot: root },
      "frontend build not found; /admin and /app will 404 until it is present",
    );
    return;
  }

  // Encapsulate the static plugin and the surface routes in one scope so the
  // `reply.sendFile` decoration the plugin adds is visible to the routes that
  // use it. Route registration itself stays global, so the surfaces remain
  // reachable from the parent app.
  app.register(async (scope) => {
    await scope.register(fastifyStatic, {
      root,
      prefix: "/",
      // The landing route owns `GET /`; let the surface routes below own the
      // two HTML entry points. `index: false` keeps the plugin from claiming
      // either.
      index: false,
    });

    for (const { url, page } of SURFACES) {
      const sendEntryPage = (_request: FastifyRequest, reply: FastifyReply): FastifyReply =>
        reply.sendFile(page);
      // Canonical URL: serve the prerendered entry page.
      scope.get(url, sendEntryPage);
      // SPA fallback (#59): any deeper path under the surface — including the
      // trailing-slash form `/<surface>/` — serves the same entry page so a
      // hard refresh of a client-side route hands off to the router instead of
      // 404ing. The `…/*` wildcard is more specific than the static plugin's
      // root `GET /*`, so it wins; the root-absolute asset URLs (#59) keep the
      // page's `/_app/…` references working at any document depth.
      scope.get(`${url}/*`, sendEntryPage);
    }
  });
}
