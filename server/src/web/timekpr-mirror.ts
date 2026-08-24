/**
 * Serve the managed `timekpr-next` package mirror over the LAN (#393, epic #389).
 *
 * The ADR 0011 MVP (mode B): expose the `.deb` the background refresh job (#392)
 * caches under the mirror's data volume, plus a small JSON manifest describing
 * what is currently cached, so a client can install `timekpr-next` from the
 * dashboard instead of round-tripping to `launchpad.net` at enrol time. The
 * enrol response advertises the coordinates (`api/clients`); the client baseline
 * installer consumes them (#394).
 *
 * Registered only in `managed` mode: `external` points clients at a repo the
 * homelab already hosts (nothing for us to serve) and `disabled` serves nothing.
 * Two routes on the root app, alongside `GET /install-client.sh`:
 *
 *   GET /apt/timekpr/manifest.json  -> { package, version, filename } | 404
 *   GET /apt/timekpr/<file>.deb     -> the cached package bytes        | 404
 *
 * The signed apt index (`InRelease`/`Release.gpg`) + full `apt update`/pinning
 * repo semantics are the Phase-14 end-state (epic #163), tracked as a follow-up;
 * the MVP contract is a direct `.deb` download (`apt-get install ./file.deb`),
 * which resolves the package's own `Depends` from the client's distro repos.
 *
 * License boundary: none touched — plain Fastify + Node.js `fs` streaming of a
 * file #392 fetched at runtime into `/data`; nothing links, imports, or vendors
 * GPL code, and no GPL binary enters the image (`CLAUDE.md` → "License
 * boundaries" rules 1 & 5; ADR 0011; `license-guard.yml` stays green).
 */
import { createReadStream, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { FastifyInstance } from "fastify";

import { TIMEKPR_MIRROR_APT_PATH } from "../api/clients/mirror-advertisement.js";
import type { Settings } from "../config.js";
import { readMirrorState } from "../transport/timekpr-mirror/index.js";

/** Debian package media type (`apt`/`dpkg` convention). */
const DEB_CONTENT_TYPE = "application/vnd.debian.binary-package";

/**
 * Allow-list for the `:filename` route param. A `.deb` basename only: it must
 * start with an alphanumeric and carry no path separator, so the version
 * sentinel dotfile (leading `.`) and any traversal attempt (`..`, absent a
 * `.deb` suffix and a leading alphanumeric) are rejected. Fastify route params
 * never span `/`, so this is belt-and-braces over that guarantee.
 */
const DEB_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+~-]*\.deb$/;

/**
 * Register the mirror-serving routes on the root app.
 *
 * A no-op outside `managed` mode, so `disabled`/`external` deployments expose no
 * `/apt/timekpr/*` surface at all. In `managed` mode the current cached `.deb`
 * is discovered per request via {@link readMirrorState} (the refresh job can
 * replace it at any time), degrading to 404 before the first successful fetch.
 */
export function registerTimekprMirror(app: FastifyInstance, settings: Settings): void {
  const mirror = settings.timekprMirror;
  if (mirror.mode !== "managed") {
    return;
  }

  const { dataDir } = mirror;
  const stateConfig = { dataDir, package: mirror.package };
  // Precompute the resolved data dir + trailing separator once for the
  // defence-in-depth containment check below.
  const dataDirPrefix = resolve(dataDir) + sep;

  app.get(`${TIMEKPR_MIRROR_APT_PATH}/manifest.json`, async (_request, reply) => {
    const state = readMirrorState(stateConfig);
    if (state === null) {
      return reply
        .code(404)
        .type("application/json")
        .send({ error: "no timekpr package is cached yet" });
    }
    return reply.type("application/json").send({
      package: mirror.package,
      version: state.version,
      filename: state.filename,
    });
  });

  app.get<{ Params: { filename: string } }>(
    `${TIMEKPR_MIRROR_APT_PATH}/:filename`,
    async (request, reply) => {
      const { filename } = request.params;
      if (!DEB_FILENAME_PATTERN.test(filename)) {
        return reply.code(404).type("text/plain").send("not found");
      }

      const filePath = join(dataDir, filename);
      // The pattern already forbids separators and a leading dot, so the join
      // cannot escape dataDir; assert containment anyway (defence in depth).
      if (!resolve(filePath).startsWith(dataDirPrefix)) {
        return reply.code(404).type("text/plain").send("not found");
      }
      if (!existsSync(filePath)) {
        return reply.code(404).type("text/plain").send("not found");
      }

      const stream = createReadStream(filePath);
      stream.on("error", (err) => {
        if (!reply.sent) {
          void reply.code(500).type("text/plain").send("failed to read package");
        } else {
          app.log.error({ err, filename }, "timekpr mirror .deb stream error after headers sent");
        }
      });
      return reply.type(DEB_CONTENT_TYPE).send(stream);
    },
  );
}
