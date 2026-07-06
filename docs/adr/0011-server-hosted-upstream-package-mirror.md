# ADR 0011 — Server-hosted mirror for upstream (GPL) client packages

- **Status:** Accepted (2026-07-06)
- **Issue:** [#389](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/389)
- **Phase:** 14 (Fleet updates & lifecycle management, epic [#163](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/163))
- **Relates to:** ADR issue [#167](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/167)
  (client update *channel* — this ADR revisits its "GPL tools stay upstream"
  decision rule for the specific case of `timekpr-next`).

## Context

Installing Timekpr-nExT on a client currently has three shapes, in order of
preference (`client/install-baseline-tools.sh`, after #329):

1. **Distro repository (default).** `apt install timekpr-next` from Debian/
   Ubuntu. No external repo, fast, but Mint's referenced version *lags* the
   upstream PPA.
2. **Upstream PPA (`PCT_TIMEKPR_USE_PPA=1`, opt-in).** Newer, but requires a
   Launchpad round-trip on the client. `add-apt-repository`'s Launchpad lookup
   has a ~10s timeout hardcoded in `software-properties` (not configurable); we
   worked around it by adding the PPA ourselves with a configurable-timeout
   curl-based keyring path, but that *still puts Launchpad on the client's
   critical path* during enrolment.

Two real problems remain, both observed on a live Mint enrolment:

- **Launchpad latency.** On a slow link the PPA path stalls or fails — even the
  curl-based add with a raised timeout is at the mercy of Launchpad's
  responsiveness, per client, every install.
- **Version freshness.** The distro package can be too old to carry upstream
  fixes we need, so "just use the distro package" isn't always sufficient, and
  the PPA (the fresh source) is exactly the slow one.

The homelab already runs the dashboard on the LAN, and every client talks to it
during install + enrol. So the dashboard is the natural place to hold a
fast-to-reach, up-to-date copy of the package.

### The constraint that shapes everything: the license boundary

`timekpr-next` is GPL. `CLAUDE.md` rule 5 and `docs/licensing-analysis.md` are
strict: **the published image must contain no GPL binaries.** But that document
also draws the line precisely:

- The installer is *already* "effectively a distribution of GPL software," and
  the source-availability obligation is "trivially satisfied since all of these
  are publicly available" — satisfied by mirroring the source **or** pointing at
  upstream (`licensing-analysis.md`, installer-as-distribution + the
  quick-reference obligations).
- The **key risk** is bundling GPL binaries *into the image* — that would make
  the whole image GPL-encumbered.

So re-hosting a GPL `.deb` is not itself the problem; baking it into the image
would be. This is the same distinction that already lets **managed-mode AdGuard
Home** (GPL) be fetched at runtime into `/data` rather than shipped in the image
(ADR 0009, `server/src/config.ts` → `adguardSchema`, `docs/server-deployment.md`).

Issue #167 (the client-update *channel* ADR) deliberately scoped itself to *our
own* `pct-client` agent `.deb` and said the GPL tools "keep coming from the
distro/PPA/upstream." This ADR is the deliberate reconsideration of that rule
for `timekpr-next`, now that we have a concrete latency/freshness reason.

## Decision

Add a **managed mirror mode** for `timekpr-next`, modelled on the AdGuard Home
`disabled | external | managed` trichotomy:

- **`disabled` (default).** Today's behaviour: client installs from the distro
  repo; the PPA remains opt-in. No mirror.
- **`managed`.** The dashboard maintains a small **apt repository under
  `/data/apt/timekpr/`** — materialised at runtime, **never in the image** —
  refreshed from upstream by a background job, and served over the existing
  Fastify process. Clients are told about it at enrol and point apt at the LAN
  dashboard instead of Launchpad.
- **`external` (optional).** Point clients at an apt repository the homelab
  already hosts.

The **mirrored package/channel is configurable**: managed mode serves either
the stable `timekpr-next` or a beta variant (e.g. `timekpr-next-beta`) if the
operator opts into it — chosen on the server, so a client never has to know or
care which channel it's getting.

### Confirmed direction (2026-07-06, #389)

The maintainer confirmed the two open questions:

- **Ship the MVP first** (mode B below — serve the cached `.deb` over the LAN,
  advertised at enrol), then graduate to the signed apt repo.
- **Default to the documented upstream source pointer** for the GPL
  source-availability obligation (source-package mirroring stays an optional
  enhancement).

Both are bounded by one **guiding requirement**: clients must be able to get an
up-to-date `timekpr-next` (or `timekpr-next-beta`) **without any dependence on
a `launchpad.net` PPA-add at install time** — i.e. Launchpad must not sit on
the client's critical path. That is the whole point of the mirror.

This keeps the boundary intact by construction:

1. **Image stays GPL-free.** The mirror lives in the `/data` volume, fetched at
   runtime — exactly the AdGuard managed-mode precedent. `license-guard.yml`
   (which scans the image) stays green.
2. **Process/network boundary preserved.** The dashboard only *fetches* and
   *serves files* and, at most, shells out to packaging tools as subprocesses
   (the ansible/`timekpra` pattern). No GPL code is linked in-process. Index
   generation is done in TypeScript where practical, so no GPL repo-tooling
   (`apt-ftparchive`/`dpkg-dev`) need enter the image at all.
3. **Source availability.** Satisfied by mirroring the upstream **source
   package** alongside the binary **or** by publishing a documented pointer to
   the PPA's source (both accepted by `licensing-analysis.md`). Default:
   binary mirror + documented upstream source pointer; source mirroring is an
   optional enhancement for a fully self-contained deployment.

**Why this solves the actual problems:** the upstream fetch moves to a
background job on the server — off every client's critical path, retryable, and
cached — so a slow Launchpad never blocks an enrolment again; and clients get
whatever (newer) version the server has pulled, decoupled from the distro's lag.

## Alternatives considered

- **A. Keep the PPA, just raise the timeout (status quo after #329).** Rejected
  as insufficient: each client still round-trips to Launchpad on the critical
  path, so a consistently slow Launchpad still stalls installs. Retries don't
  help when the per-attempt latency itself is the problem.
- **B. Server-side prefetch/cache only** (serve the cached `.deb` as a plain
  file, no repo semantics). This is in fact the **MVP** of this decision — it
  kills the client latency with roughly half the work. It lacks clean
  `apt upgrade`/pinning/rollback, so it graduates into the full apt repo when
  in-place fleet upgrades matter (which is the Phase 14 goal). Adopted as the
  first increment, not the end state.
- **C. Build `timekpr-next` from source on the server.** Rejected: heavy (build
  toolchain, per-suite/arch builds) and unnecessary — the PPA already publishes
  prebuilt binaries at the version we want. Contradicts the "orchestrate, don't
  reimplement" principle. Revisit only if we ever need to patch the package.
- **D. Bake the `.deb` into the image.** Rejected outright — it violates the
  license boundary (the whole image becomes GPL-encumbered), the exact failure
  mode `licensing-analysis.md` warns about.

## Consequences

- A new server subsystem (config mode, background fetch/refresh job, apt index +
  serving, enrol-time advertisement) and a client repo path in
  `install-baseline-tools.sh`. Tracked as the sub-tasks of #389.
- The dashboard now stores release artifacts in `/data` (disk cost; document
  it) and holds a repo signing key in `/data` (generated at first run, like the
  AdGuard/secret material already there).
- `docs/licensing-analysis.md` gains an explicit note that a `/data`-resident
  runtime mirror of a GPL package is within the boundary, and how the
  source-availability obligation is met. `docs/server-deployment.md` documents
  the modes and volume layout.
- The version the server serves becomes a first-class fleet fact, aligning with
  the enrolment version inventory (#164): the dashboard knows exactly what it is
  offering and can diff it against what each client reports.
- **Rollout:** ship the MVP (mode B — serve the cached `.deb` over the LAN,
  advertised at enrol) first, then graduate to the signed apt repo with
  scheduled refresh for clean in-place upgrades under the Phase 14 umbrella.
