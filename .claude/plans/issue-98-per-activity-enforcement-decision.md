# Plan — #98 Per-activity enforcement: decision logic on UsageSample rollups (+ cooldown)

Roadmap: `docs/roadmap.md` → Phase 8. Architecture: `docs/architecture.md` →
"Inbound (client → server) — telemetry pull" step 4 and "Enforcement
responsibilities" (the **Per-app time quota (granular)** row: *Dashboard
polling + process kill*).

## Goal

The server-side **decision** that, after each telemetry pull/rollup, detects
when a per-activity / per-group quota is exhausted and decides the activity
should be stopped — with a **cool-down / hysteresis** so a flapping near-boundary
sample doesn't re-fire, carrying the policy's `grace_seconds` on each decision.

This issue *decides*. It does **not** emit anything: the actual
`enforce.force_close` event after grace + the SSH `pkill` fallback are **#99**;
the WebSocket channel they publish onto is **#100**. So this module has **no**
dependency on `events/` and produces plain decision data those consumers read.

## Why it is unblocked (a prior run deferred it)

All inputs are already merged:

- `policy/resolve.ts → effectivePolicy()` returns `perActivitySeconds:
  ActivityQuota[]` (`scope: "activity" | "group"`, `targetId`, `seconds`) — the
  effective daily allowance **already composing active grants**. Its docstring
  names "#98/#99" as the consumer.
- `policy/usage.ts → usageByActivityInWindow()` / `groupSecondsInWindow()` give
  per-activity / per-group consumed seconds in the effective window.
- `notification_policies.graceSeconds` (default 60) exists in the schema.

No DB migration, no API route, no `events/` coupling. Pure addition under a new
`enforcement/` module.

## Module shape — `server/src/enforcement/`

### `decision.ts` (pure core — the heart, ~100% unit-covered)

```ts
export type EnforcementScope = "activity" | "group";
export function targetKey(scope: EnforcementScope, targetId: number): string; // `${scope}:${targetId}`

export interface QuotaConsumption {
  readonly scope: EnforcementScope;
  readonly targetId: number;
  readonly allowedSeconds: number;
  readonly consumedSeconds: number;
}

export interface EnforcementDecisionInput {
  readonly now: Date;
  readonly graceSeconds: number;
  readonly cooldownSeconds: number;
  readonly quotas: readonly QuotaConsumption[];
  readonly lastFiredAt: ReadonlyMap<string, Date>; // key → last decision instant
}

export interface EnforcementDecision {
  readonly scope: EnforcementScope;
  readonly targetId: number;
  readonly allowedSeconds: number;
  readonly consumedSeconds: number;
  readonly overageSeconds: number; // consumed - allowed (>= 0)
  readonly graceSeconds: number;   // carried for #99
}

export interface EnforcementOutcome {
  readonly decisions: readonly EnforcementDecision[];
  readonly lastFiredAt: ReadonlyMap<string, Date>; // next cooldown state to keep
}

export function decideEnforcement(input: EnforcementDecisionInput): EnforcementOutcome;
```

Rules:
- **Exhausted** = `consumedSeconds >= allowedSeconds && consumedSeconds > 0`.
  (Requiring `consumed > 0` keeps a `0/0` target — disallowed but idle — from
  firing with nothing running; a deny *window* is the schedule layer's job, not
  budget enforcement.)
- **Cool-down**: if a target fired at `last` and `now - last < cooldownSeconds`,
  suppress the re-fire (keep the existing timestamp). Otherwise emit and set
  `lastFiredAt[key] = now`. Boundary: elapsed **>= cooldown** fires again.
- **Drop-under reset**: a target no longer exhausted has its cooldown entry
  cleared, so a later re-exhaustion (e.g. after the window rolls or a grant tops
  it up) fires promptly. Untouched keys are carried forward unchanged.

### `evaluate.ts` (thin DB seam)

```ts
export interface EvaluateEnforcementInput {
  readonly userId: number;
  readonly now: Date;
  readonly tz: string;          // user's effective tz (User.tz ?? PCT_DEFAULT_TZ)
  readonly cooldownSeconds: number;
}
export function evaluateUserEnforcement(
  db: PolicyDb,
  input: EvaluateEnforcementInput,
  lastFiredAt: ReadonlyMap<string, Date>,
): EnforcementOutcome;
```

- Loads the user's `schedules` / `budgets` / `grants` inline (the same
  read-inline pattern `api/policy/effective.ts` uses to avoid entangling with
  the CRUD repository), runs `effectivePolicy` for `localCalendarDate(now, tz)`,
  and reads `perActivitySeconds`.
- Consumption per quota over the **daily** window: activity-scope →
  `usageByActivityInWindow(...).get(targetId) ?? 0`; group-scope →
  `groupSecondsInWindow({ groupId: targetId, ... })`.
- Reads `notification_policies.graceSeconds` for the user (default 60 when no
  row), then calls `decideEnforcement`.

### `index.ts` barrel + `src/index.ts`/CLAUDE.md module note

Add `enforcement/` to the module split list in `CLAUDE.md` (additive — a new
module, not a contradiction of a documented decision).

## Tests (`server/tests/enforcement/`)

`decision.test.ts` (pure):
- under quota → no decision; carries `lastFiredAt` untouched.
- at-limit and over-limit with `consumed > 0` → decision with correct
  `overageSeconds` + pass-through `graceSeconds`.
- `allowed 0 / consumed 0` → none; `allowed 0 / consumed 5` → fires.
- cool-down: fired at T, re-eval at `T + cooldown - 1s` suppressed; at
  `T + cooldown` fires again.
- drop-under clears the cooldown entry.
- multiple mixed targets; group-scope decision; stable ordering.

`evaluate.test.ts` (in-memory `testDb()`):
- daily activity budget + usage samples crossing it → decision.
- group budget via `groupSecondsInWindow` path.
- grant overlay raises the quota above consumption → no decision.
- grace from a custom `notification_policies` row, and the default 60 when none.
- activity with usage but **no** daily budget (unlimited) → no decision.

## Deferred (tracked, out of scope here)
- `enforce.force_close` emit after grace + SSH `pkill` fallback → **#99**.
- WebSocket event channel → **#100**.
- Persisting cool-down state across restarts: held in-memory by the telemetry
  scheduler for now (a restart re-evaluates fresh; worst case one extra fire).
  If durable cool-down is wanted later it slots behind the same in/out map — I
  will note this in the PR and file a follow-up only if the maintainer wants it.

## Quality gate
`format:check`, `lint`, `typecheck`, `npm test` (coverage gate 80%). No new
dependency. License boundary: N/A — plain TypeScript + Drizzle reads.
