# ADR 0015 — Pause-on-lock: model & authority

- **Status:** Accepted (2026-08-24) — decision only; implementation lands across
  the sibling sub-issues of the epic.
- **Issue:** [#314](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/314)
  (epic [#313](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/313))
- **Phase:** 8b (client agent + event stream), with one Phase-4 Timekpr piece
  ([#318](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/318))
  and one Phase-9 UI piece
  ([#320](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/320)).

## Context

The pause-on-lock epic ([#313](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/313))
gives the supervised user a **one-step "I'm taking a break" lever**: locking the
screen pauses their screen-time budget, unlocking resumes it. Kids want every
granted minute, and a deliberate lock is the discoverable, no-UI way to stop the
clock.

This has to be settled **before** any of the sibling sub-issues are coded,
because the forks below shape three different surfaces at once — the policy
schema, the event-stream wire protocol, and *which component owns the "paused"
authority*. Getting the authority question wrong means either two components
fighting over the same clock, or a signal that arrives too late to matter.

### What is already true (and why pause-on-lock is not just AFK)

Per-activity budgets are **already AFK-aware**. The ActivityWatch normaliser
clips credited time to `aw-watcher-afk`'s `not-afk` intervals
(`server/src/transport/activitywatch/normalise.ts` — `normaliseWindowEvents`,
with `notAfkIntervals` / `intersectWithAllowed`), and the rollups only sum the
stored, already-clipped samples (`server/src/policy/usage.ts` —
`overlapSeconds`, `usageByActivityInWindow`). Idle/away time is therefore
already not charged on the per-activity path.

So the genuinely *new* value of pause-on-lock is twofold, exactly as the epic
frames it:

1. **Immediacy.** AFK detection only trips after `aw-watcher-afk`'s idle timeout
   (~180 s of no input). A deliberate lock should pause the clock **now**.
2. **The overall clock.** AFK clipping governs the per-activity AW path only. The
   **overall daily/weekly/monthly screen-time budget is Timekpr-nExT's** at the
   logind level (see [ADR 0010](0010-per-activity-enforcement-mechanism.md) —
   "overall session limits remain Timekpr-enforced locally"), and it keeps
   counting an unlocked-but-idle session until Timekpr's own idle handling
   trips. Pausing the overall clock is a *different mechanism* from the AW clip.

### What the code does **not** have yet (constraints on the decision)

A survey of the relevant modules turned up three gaps the decisions below must
respect rather than assume away:

- **No lock signal source exists in the AW pipeline.** Only two watchers feed
  the normaliser — `currentwindow` and `afkstatus`
  (`server/src/transport/activitywatch/schemas.ts`). There is no "screen
  locked" event today; the lock has to arrive by a new path.
- **The event stream has no post-handshake client→server application frame
  path.** `server/src/events/stream.ts` reads exactly one inbound frame — the
  `hello` (`socket.once("message", …)`) — negotiates it via
  `server/src/events/protocol.ts`, and after `accept` processes only WebSocket
  `pong` heartbeats. Server→client frames are a zod discriminated union on
  `type` (`server/src/events/taxonomy.ts`: `grant.applied`, `policy.changed`,
  `enforce.force_close`, `enforce.session_lock`, `lockout.cleared`), each gated
  by an exhaustive `capabilityForEvent` switch (`server/src/events/
  capabilities.ts`, advertised set `CLIENT_CAPABILITIES`). A client-reported
  lock is a **new frame in a new direction**.
- **The force-close trigger has no cancel handle.** `ForceCloseTrigger.enforce`
  (`server/src/enforcement/force-close.ts`) schedules a kill after
  `graceSeconds` and de-dups via a `#pending` set that is cleared *only when the
  timer fires*; `schedule` returns `void`, so a pending grace force-close cannot
  currently be aborted or suspended. (This same gap is already noted by
  [#292](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/292)
  Part 2, which needs a cancel handle to abort a force-close when a grant tops
  the budget back up.)
- **No Timekpr "pause the clock" lever is wrapped.** `server/src/transport/
  timekpr/commands.ts` wraps `--setalloweddays`, `--setallowedhours`,
  `--settimelimits`/`week`/`month`, `--settimeleft (+|-|=)` (the #257 same-day
  adjustment), the `--setplaytime*` family, and `--userinfo`. There is **no**
  `--settrackinactive` / idle / pause / `--kill-session` wrapper. The closest
  existing overall-clock lever is the ephemeral `--settimeleft`.

### Scope boundaries carried from the epic and `CLAUDE.md`

- **Detection is observational only** — logind / screensaver session signals via
  the desktop's own tooling (D-Bus / `gdbus`) as subprocesses in
  `pct-client-agent`. **No anti-tamper hooks, no kernel/eBPF, no `/etc`
  lockdown.** A child who locks to "bank" time is simply not using the device —
  the intended outcome, under the documented tamper-resistance ceiling
  (`CLAUDE.md` → "Tamper resistance is deliberately bounded").
- **License boundary unchanged** — Timekpr driven only as a `timekpra`
  subprocess over SSH; ActivityWatch only over REST; no GPL linkage; no new
  binaries in the image.

## Decisions

### 1. Overall-clock authority → Timekpr-native; the server never runs a second overall clock

The overall budget is Timekpr's at logind level, and this ADR keeps it that way.
Pausing it on lock is realised through **Timekpr-nExT's own inactivity
handling** — a new thin `--settrackinactive <user> false` command builder
(the work of [#318](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/318),
alongside the existing wrappers in `server/src/transport/timekpr/commands.ts`),
pushed for users who have `pause_on_lock` enabled — so logind-level idle/locked
time stops accruing against the overall budget at the source that owns the
clock.

The explicit `session.locked` signal (decision 3) is deliberately **not** used
to drive the overall Timekpr clock per-event:

- There is no clean per-event Timekpr "pause now / resume now" primitive to
  drive (see Context); the only per-event overall lever is `--settimeleft`,
  which is a *refund*, not a freeze.
- A server-maintained overall clock that subtracts paused spans and re-pushes
  the residual would **duplicate and fight** the authority
  [ADR 0010](0010-per-activity-enforcement-mechanism.md) assigns to Timekpr, and
  would have to reconcile with grants, the resolver, and Timekpr's own count on
  every pause — more surface, more ways to disagree, no capability gain.

**Consequence, stated honestly:** the overall-clock pause is only as immediate
and as lock-specific as Timekpr's inactivity detection allows (a locked session
that logind still reports as *active* may keep counting until Timekpr's idle
timeout trips). That granularity is accepted. The product's *immediacy* promise
is delivered where it is both cheap and exact — on the per-activity path
(decision 2) and in the UX freeze (decision 5) — not by inventing a rival
overall clock.

**Recorded fallback (not adopted now):** if a deliberate-lock, explicit-signal-
driven overall pause later proves necessary, the natural backstop is a
`--settimeleft (+)` refund of the paused span on resume — the same additive
nudge grants already make to the overall budget, bounded and idempotent by the
pause ledger (decision 4). Adopting it would require updating this ADR and
defining how the refund reconciles with Timekpr's own count and with grants,
rather than silently running both.

### 2. Per-activity authority → authoritative server-side exclusion via the pause ledger, with AFK as defense-in-depth

The server records each explicit lock as a **pause interval**
`[lockedAt, unlockedAt]` in a pause ledger (the work of
[#317](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/317)),
and per-activity consumption **excludes** the overlap of those intervals —
deterministically and immediately, without waiting for AFK's ~180 s timeout.

- **Authority:** the pause ledger is authoritative for "was this span a
  deliberate break?"; paused spans are **never charged** to per-activity /
  per-group budgets.
- **Seam (preference, left to #317):** exclusion is best applied at the **same
  clip point the normaliser already uses for AFK** — pass the closed, known
  pause spans in as additional *deny* intervals subtracted from the not-afk
  allow-set, so stored `usage_samples` are already pause-clipped and
  `server/src/policy/usage.ts` stays a pure sum with no new exclusion concept.
  Where a pause is still open at telemetry-pull time, clip up to "now" and let
  the next pull finish the span once it closes. The alternative — subtracting
  paused overlap in the rollup readers at query time — is available if
  late-closing spans make normalise-time clipping lossy; #317 picks the seam,
  this ADR fixes the *semantics*.
- **Defense-in-depth:** the existing AFK clip stays exactly as-is. If the
  explicit lock/unlock signal is ever lost, AFK still prevents over-charging the
  idle span — the pause ledger sharpens immediacy; it does not replace the AFK
  safety net.

### 3. Signal direction & shape → new capability-gated client→server frames

Define **`session.locked` / `session.unlocked`** as the client→server frames
(matching sub-issue
[#316](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/316)),
carrying:

- `userId` — the supervised `User` the lock belongs to.
- `at` — ISO-8601 UTC instant of the lock/unlock, per the project's
  UTC-internal convention ([ADR 0001](0001-budget-timezone.md)).
- `sessionId` — the local logind session id, so a multi-session box (fast user
  switching, multiple seats) can attribute and pair lock/unlock correctly.
- `lockId` — a client-generated id stable across the matching lock→unlock pair,
  the idempotency key for decision 4.

These are the **first post-handshake client→server application frames** on the
stream — a mild, deliberate expansion that `docs/client-notifications.md`
already anticipated ("WebSocket is chosen over SSE because the channel must also
carry client→server liveness pings and acknowledgements"). Concretely this
means:

- A new inbound zod schema (a small discriminated union, **separate** from the
  server→client `serverEventSchema`) in `server/src/events/`, with the inferred
  type shared with the bridge — the established DTO pattern.
- New inbound handling in `server/src/events/stream.ts`: after `accept`, read
  these frame types (`socket.on`, not just the one-shot `hello`), validating
  each and rejecting unknown/malformed inbound frames without tearing down the
  stream.
- A new capability string (e.g. **`pause_on_lock`**) added to
  `CLIENT_CAPABILITIES` (`server/src/events/capabilities.ts`). Advertising it in
  the `hello` tells the server both that the client *will report* lock/unlock
  and that pause semantics apply to it.

Per [ADR 0007 §4](0007-event-stream-version-compatibility.md) this is
**additive**: a new capability-gated frame is not a breaking change and **does
not bump `eventProtocol`**. The "upgrade the server first" rule
([ADR 0007 §3](0007-event-stream-version-compatibility.md)) guarantees the
server understands the inbound frame before any client is capable of sending it;
an un-upgraded client simply never advertises the capability and never sends it.

> **Naming note.** These inbound `session.*` frames (voluntary, client→server)
> are distinct from the existing **outbound** `enforce.session_lock`
> (involuntary budget-exhaustion lock, server→client). Different direction,
> different namespace, different meaning — keep them from being conflated.

### 4. Reconciliation & safety bounds

A pause interval is opened by `session.locked` and closed by the matching
`session.unlocked`, **idempotent** on `(userId, clientId, sessionId, lockId)`
— a duplicate `session.locked` (reconnect replay) does not open a second
interval, and an `unlocked` with no open match is a no-op.

When the `unlocked` never arrives (bridge disconnect mid-pause, agent crash,
device sleep), the open interval is closed out by the first of:

- **`max_pause_minutes`** (decision 6) — the server auto-closes an open interval
  at `lockedAt + max_pause_minutes`.
- **Bridge disconnect** — the stream's existing disconnect handling finalises
  the client's open pause intervals (closed at last-seen), since a dropped
  bridge means the lock can no longer be trusted to still hold.
- **Reconcile on reconnect** — a fresh `hello` with no corresponding open lock
  closes any stale open interval at last-seen.

Bounds that hold by construction: an interval is never negative and never
credited beyond `max_pause_minutes`. Because decision 1 keeps the overall clock
on Timekpr's native handling and decision 2 keeps AFK as the per-activity
backstop, a lost unlock degrades to "AFK + Timekpr idle bound the over-credit",
never to an unbounded free pause.

### 5. Interaction with the rest of the system

While a user is paused:

- **Enforcement grace timers** (`server/src/enforcement/force-close.ts`) — a
  voluntary lock during an active grace countdown **suspends** the countdown and
  **resumes the remaining grace on unlock**, so an app is never force-closed
  while the user is deliberately away mid-save. The trigger has no cancel/suspend
  handle today; this reuses the **same cancel handle
  [#292](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/292)
  Part 2 must add** for grant top-ups — the two features converge on one
  mechanism rather than each bolting on its own. (A lock does *not* cancel the
  force-close outright: the budget is still exhausted, so on resume the remaining
  grace runs and, if still over quota, the close fires.)
- **Warning cadence** (the 15/5/1-minute rules,
  `DEFAULT_WARNING_MINUTES = [15,10,5,4,3,2,1]` in
  `server/src/policy/notification.ts`) — the cadence is computed and emitted
  **client-side** by `pct-client-agent`
  ([#319](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/319)),
  which freezes it locally while paused. Server-side there is nothing to freeze:
  because paused time is not charged (decision 2), remaining time stops
  decreasing, so the agent's locally-computed countdown naturally holds.
- **Parent low-time push** (
  [#65](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/65))
  — not built yet (doc-only, a Phase-9 `/app` feature). Forward note: when built
  it must treat a paused budget as *not* "running low" — a break is not an
  imminent time-out and must not fire a "5 minutes left" push at the parent.
- **Grants arriving mid-pause** behave normally: a grant is an additive
  adjustment (`CLAUDE.md` → grants) and is independent of pause. It does **not**
  auto-resume the session; it simply means more remaining time once the user
  unlocks.
- **Coexistence with the involuntary lockout marker** (
  [#107](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/107)
  /
  [#108](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/108))
  — voluntary pause is the *inverse* of `locked_out`. A pause must **never** set
  or clear the `locked_out` marker. If a user is already locked out (overall
  budget exhausted), a voluntary lock is a budget no-op (nothing left to burn),
  and unlock/`lockout.cleared` semantics are unchanged.

### 6. Policy knob

A per-user **`pause_on_lock` boolean**, **default `true`**, lives on the
per-user policy-knobs table `notificationPolicies`
(`server/src/policy/schema.ts`), beside `enabled` / `grace_seconds` /
`sound_profile` — mirroring the `enabled` master-switch idiom
(`integer(..., { mode: "boolean" }).notNull().default(...)`), with its default
single-sourced in `server/src/policy/notification.ts` and a DTO in
`server/src/api/policy/`. Default-on because it is the intended one-tap "bank my
time" lever, it is observational-only, and it sits under the tamper ceiling —
there is no reason to make a household opt in to letting a child *stop* using
the device.

A companion **`max_pause_minutes`** (nullable integer; `null` = bounded only by
the daily window + the Timekpr/AFK fallbacks of decisions 1–2 and 4) gives the
admin an explicit safety cap, with a range `CHECK` when set, defaults/bounds in
`notification.ts` like `grace_seconds`. A per-policy default for both knobs is
provided so the admin sets them once rather than per user.

## Consequences

- **One overall clock, one per-activity authority.** Timekpr keeps the overall
  budget (decision 1, consistent with ADR 0010); the server pause ledger is
  authoritative for per-activity exclusion and for observability (decision 2).
  Nothing runs a second copy of a clock another component owns.
- **The scarce N-1 window is untouched.** Pause-on-lock ships entirely on an
  additive capability and new capability-gated frames (decision 3), so it costs
  **zero** `eventProtocol` bumps and does not consume the two-major
  compatibility window ([ADR 0007](0007-event-stream-version-compatibility.md)).
- **A shared cancel handle for the force-close trigger.** Decisions 5 and
  [#292](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/292)
  now have a single, agreed reason to add a cancel/suspend handle to
  `ForceCloseTrigger` — it should be built once, to serve both.
- **Safe failure direction.** Every unreconciled edge (lost unlock, bridge drop,
  sleep) degrades to *less* pausing, never to an unbounded free pass: Timekpr
  idle bounds the overall clock, AFK bounds the per-activity path, and
  `max_pause_minutes` bounds the ledger.
- **New per-user schema + a new inbound frame direction.** The cost is a
  `notificationPolicies` migration (two columns) and the stream's first
  post-handshake client→server handler — both small, both isolated to the sibling
  sub-issues this ADR unblocks.
- **Sibling sub-issues are now unambiguous.** #315 (detector) emits `gdbus`
  logind/screensaver signals; #316 wires the two `session.*` frames + capability;
  #317 builds the ledger and the per-activity exclusion seam; #318 wraps
  `--settrackinactive`; #319 freezes the client countdown/cadence; #320 surfaces
  "paused / on a break".

## Alternatives considered

- **Server-authoritative overall clock (pause ledger subtracts paused spans,
  re-push the residual to Timekpr).** Rejected: duplicates the logind-level clock
  Timekpr owns (against ADR 0010), and forces reconciliation with Timekpr's own
  count and with grants on every pause — maximal surface for the two authorities
  to disagree, for no capability the Timekpr-native path lacks.
- **`--settimeleft (+)` refund of the paused span on resume, as the *primary*
  overall mechanism.** Attractive because it is driven by the explicit signal and
  uses an already-wrapped lever — but it makes the counter visibly burn down while
  locked and jump back on unlock, and it needs careful idempotency to avoid
  double-refunds. Kept as the **recorded fallback** in decision 1 rather than the
  default, to preserve a single overall-clock authority.
- **Treat the lock purely as an AFK accelerant (no ledger; feed a synthetic
  `not-afk`→`afk` edge into the normaliser).** Rejected as the *authority*: it
  buys immediacy but leaves the exclusion implicit and un-auditable, gives the
  admin nothing to surface as "paused", and cannot express `max_pause_minutes`.
  The AFK clip is kept as defense-in-depth (decision 2), not as the mechanism.
- **A server→client `budget.paused` acknowledgement event.** Considered for
  symmetry, but the pause is a *client-observed fact*, not a server decision the
  client must obey. The "paused" UX (decision 5, #320) reads ledger state through
  the existing `/api/*` surfaces; a dedicated outbound frame would be an
  additional gated event type for no behaviour the UI can't already poll. Left
  out; can be added additively later if a live push proves worthwhile.
- **A boolean on the `users` table instead of `notificationPolicies`.** Rejected:
  the `users` table is deliberately minimal (id, displayName, tz), and behavioural
  toggles already live on the per-user `notificationPolicies` row beside
  `grace_seconds` — the consistent home.
