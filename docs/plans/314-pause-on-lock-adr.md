# Plan — #314: ADR for the pause-on-lock model & authority

Root sub-issue of the pause-on-lock epic (**#313**). Roadmap:
`docs/roadmap.md` → Phase 8b (with one Phase-4 Timekpr piece and one Phase-9
UI piece). This is a **decision/design** deliverable — an ADR that must land
**before** any of the sibling code sub-issues (#315–#320), because the forks
it settles shape the schema, the wire protocol, and which component owns the
"paused" authority.

## Goal

Commit `docs/adr/0015-pause-on-lock.md` recording, with rationale, a decision
for each of the six forks in #314, then cross-reference the roadmap and
`client-notifications.md`, and annotate the sibling sub-issue bodies so the
downstream PRs build against the chosen model.

ADR number: **0015** — 0014 is claimed by the in-flight ADR PR #431 (#345), so
we skip it to avoid a merge collision (the repo hand-numbers ADRs; there is
already a `0007` duplicate we do not want to repeat).

## The six decisions (with the direction this ADR takes)

1. **Overall-clock authority → Timekpr-native.** The overall daily/weekly/
   monthly clock is Timekpr's at logind level (ADR 0010; epic #313). Realise
   "don't burn the overall budget while locked/idle" through Timekpr's own
   inactive-tracking setting pushed via `timekpra`, **not** a server clock that
   duplicates Timekpr's. The server pause-ledger is kept for *observability*
   and for the per-activity path, not as the overall-clock authority. Accept
   that overall-clock pause immediacy is bounded by Timekpr's idle detection;
   the deliberate-lock immediacy is delivered on the per-activity path and the
   UX (frozen countdown).

2. **Per-activity authority → authoritative server-side exclusion.** The pause
   ledger records explicit `[lockedAt, unlockedAt]` spans and `usage.ts` /
   `normalise.ts` exclude them from per-activity consumption — deterministic and
   immediate, not waiting for AFK's ~180 s idle timeout. Existing AFK clipping
   stays as **defense-in-depth** that bounds over-credit if the explicit signal
   is ever lost. (Matches sub-issue #317's own title.)

3. **Signal direction & shape → new client→server frames.** `session.locked` /
   `session.unlocked`, carrying `userId`, `at` (ISO-8601), the local Linux
   session id (multi-session boxes), and a `lockId`. Additive per ADR 0007
   (a new frame type gated by a `pause_on_lock` **capability** in the `hello`
   handshake — no `eventProtocol` bump). First non-handshake client→server
   frame, which `client-notifications.md` already anticipated ("liveness pings
   and acknowledgements").

4. **Reconciliation & safety bounds.** Idempotent open/close keyed by
   `(user, client, session, lockedAt)`. Missing unlock (bridge drop, crash,
   sleep) closed out by: AFK + Timekpr idle as the bound; an optional
   `max_pause_minutes` auto-close; and reconcile-on-reconnect. Never credit a
   negative or unbounded span.

5. **Interaction with the rest of the system.** While paused: suspend/cancel
   enforcement grace timers (coordinate with #292), freeze the 15/5/1-min
   warning cadence (#103), suppress parent low-time push (#65). A grant arriving
   mid-pause is additive and does not auto-resume. Must coexist with the
   *involuntary* `locked_out` marker (#107/#108) — voluntary pause is its
   inverse and must not clear or be confused with it.

6. **Policy knob.** Per-user (and per-policy default) `pause_on_lock` boolean,
   **default on** (it is the intended one-tap "bank my time" lever and is
   observational-only, under the tamper ceiling), plus the optional
   `max_pause_minutes` safety bound from (4). Lives on the policy and is pushed
   with the rest of policy, like the existing notification/grace knobs.

## Steps

1. Ground the decisions in the actual code (AFK clip in
   `transport/activitywatch/normalise.ts`, rollups in `policy/usage.ts`, the
   event frames in `events/`, grace timers in `enforcement/force-close*.ts`,
   `timekpra` command coverage in `transport/timekpr/commands.ts`, policy knobs
   in `policy/schema.ts` + `policy/notification.ts`).
2. Write `docs/adr/0015-pause-on-lock.md` in the house ADR format
   (Status / Phase / Issue → Context → Decision (per fork) → Consequences →
   Alternatives).
3. Cross-reference: add the ADR to `docs/roadmap.md` (Phase 8b) and to
   `docs/client-notifications.md`.
4. Annotate sub-issue bodies #315–#320 with the chosen model.

## Non-goals

No code. No schema migration, no protocol module, no detector — those are the
sibling sub-issues this ADR unblocks. License boundary and tamper ceiling are
unchanged and restated in the ADR.
