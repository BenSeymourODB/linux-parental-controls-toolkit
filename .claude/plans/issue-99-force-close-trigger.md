# Plan — #99: emit `enforce.force_close` after grace + SSH `pkill` fallback

Roadmap: `docs/roadmap.md` → **Phase 8** ("Per-activity time enforcement").
Issue: #99. Builds on #98 (decision core), #100 (event channel), Phase-4 SSH
facade, #85 audit.

## What's already on `main`

- `enforcement/decision.ts` (#98) — `decideEnforcement` → `EnforcementOutcome`
  with `decisions: EnforcementDecision[]`, each `{ scope, targetId,
  allowedSeconds, consumedSeconds, overageSeconds, graceSeconds }`.
- `enforcement/evaluate.ts` (#98) — DB seam that produces those decisions.
- `events/hub.ts` (#100) — `EventHub.publishToClient(clientId, event)` returns
  the number of sockets the frame reached (`0` ⇒ client offline).
- `events/taxonomy.ts` (#100) — `enforce.force_close = { userId, activityId }`.
- `transport/ssh/facade.ts` — `SshTransport.exec`, `targetFromClient`.
- `transport/audit/*` (#85) — `AuditSink` + the SSH-target-shaped `audit_log`.
- Schema — `users_on_clients` (`osUserRef`), `activities`
  (`matcher`/`matchType`, ADR 0006; `kind`), `activities_to_groups`.

**Not on `main`:** the telemetry scheduler (#117) that calls
`evaluateUserEnforcement` on each rollup and would feed decisions into this
trigger. So this PR ships the trigger as a **seam-injected service**, unit-
tested with fakes; #117 wires it.

## Design

A grace-delayed **force-close trigger**. Given a user's `EnforcementDecision`s
it schedules, after each decision's `graceSeconds`, a dispatch that for every
client the user is enrolled on either emits `enforce.force_close` (agent does
the kill) or — when the bridge isn't reachable — runs a user-scoped `pkill`
over SSH. Both paths are audited.

### Modules (mirrors the `decision.ts`/`evaluate.ts` pure-core + DB-seam split)

1. **`enforcement/force-close-pkill.ts`** — pure `buildPkillArgv(osUserRef,
   matcher, matchType)`. Always `-u <osUserRef>`-scoped so a stray pattern can
   never reach another account or root. `exact` → `-x <ere(matcher)>`;
   `substring` → `-f <ere(matcher)>`; `glob` → `-f <globToEre(matcher)>`;
   `regex` → `-f <matcher>`. Guards an empty pattern. Shell-safety is the
   facade's `shellQuoteCommand`; this only handles ERE matching semantics.
2. **`enforcement/force-close.ts`** — `ForceCloseTrigger` + the seam interface
   `ForceCloseDeps`. Pure dispatch + grace scheduler:
   - `enforce(userId, decisions)`: per decision, de-dup on
     `${userId}:${scope}:${targetId}` while one is pending, `schedule(...,
     graceSeconds*1000)`, then dispatch.
   - dispatch: `resolveActivities(scope,targetId)` → app activities to close;
     for each enrolled client and each activity, `publishToClient`; if
     `delivered > 0` record the event-audit, **else** `forceCloseOverSsh`
     (delivery count is the single source of reachability truth — handles the
     check-then-close race for free).
3. **`enforcement/force-close-deps.ts`** — DB/transport/hub/sink-backed factory
   `createForceCloseDeps(...)` producing `ForceCloseDeps`:
   - `clientsForUser` — `users_on_clients ⋈ clients`, `sshTarget` via
     `targetFromClient`.
   - `resolveActivities` — `activity` → `[self]`; `group` → members via
     `activities_to_groups`; **filtered to `kind: "app"`** (domain budgets are
     web-filter enforcement, not process kills — Phase 6/7).
   - `forceCloseOverSsh` — `buildPkillArgv` → `transport.exec`; outcome mapped
     with pkill's convention (exit `0`/`1` ⇒ `ok` — `1` = "nothing to kill",
     not a failure; `unreachable`/`timeout`/`failed` from the SSH taxonomy) and
     recorded. (Not routed through `AuditingTransport` precisely because its
     non-zero-⇒-failed mapping would mis-record pkill's exit `1`.)
   - `recordEventAudit` — an `audit_log` row against the client's target,
     synthetic `command` `["enforce.force_close","--user",…,"--activity",…,
     "--via","event-stream"]`, `outcome: "ok"`.
4. **`enforcement/index.ts`** — export the trigger + factory + types.

### Decisions / deferrals

- **Group → member activities** expanded here (event is per-activity).
- **Reachability = delivery count** from `publishToClient`, not a separate
  `isClientLive` probe.
- **Deferred (follow-up issue):** cancelling an in-flight grace timer when a
  grant tops the budget back up mid-grace (needs the Phase-10 grant pipeline);
  the croner wiring (#117). PR **addresses**, not closes, #99.

### License boundary

None touched. `pkill` is exec-over-SSH (same boundary as `timekpra`); events
are plain TS + zod; audit is Drizzle/better-sqlite3. No GPL linkage, no GPL
binary added to the image.

## Phases

- **A** — `force-close-pkill.ts` + tests.
- **B** — `force-close.ts` (trigger + scheduler) + tests.
- **C** — `force-close-deps.ts` + tests; barrel export; `docs` note if needed.

Quality gate after each phase: `format` · `lint:fix` · `typecheck` · `test`
(80% coverage). Tests use fakes / the `tests/helpers/db.ts` test DB — no live
SSH or WebSocket.
