# Plan — #392: scheduled upstream fetch/refresh job for the timekpr mirror

Part of the server-hosted `timekpr-next` mirror epic (**#389**), the second
implementation slice after the config seam
([#391](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/391),
merged) built the `PCT_TIMEKPR_MIRROR` mode + `/data/apt/timekpr` layout.
ADR: [`0011-server-hosted-upstream-package-mirror.md`](../adr/0011-server-hosted-upstream-package-mirror.md).
Roadmap: `docs/roadmap.md` → Phase 3.

Dependency order in the epic is **#392 → #393 → #394; #395 last**. This slice is
the **fetch** half; the signed apt index + serving `/apt/timekpr/*` + enrol
advertisement is #393, and the client baseline repo path is #394.

## Goal

A **croner-scheduled background job** (same in-process pattern as the telemetry
pull and the periodic re-apply) that keeps `managed`-mode's
`/data/apt/timekpr/` current with the upstream `timekpr-next` `.deb`:

- Resolve the newest published `timekpr-next` (or `timekpr-next-beta`) version
  from the PPA's Launchpad API — or honour the pinned
  `PCT_TIMEKPR_MIRROR_VERSION`.
- Download the binary `.deb` into the mirror `dataDir`, with retries/backoff.
- Skip when already current; log what was fetched.

**This is where the Launchpad latency goes to die:** the fetch runs in the
background on the server, off every client's install/enrol critical path, and
is retryable — so a slow Launchpad never blocks an enrolment again (issue #392,
epic #389 "Problem").

## Why this shape / precedent

This is the direct analogue of **managed-mode AdGuard Home acquisition**
(`server/src/transport/adguard/{release,acquire}.ts`, #96): fetch a GPL artefact
from upstream **at runtime into `/data`**, never into the image. So the module
follows that precedent exactly:

- **Pure coordinate/parse helpers** with no I/O (`release.ts`, mirrors
  `adguard/release.ts`).
- **A fetch/refresh function whose every side-effecting boundary (network,
  filesystem, clock/sleep) is an injected seam** (`refresh.ts`, mirrors
  `adguard/acquire.ts`), so the whole thing is unit-testable without touching
  the real network or disk.
- **A croner scheduler with overlap protection + per-failure backoff +
  structured logging** (`scheduler.ts`, mirrors
  `transport/reapply/scheduler.ts` and `adguard/health-poller.ts`), wired by
  the caller (`main.ts`) after `listen` — not inside `buildApp`, so building the
  app starts no timer.

## License boundary (non-negotiable, ADR 0011)

Pure TypeScript that **fetches** a GPL `.deb` at runtime and **writes it to the
`/data` volume** — the exact managed-mode AdGuard precedent (ADR 0009). No GPL
code is linked, imported, or vendored; no GPL binary is baked into the image
(`license-guard.yml` scans the image and stays green); index generation and
serving are out of this slice (#393). Nothing here shells out to GPL packaging
tools. `CLAUDE.md` → "License boundaries" rules 1 & 5; `docs/licensing-analysis.md`.

## Launchpad resolution contract

The PPA is `~mjasnik/+archive/ubuntu/ppa` (matching
`client/install-baseline-tools.sh`). Two Launchpad `devel` API round-trips plus
the download, all off the client path:

1. `GET …/~mjasnik/+archive/ubuntu/ppa?ws.op=getPublishedBinaries&binary_name=<pkg>&status=Published&exact_match=true&order_by_date=true&ws.size=<n>`
   → a Lazr collection `{ entries: [ { binary_package_version, self_link, … } ] }`.
   `order_by_date=true` ⇒ `entries[0]` is the most recently published (i.e. the
   "latest" the ADR tracks). A pinned version selects the first entry whose
   `binary_package_version` equals the pin.
2. `GET <self_link>?ws.op=binaryFileUrls` → a JSON array of librarian file URLs;
   select the one whose basename is `<pkg>_<version>_all.deb` (timekpr-next is
   `Architecture: all` — one arch-independent `.deb`).
3. `GET <debUrl>` → the `.deb` bytes.

All three responses are validated with **zod** before use (`CLAUDE.md` → validate
all external input, including REST responses). Each GET is wrapped in a small
exponential-backoff retry (injected `sleep` seam).

**Integrity.** The MVP trusts HTTPS to Launchpad and performs a cheap structural
check — the downloaded bytes must begin with the Debian `ar` global header magic
(`!<arch>\n`) — rejecting a truncated/HTML error body. Cryptographic integrity
(apt `Release`/`Packages` SHAs, repo signing key) is the job of the **signed apt
index slice (#393)**, which is the natural place for it; this is called out in
the PR and the module docstring, not silently dropped.

## Files

New `server/src/transport/timekpr-mirror/`:

- `release.ts` — PPA/Launchpad URL builders; zod schemas
  (`publishedBinariesSchema`, `binaryFileUrlsSchema`); `parseLatestPublication`
  / `selectPinnedPublication`; `selectDebUrl`; `debFilename`; the `.deb` ar
  magic constant; `TimekprMirrorResolveError`. No I/O.
- `refresh.ts` — `refreshTimekprMirror(config, deps)` → `{ version, filename,
  path, fetched }`; skip-when-current via a version sentinel; download + ar-magic
  validation; `withRetry` (injected `sleep`); `TimekprMirrorDownloadError`,
  `TimekprMirrorInvalidPackageError`, `DownloadFetch`/`RefreshDeps` seams.
- `scheduler.ts` — `startTimekprMirrorRefresh(options)` → `{ tick, stop }`;
  croner `protect: true`; per-failure exponential backoff (reuse the reapply
  bounds shape); `transport/timekpr-mirror` child logger; a tick never throws.
- `index.ts` — barrel + `moduleName`.

Tests mirror the layout under `server/tests/transport/timekpr-mirror/`:
`release.test.ts`, `refresh.test.ts`, `scheduler.test.ts`.

## Config

Add to the `managed` branch of `timekprMirrorSchema` (`server/src/config.ts`):

- `refreshCron` — croner pattern (`PCT_TIMEKPR_MIRROR_REFRESH_CRON`), validated
  with the shared `isValidCronPattern` refine, default `"0 3 * * *"` (daily at
  03:00 — package updates are infrequent; a slow Launchpad off the client path
  makes cadence non-critical).

Env mapping gets `refreshCron: env.PCT_TIMEKPR_MIRROR_REFRESH_CRON`. Docstring
documents the var (config.ts is the env-var source of truth); the prose docs in
`server-deployment.md` are #395's slice.

## Wiring

- `buildApp` (`server/src/web/app.ts`): decorate
  `timekprMirrorRefresh: TimekprMirrorRefreshHandle | null = null` and an
  `onClose` hook that `?.stop()`s it — the exact `adguardHealthPoll` shape.
- `main.ts`: after `listen`, when `settings.timekprMirror.mode === "managed"`,
  start the scheduler, assign it to `app.timekprMirrorRefresh`, and kick one
  `void app.timekprMirrorRefresh.tick()` to warm the cache immediately (off the
  critical path). `main.ts` is coverage-excluded, matching the AdGuard wiring.

`disabled` (default) and `external` modes never fetch — external points clients
at a repo the homelab already hosts, disabled does nothing — so the scheduler
only exists in `managed` mode.

## Phasing (commit + push per phase → draft PR on first push)

1. **`release.ts` + tests** — pure resolution/parse layer.
2. **`refresh.ts` + tests** — the download/skip/validate seam.
3. **`scheduler.ts` + config + wiring + tests** — the croner job made live in
   managed mode.

## Test plan

- `release.ts`: latest selection (order_by_date first entry); pinned selection
  (match / not-found error); malformed collection / empty entries → typed error;
  `selectDebUrl` picks `_all.deb`, rejects when absent; `debFilename`; zod
  rejects a body missing required fields.
- `refresh.ts`: first fetch downloads + writes + sentinel; skip-when-current
  (sentinel matches + file present); re-fetch when sentinel drifts or file
  missing; pinned version path; non-2xx → `TimekprMirrorDownloadError`; non-`.deb`
  bytes → `TimekprMirrorInvalidPackageError`; retry succeeds on a later attempt;
  retry exhaustion throws.
- `scheduler.ts`: `tick()` calls refresh and logs the outcome; a thrown refresh
  is caught, logged, and backed off (never escapes the tick); backoff clears
  after a success; `stop()` halts; default pattern + log component exported.

## Quality gate (each phase, from `server/`)

`npm run format` · `npm run lint:fix` · `npm run typecheck` · `npm test`
(coverage ≥ 80%). No new runtime dependency (croner, zod, better-sqlite3 already
present).

## Deferred (tracked in the epic, not this slice)

- Signed apt index generation + `/apt/timekpr/*` serving + enrol advertisement →
  **#393** (also where cryptographic integrity lands).
- Client `install-baseline-tools.sh` mirror repo path + orchestrator/enrol
  plumbing → **#394**.
- Docs (`server-deployment.md`, `licensing-analysis.md`) + license-guard
  confirmation → **#395**.
- Optional upstream **source-package** mirroring (ADR default is a documented
  upstream source pointer) → epic #389 enhancement.
