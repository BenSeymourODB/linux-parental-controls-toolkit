# Plan — #274 queue-safe offline "Add time today"

Roadmap: Phase 4 (SSH + `timekpra` transport). Tracks the deferred offline
portion of #257 (online-only lever, merged in PR #272).

## Problem

#257's "Add time today" (`timekpra --settimeleft`) is **online-only**: an
offline-at-request client just gets an `unreachable` result. It was left out of
the offline queue (#84) because the queue is at-least-once with coalescing and
requires **idempotent** executors, and an additive `--settimeleft +N` is not
idempotent (replay double-applies; coalescing drops one).

## Design (idempotent absolute target + deferred-resolve)

- Queue a `timekpr.time-today` action whose executor asserts an **absolute**
  target (`--settimeleft = T`), which is idempotent on replay.
- `=` (setSeconds) is offline-safe: `T = seconds`, resolved at enqueue.
- `+`/`-` (delta) needs the client's current remaining, so it is queued with
  `resolvedTargetSeconds: null` and **deferred-resolved on first reconnect**:
  read `--userinfo` (`TIME_LEFT_DAY`), compute `T = max(0, remaining ± seconds)`,
  **persist `T` back to the row first**, then `--settimeleft = T`. A crash
  between the set and `markDrained` replays the *same* `T` → exactly-once.
- **No silent coalescing drop:** each request uses a **unique** coalesce key
  (`time-today:<userId>:<uuid>`), so two distinct nudges both apply.
- **Rollover expiry:** the action carries the effective-TZ `targetDate`; once
  today (effective TZ) is past it, the executor no-ops and the row drops.

## Phases

### Phase 1 — queue plumbing
- `queue/types.ts`: add optional `id` to `QueuedAction` (so a deferred executor
  can persist resolved state); `queue/drainer.ts` `toAction` sets it.
- `queue/repository.ts`: `updateActionPayload(db, id, payload)`.
- `queue/composite.ts`: `compositeExecutor({ [kind]: ActionExecutor })` that
  dispatches `drainClient`'s single executor slot by `action.kind` (unknown kind
  → non-retriable error). Tests.

### Phase 2 — time-today queued model + deferred executor
- `time-today/queued.ts`: `TIME_TODAY_KIND`, `timeTodayPayloadSchema`,
  `queuedActionForOfflineAdjustment(...)` (unique key; `resolvedTargetSeconds`
  pre-filled for `=`, null for delta), `formatCalendarDate`.
- `time-today/executor.ts`: `createTimeTodayExecutor({ db, buildClient,
  defaultTz, now? })` — rollover expiry, deferred resolve (read→compute→persist
  →set), `=` fast path, missing/garbled `TIME_LEFT_DAY` → non-retriable. Tests
  (idempotent double-drain, clamp at 0, expiry, `=` no-read).

### Phase 3 — wire it in
- `time-today/adjust.ts`: optional `{ defaultTz, now? }` options; on a retriable
  (`unreachable`) push, enqueue the offline action and report a new `queued`
  status (legacy callers without options keep the `unreachable` behaviour).
- `api/policy/dtos.ts`: add `queued` to `clientAdjustmentResultSchema.status`.
- `policy-push/bootstrap.ts`: build the time-today deferred client factory
  (needs `getUserInfo` + `setTimeLeft`), compose `{ policy.push, timekpr.time
  -today }` executors for the drainer, and pass `{ defaultTz, now }` to the
  adjuster.
- Tests for the new `queued` path.

## Deferred (tracked)
- Enqueue-side **audit entry**: the eventual *apply* is audited (runs over the
  `AuditingTransport` via the injected client); a discrete enqueue audit row
  needs audit-recorder plumbing — file/​note if not trivial.
- Live end-to-end round-trip against a real `timekpra` (covered by #157).

## License boundary
Pure TypeScript over Drizzle + the injected `timekpra` client that execs over
the existing SSH subprocess facade. No GPL linkage, no image change.
