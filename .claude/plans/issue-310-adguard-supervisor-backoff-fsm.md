# Issue #310 — Extract backoff + state-machine from `AdGuardManagedSupervisor`

Roadmap: code-review complexity cleanup (label `code-review`/`complexity`,
severity Medium). No roadmap phase — it is a maintainability refactor of the
Phase-7 managed-AdGuard supervisor (`#96`).

## Sequencing note (cleared)

The issue said "do this after PR #291 (managed-AdGuard wiring) merges." #291 is
no longer open, so the hold is cleared and `transport/adguard/*` is safe to
touch.

## Goal

Behaviour-preserving decomposition of `server/src/transport/adguard/supervisor.ts`
(`AdGuardManagedSupervisor`, ~211 lines). Two extractions the code-review asked
for:

1. **`RestartBackoff` utility** — owns the restart count, the stable-run reset,
   the restart cap, and the exponential-delay computation that is currently
   inline in `#onExit` (`:312-335`). Independently unit-testable.
2. **Explicit lifecycle state machine** — the `AdGuardManagedState` union plus a
   declared **transition table** and a tiny machine that tracks the current
   state, so reachable states and valid transitions are obvious instead of being
   threaded implicitly through `#settle` calls.

No functional change. The existing `tests/transport/adguard/supervisor.test.ts`
(13 tests) is the behaviour guard and must stay green **unchanged**.

## Constraints that shape the design

- **`bootstrap()` never throws** (documented contract; `main.ts` fires it with a
  bare `void`). The event-handler paths `#onExit` / `#onSpawnError` run as
  process-event callbacks *outside* any `try/catch`. Therefore the state machine
  must be **advisory**: an unexpected transition is logged (via the injected
  logger) and still applied — it must never throw. Throwing would risk an
  unhandled exception in an event callback and break the never-throw guarantee.
- **Export surface must be preserved.** `AdGuardManagedState` and
  `AdGuardManagedStatus` are re-exported by `transport/adguard/index.ts` and
  consumed by `service.ts` and `api/system/dtos.ts`. Keep both importable from
  `supervisor.ts`.
- **License boundary unchanged** — pure process supervision; AdGuard is still
  reached only over its REST API. No GPL linkage, no image change, no new
  dependency.
- **`#stopping` stays a separate latch.** It encodes *intent to stop*, which is
  orthogonal to the observed lifecycle state (it gates exit→restart-vs-stopped
  and suppresses a post-fetch spawn). Folding it into the state enum would be a
  semantic change with behaviour risk, so it is left as-is (documented).

## Design

### New file: `transport/adguard/backoff.ts`

```ts
export interface RestartBackoffOptions {
  maxRestarts: number;   // cap on consecutive restarts
  stableMs: number;      // uptime after which the counter resets
  baseMs: number;        // base delay (doubles per attempt)
  maxMs: number;         // delay ceiling
}

export class RestartBackoff {
  get count(): number;                 // consecutive restarts so far (status.restarts)
  markStarted(nowMs: number): void;    // record a spawn time (for stable reset)
  /**
   * Call after an *unexpected* exit. Applies the stable-run reset, then either
   * returns the next backoff delay (ms) and bumps the count, or `null` when the
   * restart cap is exceeded (caller -> `failed`).
   */
  nextDelayMs(nowMs: number): number | null;
}
```

Encapsulates exactly today's arithmetic:
- stable reset: `if (startedAt !== null && now - startedAt >= stableMs) count = 0`
- cap: `if (count >= maxRestarts) return null`
- else `count += 1; return min(baseMs * 2 ** (count - 1), maxMs)`

### New file: `transport/adguard/lifecycle.ts`

- Move the `AdGuardManagedState` union here (with its doc comment).
- `STATE_TRANSITIONS: Readonly<Record<AdGuardManagedState, readonly AdGuardManagedState[]>>`
  declaring the reachable next-states (derived from the actual code paths:
  idle->fetching/stopped; fetching->starting/failed/stopped;
  starting->running/failed/stopped; running->starting/failed/stopped;
  failed->fetching/stopped; stopped->fetching).
- `isValidTransition(from, to): boolean` — pure, directly unit-tested.
- `LifecycleMachine` — holds the current state; `transition(to, onInvalid?)`
  updates the state and invokes `onInvalid(from, to)` (advisory) when the
  transition is not in the table. Never throws.

`supervisor.ts` re-exports the type: `export { type AdGuardManagedState } from "./lifecycle.js";`
so `service.ts` / `index.ts` imports are unaffected. `AdGuardManagedStatus`
stays defined in `supervisor.ts`.

### Refactor `supervisor.ts`

- Replace `#restarts` + inline backoff math with a `RestartBackoff` instance;
  `status.restarts` reads `#backoff.count`. `markStarted` is called in
  `#spawnChild`; `nextDelayMs` in `#onExit`.
- Replace the state field held in `#status.state` with a `LifecycleMachine`
  read by `#settle`; `#settle` asks the machine to transition and passes an
  `onInvalid` callback that logs a `warn` (so a mis-transition is a visible
  signal, not a crash).
- `#settle` still writes the immutable `AdGuardManagedStatus` snapshot exactly
  as today (same fields, same `checkedAt`/detail/logging semantics).

## Tests

- Keep `supervisor.test.ts` unchanged — the primary behaviour guard.
- Add `tests/transport/adguard/backoff.test.ts`: base/doubling/ceiling delays,
  cap -> `null`, stable-run reset, `count` progression, `markStarted`.
- Add `tests/transport/adguard/lifecycle.test.ts`: `isValidTransition` truth
  table (each declared edge true; representative invalid edges false), and the
  `LifecycleMachine` advisory-`onInvalid` callback + state tracking.

## Quality gate

From `server/`: `npm run format` -> `npm run lint:fix` -> `npm run typecheck` ->
`npm test` (coverage gate 80%). All green before commit.

## Phases

1. `RestartBackoff` + its tests; wire into `supervisor.ts`; gate green.
2. `LifecycleMachine` + transition table + its tests; wire into `supervisor.ts`;
   gate green. (Push opens the draft PR after phase 1; phase 2 updates it.)
