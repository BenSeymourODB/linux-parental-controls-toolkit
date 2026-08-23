# Plan — #399 Push date-specific exception overrides to the client (and revert)

Roadmap: `docs/roadmap.md` → Phase 13 (the enforcement follow-up ADR 0012 §3 defers).
Issue: [#399](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/399).
Builds on: #142 / PR #398 (ADR 0012, resolver-side exception composition), #84
(offline queue + replay), #143 (effective-policy resolver), #140 (weekly
allowed-hours grid), #232 (platform runner seam).

## The gap

ADR 0012 composed date-specific `exceptions` (`allow` / `deny` / `extend`, own +
inherited group) into the effective-policy resolver: they now shape the per-day
`allowedWindows` served by `GET /api/users/:userId/effective` (the display /
`?date=` preview). ADR 0012 §3 is explicit that this is the **resolver/display**
slice only, and that **pushing** a date-specific override to the client's
`timekpra` allowed-hours *when its window arrives* (and reverting after) is a
separate offline-queue scheduler concern — this issue.

Today the standing push (`transport/policy-push`, `policy/weekly-windows.ts`)
resolves the **recurring** weekly grid with **no exceptions**, so a
"screen-free vacation week" / "allow games until 9pm tonight" override is correct
in the dashboard but never reaches the device.

## Key facts that shape the design (from ADR 0012)

1. **Exceptions move only `allowedWindows`, never seconds.** An additive time
   amount is a `Grant`, not an exception. So the representation is a **per-day
   allowed-hours override**, *not* a daily-limit override — the issue's open
   "allowed-hours vs daily-limit" question is settled by the ADR.
2. **Only `overall`-scoped exceptions have an observable effect today.**
   `activity` / `group` exceptions are gathered and composed but resolve to a
   no-op until per-target deny enforcement lands (out of scope here, as in the
   ADR). The design handles this for free: a no-op exception produces the same
   grid as standing, so nothing is pushed.
3. **Exceptions must stay out of the *recurring* weekly grid.** `timekpra`
   allowed-hours is a static weekly grid keyed by ISO weekday; a one-off calendar
   date cannot be a weekly pattern. Folding "this Tuesday's override" into the
   standing grid would alias onto *next* Tuesday. So the **standing push stays
   exception-free** (the clean recurring baseline / revert target), and a
   dedicated scheduler pushes the exception-inclusive grid for the current
   reference week, reconciling daily so any weekday-slot aliasing self-corrects
   well within the 7-day horizon.

## Design

### The push content — reuse the standing push stack, exceptions threaded through

The exception-inclusive grid is the standing grid with each of the seven days of
the *current reference week* resolved **with** the user's exceptions. Rather than
a parallel push path, thread an **optional `exceptions` (default `[]`)** through
the existing stack so behaviour is byte-identical when omitted:

- `policy/weekly-windows.ts` — `WeeklyWindowsInput.exceptions?`; passed to
  `effectivePolicy` per weekday. Default `[]` ⇒ the recurring-only grid, unchanged.
- `transport/policy-push/resolve.ts` — `PolicyPushResolveInput.exceptions?`;
  forwarded to `resolveWeeklyAllowedWindows`. Seconds (`perWeekdaySeconds`,
  weekly/monthly) are unchanged — exceptions don't touch them (fact 1).
- `transport/policy-push/platform-runner.ts` — `PolicyEnforcementContext.exceptions?`.
- `transport/policy-push/linux-runner.ts` — forwards `ctx.exceptions` to
  `resolvePolicyPush`.
- `transport/policy-push/executor.ts` — `createPolicyPushExecutor({ …, includeExceptions? })`.
  When true, the executor also loads `gatherUserExceptions(db, userId)` (own +
  inherited group, ADR 0012 precedence) and passes it to `runner.enforce`.
  Standing pushes leave it `false` (recurring grid stays exception-free).

Reusing `applyResolvedPush` inherits its full-lockout behaviour: a **single-day**
deny within an otherwise-allowed week pushes fine (that weekday empty); a
**whole-week** deny (every weekday empty) hits the existing `--setalloweddays`
empty-set skip (full lockout is Phase 8c — zero daily limit / session-kill, not
allowed-hours). Unchanged and correct.

### The scheduler — `transport/exception-push/`

A croner job modelled on `transport/reapply/scheduler.ts` and the offline-queue
drainer (injected seams, `protect: true`, `{ tick(); stop() }`, injected clock +
logger, no GPL coupling). A new queue **kind** `policy.push.exceptions` carries
the override push; its executor is `createPolicyPushExecutor({ includeExceptions:
true })`, registered in the drainer's composite executor so an **online push and
an offline replay run identical code** and a queued override **re-resolves the
current exception state at drain time** (auto-reverting if it expired while the
client was offline).

