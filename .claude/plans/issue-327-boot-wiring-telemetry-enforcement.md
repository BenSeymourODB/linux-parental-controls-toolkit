# Issue #327 — Boot wiring: telemetry pull → UsageSample rollup → enforcement sweep

**Phase:** 8 (per-activity enforcement) composing Phase 5 (telemetry).
**Branch:** `claude/youthful-allen-3ewj13` (session-designated).

## Goal

Turn on the live periodic loop so per-activity enforcement actually runs in a
deployed dashboard:

1. A **real telemetry consumer** that fetches AW window/afk events, normalises
   them (`normaliseWindowEvents`, #88), and inserts `UsageSample` rows
   (`insertUsageSamples`) into `scheduleTelemetryPull`'s `consume()` seam.
2. **Start `scheduleTelemetryPull` at boot** (after `listen`) and **drive the
   enforcement sweep right after each rollup pass** via
   `EnforcementSweepHandle.tick()` — one timer, so enforcement reads fresh
   usage rather than racing the rollup on a separate timer.
3. Construct the single long-lived `ForceCloseTrigger` once at boot via
   `createForceCloseDeps({ db, eventHub, ssh, credentials, sink, logger })` and
   hand it to the sweep.
4. Env-configurable cadence + cool-down (`PCT_*`); both handles stop on
   `app.close()`.

## What already exists on `main` (all landed, unit-tested)

- `transport/activitywatch/telemetry.ts` — `runTelemetryPull` (per-client pass
  over a `consume` seam) + `scheduleTelemetryPull` (the croner wrapper). The
  default consumer is a liveness probe; #88's normaliser plugs into the same
  `consume` seam.
- `transport/activitywatch/normalise.ts` — `normaliseWindowEvents` (pure).
- `transport/activitywatch/client.ts` — `ActivityWatchClient` with
  `getWindowEvents` / `getAfkEvents` (REST-only, over the loopback tunnel).
- `policy/usage.ts` — `insertUsageSamples(db, samples)`.
- `enforcement/sweep.ts` — `startEnforcementSweep` (long-lived, cool-down held
  across passes, per-user isolation) + `loadSupervisedUsers`.
- `enforcement/force-close.ts` / `force-close-deps.ts` — `ForceCloseTrigger` +
  `createForceCloseDeps`.
- `config.ts` — `settings.telemetry.pullCron` + `pullConcurrency` already
  parsed; `settings.defaultTz`; `settings.sshPrivateKeyPath`.

## Design decisions

### One timer, not two (sweep becomes caller-driven)

`startEnforcementSweep` currently always constructs its own `*/5` cron. #327
wants `tick()` driven off the telemetry pull so enforcement reads fresh usage.
Add an **additive** option: `pattern?: string | null`. When `pattern === null`
the sweep creates **no internal cron** (caller-driven; `stop()` is a no-op),
and the boot wiring calls `sweep.tick()` at the end of each telemetry `run`.
Default (undefined) keeps today's behaviour. Backward compatible; existing
callers/tests unaffected.

### Per-client pull cursor (in-memory)

`usage_samples` has no uniqueness constraint and there is no pull cursor yet
(#162 deferred it; `insertUsageSamples`' doc explicitly assigns cross-pull
dedup to the pull layer). Since #327 is what first enables real inserts,
shipping without a cursor would double-count on overlapping pulls. Implement a
**minimal in-memory per-client cursor** (`Map<clientId, Date>`): each pass
queries `[cursor ?? (passStart − initialLookback), passStart]` and, on a
successful insert, advances the cursor to `passStart`, giving contiguous,
non-overlapping windows within a process lifetime.

- On first sight of a client (or after restart) the cursor is seeded from
  `passStart − initialLookback` (default = one pull interval, bounded), so a
  restart re-pulls at most the lookback window. Overlap on restart is bounded;
  a **durable cursor** that survives restart is a tracked follow-up.
- Missing telemetry credits **no** consumption (#88), so a restart gap is
  non-punitive.

### Single supervised user per client (Alpha-1)

`aw-server` binds one OS account's activity on `:5600`; the tunnel can't
disambiguate multiple accounts. Resolve the client's supervised user via
`usersOnClients`: exactly one → attribute; zero → skip; more than one → log a
warning and skip (matches the per-client single-verdict decision in the AW
health probe, PR #370). True multi-user-per-client attribution (per-user
`aw-server` ports) is deferred and tracked (#103 / #369 area).

### No second SSH pool coupling

The pipeline needs `withPortForward` (telemetry) + `exec` (pkill fallback) +
credentials. Rather than plumbing through the encapsulated policy-push pool
(and colliding with in-flight PR #365), the pipeline factory builds its own
`SshTransport` (injectable for tests) and disposes it on `stop()`, and loads
credentials via `loadSshCredentials(settings.sshPrivateKeyPath)`. When the key
is absent (dev/CI/tests/pre-keygen) the factory returns `null` and boot wiring
is a no-op — mirroring `createPolicyPushTransport`'s logging fallback.

### Boot pattern (mirrors ansibleVenv / adguardManaged / adguardHealthPoll)

`buildApp` **constructs** the pipeline (or `null`) and decorates it; it does
**not** start any timer (so building the app — including every test — starts
nothing). `main.ts` calls `app.enforcementPipeline?.start()` after `listen`.
`buildApp`'s `onClose` hook stops it.

## Config additions

- `settings.enforcement.cooldownSeconds` ← `PCT_ENFORCEMENT_COOLDOWN_SECONDS`
  (positive int, default 300). Cadence reuses `settings.telemetry.pullCron`
  (one timer). Optionally `settings.enforcement.initialLookbackSeconds`
  (default = a bounded value, e.g. 900) for the first-pass window.

## Phases

**Phase 1 — sweep caller-driven option + config.**
- `enforcement/sweep.ts`: `pattern?: string | null`; `null` ⇒ no cron, `stop()`
  no-op; keep `tick()`. Tests: null ⇒ no cron fires but `tick()` works;
  `stop()` safe.
- `config.ts`: `enforcement` block (`cooldownSeconds`, `initialLookbackSeconds`)
  + env wiring. Tests: default, override, invalid rejected.

**Phase 2 — telemetry consumer + pipeline factory.**
- New `enforcement/telemetry-consumer.ts`: a `consume` factory closing over
  `{ db, awClientFactory, cursor, passEndRef, logger }` — resolve user, fetch
  window+afk, load activities, normalise, insert, advance cursor.
- New `enforcement/pipeline.ts`: `createEnforcementPipeline(opts) →
  { start(): void; stop(): void } | null`. Assembles trigger + sweep
  (`pattern: null`) + client loader + consumer + `scheduleTelemetryPull`.
  `run = async () => { passEnd = now(); await runTelemetryPull(...); sweep.tick(); }`.
- Unit tests: consumer inserts for single-user client; skips 0/multi-user;
  cursor prevents double-count across two passes; `run()` calls `tick()` after
  the pull; `stop()` stops cron + sweep + disposes transport; `null` when no
  creds.

**Phase 3 — boot wiring.**
- `web/app.ts`: build pipeline from settings/db/eventHub/log; decorate
  `app.enforcementPipeline`; `onClose` stop.
- `main.ts`: `app.enforcementPipeline?.start()` after `listen`.
- File follow-up issue(s): durable pull cursor; multi-user-per-client
  attribution. Link from PR.

## License boundary

None touched. `aw-server` is reached only over its REST API through the
server-initiated loopback SSH tunnel; `pkill`/`timekpra` stay exec-over-SSH
subprocesses; no GPL source linked, no GPL binary added to the image.

## Out of scope (tracked)

- Part 2 of #292 (cancel grace timer on grant top-up) — Phase-10 grant
  pipeline; stays on #292.
- Durable per-client pull cursor — new follow-up issue.
- Multi-supervised-user-per-client telemetry attribution — #103 / #369 area.
- Domain/domain_group (web-proxy) usage — #195.
- Live `timekpra`/SSH round-trip confidence gate before trusting periodic
  enforcement on a real client — #157 (live-infra, separate).
