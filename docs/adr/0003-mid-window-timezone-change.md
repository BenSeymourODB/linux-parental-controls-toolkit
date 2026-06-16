# ADR 0003 — Behaviour when a user changes timezone mid-window

- **Status:** Accepted (2026-06-16)
- **Issue:** [#56](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/56)
- **Phase:** 2 (extends [ADR 0001](0001-budget-timezone.md))
- **Supersedes:** the "Explicitly deferred" clause of
  [ADR 0001](0001-budget-timezone.md)

## Context

[ADR 0001](0001-budget-timezone.md) settled the timezone strategy: store
everything in UTC, and compute each daily/weekly/monthly budget window in
the user's **effective timezone** (`User.tz ?? PCT_DEFAULT_TZ`). It
explicitly **deferred** one case: a user whose effective timezone changes
**partway through a window** — the family moves house, or a child travels on
vacation mid-day.

That case is awkward because the start-of-window instant is derived from a
local calendar boundary. If the effective timezone changes while a window is
open, naively recomputing "the current window" in the new zone moves the
boundary under the user:

- **"How much is left today?"** depends on which timezone defines *today*.
- Usage already credited against the open window must not be double-counted
  or wiped when the boundary moves.
- A `Grant` with an end-of-day `expires_at` (a UTC instant computed from the
  old local end-of-day) may no longer line up with the new local day.

ADR 0001 noted that, for the target single-household deployment, the
deferred behaviour was acceptable, and `architecture.md` already described
the intended rule informally ("changing `tz` takes effect from the next
window boundary"). This ADR makes that rule explicit and load-bearing.

## Decision

**Pin the in-flight window to the timezone in effect when it opened. A
timezone change applies only from the next window boundary.**

Concretely, given the effective timezone changed from `previousTz` to
`toTz` at UTC instant `changedAt`:

1. The window that was open at `changedAt` — computed in `previousTz` —
   keeps the exact `[start, end)` UTC boundaries it already had. It is not
   recomputed, lengthened, shortened, or split.
2. Usage credited against that window stays credited; nothing is reconciled
   or prorated.
3. From that window's original `end` onward, subsequent windows are computed
   in the new effective timezone (`toTz`), per ADR 0001.

The first window under the new zone therefore begins exactly at the pinned
window's `end` (no gap, no overlap); only the windows *after* the boundary
reflect the move. A westward move makes later local days start "earlier" in
UTC and an eastward move "later", but the in-flight day a user is currently
spending against never shifts beneath them.

This is the first of the three options the issue weighed; the other two
(recompute-and-prorate the open window, or an explicit admin "travel mode")
were rejected — see below.

## Consequences

- **Shared helper.** The rule lives in one pure module,
  `server/src/policy/budget-window.ts`, so every rollup that asks "which
  window is active and where are its edges?" — burndown views, enforcement
  checks, grant-expiry math — applies it identically. `windowContaining()`
  computes a window in a given zone; `effectiveWindow(window, now,
  effectiveTz, change?)` layers the pin rule on top.
- **What callers must supply.** Honouring the pin requires knowing the zone
  in force when the open window started and when the change happened. A
  caller that has not recorded a timezone change passes no `change` and gets
  the straightforward "current window in the effective zone" result;
  behaviour only differs for a window that spans a recorded change.
- **Determinism.** The pin makes the in-flight day fully determined by
  `(window kind, changedAt, previousTz)` — no dependence on *when* the
  question is asked relative to the change, which is what made the deferred
  behaviour "unspecified".
- **Grants.** `Grant.expires_at` stays a UTC instant (ADR 0001). A grant
  pinned to the old local end-of-day keeps that instant; it is not
  re-derived when the zone changes, consistent with pinning the window.
- **Single-household scope.** This is deliberately the simplest correct
  rule. It does not attempt to be "fair" across a move (a one-off longer or
  shorter day at the boundary is possible); that is acceptable for the
  household context and avoids proration bugs.

## Alternatives not chosen

- **Recompute the open window in the new zone and prorate already-credited
  usage.** Rejected: proration against a moving boundary is the exact
  double-counting/credit-loss hazard the issue flags, for a case that
  happens rarely in a single household. Not worth the complexity or the bug
  surface.
- **An explicit admin "travel mode" that picks a behaviour per change.**
  Rejected as premature UI/scope for Phase 2. If a real need appears, it can
  layer on top of this default later without changing the storage rule.
