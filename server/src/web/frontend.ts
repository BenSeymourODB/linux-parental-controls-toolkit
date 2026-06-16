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
 * The two extensionless surface URLs do not, so they get explicit routes that
 * send the matching `*.html`. `/` and `/healthz` (and, in a later phase,
 * `/api/*`) stay owned by the backend: the exact and more-specific routes win
 * over the static plugin's `GET /*` wildcard, and `index: false` stops the
 * plugin from registering its own `GET /` (which would collide with the
 * landing route).
 *
 * The prerendered pages reference their assets with **relative** URLs
 * (`./_app/…`), which only resolve to `/_app/…` when the document is served at
 * the canonical, slash-free surface URL. So the trailing-slash form redirects
 * to the canonical one (a permanent 308) rather than serving the same HTML
 * under a base path that would make every asset 404 in the browser. This also
 * matches the frontend's `trailingSlash: 'never'` default.
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
      // Canonical URL: serve the prerendered entry page.
      scope.get(
        url,
        (_request: FastifyRequest, reply: FastifyReply): FastifyReply => reply.sendFile(page),
      );
      // Trailing-slash form: redirect to the canonical URL so the page's
      // relative asset paths resolve against `/` rather than `/<surface>/`.
      // Preserve any query string so client-side state survives the redirect.
      scope.get(`${url}/`, (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
        const queryStart = request.url.indexOf("?");
        const target = queryStart === -1 ? url : url + request.url.slice(queryStart);
        return reply.redirect(target, 308);
      });
    }
  });
}
