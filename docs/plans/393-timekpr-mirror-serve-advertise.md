# Plan — #393: serve `/apt/timekpr/*` and advertise the mirror at enrol

Part of the server-hosted `timekpr-next` mirror epic (**#389**), the third
implementation slice. The config seam
([#391](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/391),
merged) built the `PCT_TIMEKPR_MIRROR` mode + `/data/apt/timekpr` layout; the
background fetch/refresh job
([#392](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/392),
merged) keeps that directory current with the upstream `.deb`. This slice
**exposes** what #392 caches and **tells clients about it**.

ADR: [`0011-server-hosted-upstream-package-mirror.md`](../adr/0011-server-hosted-upstream-package-mirror.md).
Roadmap: `docs/roadmap.md` → Phase 3.

Dependency order in the epic is **#392 → #393 → #394; #395 last**. #392 (fetch)
is merged, so this is unblocked; the client baseline repo path that consumes the
advertisement is #394.

## Scope — the ADR MVP (mode B), not the signed index

ADR 0011 is explicit: **ship the MVP first** (serve the cached `.deb` over the
LAN, advertised at enrol), **then graduate to the signed apt repo** under the
Phase-14 fleet-lifecycle umbrella (epic #163). #393's own body says the same:
"MVP shortcut (per the ADR): skip signing and serve the `.deb` as a plain file
first, add signing later."

So this PR delivers the MVP:

1. **Serve** the runtime-cached `.deb` from the managed mirror's `dataDir` at a
   stable LAN URL, plus a small JSON manifest describing what is currently
   cached.
2. **Advertise** the mirror (mode + coordinates + current version/filename) in
   the enrol response, so #394's installer can fetch the package from the
   dashboard instead of round-tripping to `launchpad.net`.

**Deferred to a Phase-14 follow-up (new issue, linked from the PR):** GPG-signed
`InRelease`/`Release.gpg` apt-index generation and full `apt update`/pinning/
rollback repo semantics. Until that lands, the MVP contract is a **direct
`.deb` download** (`apt-get install ./file.deb`), which correctly resolves the
package's own `Depends` from the client's existing distro repos — so the MVP is
functionally complete for install without a hand-synthesised, dependency-less
`Packages` index (which would be actively wrong on dependencies).

## Why direct-download, not a synthesised flat index (for the MVP)

A `[trusted=yes]` flat apt repo needs a `Packages` stanza carrying the package's
real `Depends`/`Pre-Depends`. Reproducing those faithfully means extracting the
Debian control member from the `.deb` (`ar` → `control.tar.{gz,xz,zst}` →
`control`), i.e. an `xz`/`zstd` decompressor the Node stdlib doesn't fully
provide, or shelling out to packaging tools we deliberately keep out of the
image. A hand-written stanza that omits `Depends` would install `timekpr-next`
**without its dependencies** — a real breakage. `apt-get install ./local.deb`
reads the `.deb`'s own embedded control and pulls deps from the distro, so the
direct-download MVP is both simpler and correct. Faithful index generation is
exactly the signed-index slice's job and lands with it.

## License boundary (non-negotiable, ADR 0011)

Pure TypeScript + Fastify + Node.js `fs` streaming. The `.deb` served is the one
#392 fetched at runtime into `/data`; it is **never** baked into the image
(`license-guard.yml` scans the image and stays green). Nothing here links,
imports, or vendors GPL code, and nothing shells out to GPL packaging tooling —
serving a file is not a code-level integration. `CLAUDE.md` → "License
boundaries" rules 1 & 5; `docs/licensing-analysis.md`.

## Contract

### Serving (root app, alongside `GET /install-client.sh`)

Registered only in `managed` mode (`external` points clients at a repo the
homelab hosts; `disabled` serves nothing) under a stable path
`TIMEKPR_MIRROR_APT_PATH = "/apt/timekpr"`:

- `GET /apt/timekpr/manifest.json` → `{ package, version, filename }` describing
  the currently-cached `.deb`, or **404** when the refresh job has not yet
  written one (cold start before the first successful fetch).
- `GET /apt/timekpr/:filename` → streams the `.deb` with
  `Content-Type: application/vnd.debian.binary-package`. `:filename` is validated
  against a strict `^[A-Za-z0-9][A-Za-z0-9._+~-]*\.deb$` allow-list (Fastify
  params never span `/`, and the resolved path is asserted to stay within
  `dataDir` as defence-in-depth), so the sentinel dotfile and traversal are
  rejected with 404. The static `manifest.json` route wins over the param route
  by Fastify's segment priority.

### Mirror state read (`transport/timekpr-mirror/state.ts`)

`readMirrorState(config, deps?) → { version, filename, path } | null`: reads the
`.pct-timekpr-mirror-version` sentinel #392 writes and confirms the matching
`.deb` exists on disk. `null` when nothing is cached yet. Every fs boundary is an
injected seam (mirrors `refresh.ts`) so it is unit-testable without disk. Reuses
`VERSION_SENTINEL` and `debFilename` from the existing module — no duplicated
filename logic.

### Enrol advertisement (`api/clients`)

`enrolResponseSchema` gains a `timekprMirror` discriminated union mirroring the
config's own trichotomy:

- `{ mode: "disabled" }`
- `{ mode: "external", url }` — the homelab repo URL the client points apt at.
- `{ mode: "managed", aptPath, package, version, debFilename }` — `aptPath` is
  the relative path root (`/apt/timekpr`) the client joins onto its
  `--server-url`; `version`/`debFilename` are `null` until the first refresh has
  cached a `.deb` (client falls back to distro/PPA in that window, #394).

`buildTimekprMirrorAdvertisement(mirror, state)` is a **pure** mapping (new
`api/clients/mirror-advertisement.ts`), unit-tested in isolation. The enrol
**route** reads `settings.timekprMirror` + `readMirrorState` (disk, managed mode
only — enrol is rare, so the couple of stat/read calls are fine) and passes the
built advertisement into `enrolClient` via `EnrolOptions`; the service echoes it
into the response, staying disk-free and unit-testable.

## Files

New:

- `server/src/transport/timekpr-mirror/state.ts` — `readMirrorState` + seams;
  re-exported from `index.ts`.
- `server/src/web/timekpr-mirror.ts` — `registerTimekprMirror(app, settings)` +
  `TIMEKPR_MIRROR_APT_PATH`.
- `server/src/api/clients/mirror-advertisement.ts` —
  `buildTimekprMirrorAdvertisement` (pure).

Changed:

- `server/src/api/clients/dtos.ts` — `timekprMirrorAdvertisementSchema` +
  `timekprMirror` on `enrolResponseSchema`.
- `server/src/api/clients/service.ts` — `EnrolOptions.timekprMirror`; echo into
  the response; `EnrolServiceResult` gains the field.
- `server/src/api/clients/routes.ts` — read state + build advertisement, thread
  into `enrolClient`.
- `server/src/web/app.ts` — `registerTimekprMirror(app, settings)`.

Tests mirror the layout: `server/tests/transport/timekpr-mirror/state.test.ts`,
`server/tests/web/timekpr-mirror.test.ts`,
`server/tests/api/clients/mirror-advertisement.test.ts`, plus an enrol-route
assertion that the advertisement appears (disabled default + a managed case).

## Phasing (commit + push per phase → draft PR on first push)

1. **`state.ts` + serving module + wiring + tests** — the read + expose half.
2. **Enrol advertisement** — DTO + pure builder + route/service wiring + tests.
3. **Docs + follow-up issue + finalize** — `server-deployment.md` gains the
   serving endpoints + enrol-advertisement shape; file the Phase-14 signed-index
   follow-up and link it; mark ready.

## Test plan

- `state.ts`: sentinel + matching `.deb` present → state; sentinel present but
  `.deb` missing → `null`; no sentinel → `null`; version drift handled by
  reading the sentinel as the source of truth.
- `web/timekpr-mirror.ts`: managed mode serves the cached `.deb` (correct
  content-type + bytes) and `manifest.json`; cold start (no `.deb`) → 404 on both
  the file and the manifest; traversal / non-`.deb` / sentinel filename → 404;
  disabled/external mode registers nothing (routes 404).
- `mirror-advertisement.ts`: each mode maps correctly; managed with `null` state
  → `version`/`debFilename` null; managed with state → populated.
- enrol route/service: response carries `timekprMirror` (disabled by default; a
  managed case surfaces the advertised coordinates).

## Quality gate (each phase, from `server/`)

`npm run format` · `npm run lint:fix` · `npm run typecheck` · `npm test`
(coverage ≥ 80%). No new runtime dependency — Fastify, zod, croner,
better-sqlite3 are already present; serving uses `node:fs` only.

## Deferred (tracked, not this slice)

- **Signed apt index** (`InRelease`/`Release.gpg`, repo signing key in `/data`)
  + faithful `Packages`/`Release` generation + `apt update`/pinning/rollback
  semantics → **new Phase-14 follow-up issue** under epic #163 (linked from the
  PR). This is where cryptographic repo integrity lands.
- Client `install-baseline-tools.sh` mirror repo path + orchestrator/enrol
  plumbing that consumes this advertisement → **#394**.
- Docs (`licensing-analysis.md` runtime-mirror note) + license-guard
  confirmation → **#395** (this PR touches `server-deployment.md` only for the
  new endpoints/advertisement it introduces).
- Optional upstream **source-package** mirroring → epic #389 enhancement.