The queued action reuses coalesce key `user:<id>` (same as the standing push):
coalescing is kind-agnostic (`UNIQUE(client_id, coalesce_key)` +
`onConflictDoUpdate` that updates `kind`), so an override push and a standing
push represent the same target's latest desired state and supersede each other —
either ordering self-heals on the next scheduler tick.

**Each tick** (reference instant from an injected clock):

1. **Candidates** = users with any exception whose active window
   `[effective_from ?? created_at, expires_at)` has `expires_at ≥ now − LOOKBACK`
   (8 days, covering the weekly-grid aliasing horizon), **plus** any user still
   tracked as overridden. `gatherUserExceptions` is used (not the own-only
   repository read) so group-inherited overrides count.
2. For each candidate compute `desiredSig` = a stable signature of the
   **exception-inclusive** weekly grid, and `standingSig` = the exception-free
   grid, for the current reference week in the user's effective tz.
3. **Decision**, tracking only the set of currently-overridden users (to fire
   the revert once), **not** a change-detection cache:
   - While an override is **materially active** (`overrideGrid !== standingGrid`)
     push **every tick**. A standing policy push can clobber the device's grid
     out-of-band (it resolves the exception-free grid and shares this push's
     coalesce key) and the scheduler cannot observe that, so idempotent
     re-pushing bounds any clobber to at most one cron interval — the correctness
     the "push on change" optimisation would have silently broken for a `deny`.
   - When the grid has fallen back to **standing**, push the revert exactly once
     (a tracked user, or the first-pass sweep), then untrack.
   - **First tick after start** reconciles every user with *any* exception row
     (regardless of age): re-assert active overrides and revert any that expired
     during downtime — including an outage longer than the steady-state lookback.
   - Steady-state candidacy skips users whose exceptions are all older than the
     lookback and who are not tracked.
4. A push fans out to every `listUserLinks(db, userId)` client via
   `pushOrEnqueue(db, action, exceptionExecutor)` — online → pushed; unreachable
   (retriable) → queued for the drainer; non-Linux platform → the executor's
   existing warn-and-no-op. Audit is automatic (the executor's `TimekprClient`
   runs over the audited transport); a distinct reason (`exception.window`) makes
   overrides queryable.

Config: `PCT_EXCEPTION_PUSH_CRON` (default `*/15 * * * *` — responsive to a
same-day "adjust bedtime" override without being chatty; reapply is hourly,
telemetry every 5 min). Wired in `createPolicyPushTransport` (needs the audited
`TimekprClient` factory + SSH credentials, exactly like the drainer), stopped in
its `dispose` (already called by `AppServices.teardown`). No live transport (no
SSH key) ⇒ not started, mirroring the drainer.

## Implementation phases

### Phase 1 — thread exceptions through the push stack (pure / near-pure)
- `weekly-windows.ts`, `policy-push/resolve.ts`, `platform-runner.ts`,
  `linux-runner.ts`, `executor.ts` — the optional `exceptions` / `includeExceptions`
  seam (all default-off ⇒ standing push byte-identical).
- Tests: `resolvePolicyPush` with/without exceptions (deny shrinks a day, extend
  widens past a standing deny, other days standing); `resolveWeeklyAllowedWindows`
  exceptions param; executor `includeExceptions` loads `gatherUserExceptions` and
  forwards it (spy runner); standing path unchanged (existing tests stay green).

### Phase 2 — the scheduler + kind + config + wiring
- `transport/exception-push/{scheduler.ts,index.ts}` + the `policy.push.exceptions`
  kind + queued-action builder.
- `config.ts` `exceptionPush.cron` + `.env.example` + `docs/server-deployment.md`.
- `bootstrap.ts` — build the include-exceptions executor, register it in the
  drain composite, construct + dispose the scheduler.
- Tests: tick pushes an override grid for an active deny/extend; no push for a
  user with no override or an activity/group-only (no-op) exception; revert push
  once after expiry then stable; first-tick reconcile after restart; multi-client
  fan-out; group-inherited override detected; offline client → queued;
  overlap-protection / start-stop lifecycle / default pattern export;
  config default + override + invalid; `buildApp` teardown stops it.

## Deferred (tracked follow-ups, linked from the PR)
- **Admin policy save during an active override** transiently clobbers the
  override grid (the standing push is exception-free). The scheduler re-asserts
  it automatically on the next tick (it re-pushes every pass while an override is
  materially active), so this is a bounded ≤ one-cron-interval transient, not a
  lost override. Shrinking that window (standing push delegating to the
  override-inclusive resolve while an override is active) is tracked as **#421**.
- **Per-activity / group `deny` quota reduction** — out of scope per ADR 0012
  (recurring schedules don't do it either); only `overall` overrides are enforced.
- **Whole-week deny → full lockout** — the existing Phase 8c gap (zero daily
  limit / session-kill), unchanged.
