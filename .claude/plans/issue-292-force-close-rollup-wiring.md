# Issue #292 — Drive the force-close trigger from the rollup loop

Roadmap: docs/roadmap.md -> Phase 8. Follow-up to #99 (ForceCloseTrigger seam) and #98 (evaluateUserEnforcement DB seam).

## State found in the tree (shapes the scope)

The repo's established pattern: ship each periodic job as a seam-injected,
unit-tested start* unit and defer the main.ts boot wiring.

- The offline-queue drainer (#84), the periodic re-apply scheduler, and the
  telemetry pull (#162) are ALL built + tested but NOT started in main.ts.
- #88 shipped the pure normaliser + insertUsageSamples but EXPLICITLY deferred
  "wiring the normaliser into #162's scheduled pull consume() seam." So the pull
  runs only a liveness-probe consumer — no UsageSample rows from any wired loop.
- #99 shipped ForceCloseTrigger + createForceCloseDeps and EXPLICITLY deferred
  "the croner wiring."

Consequence: there is NO rollup loop running at boot to hang enforcement off of.
Wiring the whole telemetry -> normalise -> insert -> enforce chain into main.ts
spans three issues' worth of glue and would break "keep PRs small and focused."

## Scope for this PR (faithful, focused slice)

Deliver the enforcement sweep orchestrator — the long-lived driver that drives
the trigger from a rollup pass. Built as a seam-injected start* unit like its
siblings (startPeriodicReapply).

server/src/enforcement/sweep.ts:

- loadSupervisedUsers(db): distinct { id, tz } for users with >=1
  users_on_clients link.
- startEnforcementSweep(options) -> EnforcementSweepHandle { tick(); stop() }:
  - Holds per-user cool-down state (Map<userId, ReadonlyMap<targetKey, Date>>)
    across passes; rebuilt each pass from the current supervised set so a user
    that lost all links is pruned (bounded memory).
  - Holds the injected single long-lived ForceCloseTrigger (grace timers de-dup
    across passes).
  - tick(): per supervised user resolve tz (resolveEffectiveTz), call
    evaluateUserEnforcement with the carried lastFiredAt, store the returned
    lastFiredAt, trigger.enforce(userId, decisions) when any. One user's throw is
    logged + isolated, never aborting the pass.
  - evaluate is an injected seam defaulting to the real evaluateUserEnforcement.
- Constants DEFAULT_SWEEP_PATTERN (every 5 min), DEFAULT_COOLDOWN_SECONDS,
  SWEEP_LOG_COMPONENT. Barrel export from enforcement/index.ts.

tick() is both the cron-tick body and the seam the eventual boot wiring calls
right after the telemetry rollup. No config.ts change (constants + options).

## Deferred (tracked -> follow-up issues filed from the PR)

- Part 2 — cancel a pending grace timer on grant top-up. Needs a cancel handle on
  ForceCloseTrigger + a Phase-10 grant-pipeline hook (#117 / #108). New issue.
- main.ts boot composition: telemetry pull -> normalise/insert UsageSample ->
  enforcement sweep, so the live rollup loop drives tick(). Depends on #88's
  deferred consumer composition. New issue.

## License boundary

None touched — pure TypeScript + Drizzle reads + croner; the trigger it drives is
the existing #99 service (events + SSH pkill, already on the correct boundary).
No GPL linkage, no GPL binary, no Docker change.

## Tests (server/tests/enforcement/sweep.test.ts)

- loadSupervisedUsers: only linked users, distinct, carrying tz.
- Cross-pass cool-down threading via an injected evaluate spy (prev pass output
  fed back in; cleared-on-drop re-fires).
- Trigger de-dup across passes: real ForceCloseTrigger + fake deps, schedules
  once for a target still pending grace.
- Per-user isolation: one user's evaluate throwing doesn't abort the pass.
- Real-path end-to-end: seeded exhausted budget+usage -> default
  evaluateUserEnforcement -> decision reaches trigger.enforce.
- start/stop lifecycle + DEFAULT_SWEEP_PATTERN validity.
