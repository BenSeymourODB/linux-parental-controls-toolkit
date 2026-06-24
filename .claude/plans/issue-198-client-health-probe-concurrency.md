# Plan — #198: bounded concurrency / per-list deadline for `listClientHealth`

Roadmap: `docs/roadmap.md` → Phase 3 (client health/status). Follow-up to
#81 (PR #196), related to #39 (live SSH prober wiring).

## Problem

`api/clients/health-service.ts` `listClientHealth` probes clients **strictly
sequentially**. That is fine today (no live prober — no SSH credentials until
#39), but once the live SSH prober lands, each unreachable client waits the
full SSH `readyTimeout` (default 10s) in series, so a fleet with N dead hosts
makes `GET /api/clients/health` take ~N×10s. One wedged host stalls the whole
page.

## Scope (this PR)

The live prober isn't wired into the routes yet, so this lands the *bounds*
ahead of that wiring (the same "parsed-and-ready ahead of wiring" pattern the
`telemetry`/`reapply` config blocks already use). The issue explicitly says
"Before/with the live prober wiring, bound the fan-out."

1. **Shared concurrency util.** Extract an **order-preserving**
   `mapWithConcurrency<T, R>(items, limit, worker): Promise<R[]>` into a new
   `server/src/util/concurrency.ts`. Today's copy is **private and unordered**
   (`Promise<void>`) in `transport/activitywatch/telemetry.ts`; refactor
   telemetry to consume the shared one so there is a single implementation
   (behaviour identical — telemetry ignores the result and doesn't care about
   order). Also export a small injectable deadline primitive
   (`timerDeadline`) so the per-list deadline is deterministically testable.

2. **Bounded + deadline-bounded list walk.** `listClientHealth` gains an
   options object `{ concurrency, deadlineMs, deadlineFactory? }`:
   - walk clients with at most `concurrency` probes in flight
     (`PCT_CLIENT_HEALTH_PROBE_CONCURRENCY`, default 4, mirroring
     `telemetry.pullConcurrency`);
   - race every probe against a single shared per-list deadline
     (`PCT_CLIENT_HEALTH_PROBE_DEADLINE_MS`, default 15000ms ≈ 1.5× the 10s
     SSH `readyTimeout`; `0` disables). A probe that hasn't answered by the
     deadline — or one that **throws** — degrades that client to `unknown`
     reachability/components with a distinct `detail`, while its real
     enrolment + offline-queue state still surfaces. The abandoned in-flight
     probe's eventual settlement is swallowed (no unhandled rejection).
   - results stay ordered ascending by id (preserved by the util).

3. **Config + wiring.** New `clientHealth` block in `config.ts`; thread the two
   values through `ClientHealthRoutesDeps` → `registerClientHealthRoutes` →
   `listClientHealth`. `apiPlugin` passes them from `settings.clientHealth`.

### Deliberately out of scope

- `getClientHealth` (single client) is unchanged: it probes exactly one host,
  bounded by that host's own SSH `readyTimeout`; the fan-out/deadline concern
  is list-specific. Keeping it untouched preserves its existing behaviour and
  tests.
- Wiring the live `prober` itself into the routes — that's #39.

## Assemble-detail cases

`assemble()` grows an explicit `unknownDetail` argument so the three
`probe === undefined` reasons read distinctly:
- no prober configured → existing `"SSH probing not yet configured (#39)"`;
- probe exceeded the list deadline → `"probe deadline exceeded (#198)"`;
- probe threw → `"probe failed: <message>"` (also logged at warn).

## Phases

- **Phase 1** — `util/concurrency.ts` (order-preserving map + `timerDeadline`)
  + unit tests; refactor `telemetry.ts` to use the shared map. Gate, commit,
  push → opens the draft PR.
- **Phase 2** — `listClientHealth` bounded + deadline + per-host error
  isolation; `assemble` detail param; `clientHealth` config block; route +
  plugin wiring; tests (service + config). Gate, commit, push.

## Tests

- `util/concurrency.test.ts`: order preserved under concurrency; respects the
  limit (max in flight); `limit<1` coerced to 1; empty input; `timerDeadline`
  resolves and `cancel()` clears the timer (fake timers).
- `health-service.test.ts` (added cases): list preserves order under
  concurrency; a hung probe past the deadline degrades just that client to
  `unknown` (others still probed) via an injected manual deadline; a throwing
  probe is isolated to its client; deadline disabled (`0`) waits for all;
  existing sequential-behaviour tests still pass.
- `config.test.ts` (added cases): `clientHealth` defaults; env overrides;
  rejects a non-numeric/negative concurrency; `deadlineMs` `0` accepted.

## License boundary

None touched — pure TypeScript; all remote work stays inside the injected
prober over the SSH subprocess facade. No new dependency. No GPL surface, no
Docker-image change. `license-guard` unaffected.
