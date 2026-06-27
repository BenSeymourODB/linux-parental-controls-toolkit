# ADR 0010 — Per-activity time enforcement: custom usage-poll, not Timekpr PlayTime

- **Status:** Accepted (2026-06-27)
- **Phase:** 8 (per-activity enforcement); reconciles a Phase 4 (#83) transport
  capability that was built but intentionally left unwired
- **Supersedes the implicit assumption** in
  [`docs/proposed-tech-stack.md`](../proposed-tech-stack.md) that Timekpr-nExT
  PlayTime would be "the primary mechanism for per-application time quotas".

## Context

The toolkit needs **per-activity time quotas** — independent daily budgets for
distinct applications or activity groups (e.g. "1 h of Minecraft *and* a
separate 30 min of YouTube"). The policy model already represents this: the
`budgets` table carries `scope ∈ {overall, activity, group}` with a polymorphic
`target_id`, so a single user can hold *many* independent per-activity /
per-group budgets at once (see `server/src/policy/schema.ts`,
[ADR 0008](0008-group-targeted-budgets.md)).

Two mechanisms can enforce that, and the project carried both for a while:

1. **Timekpr-nExT PlayTime.** Timekpr's feature for limiting "activities"
   (processes matched by name/command-line masks). The `timekpra` CLI wrappers
   for it shipped in **#83** (Phase 4): `setplaytimeenabled`,
   `setplaytimelimitoverride`, `setplaytimeunaccountedintervalsenabled`,
   `setplaytimealloweddays`, `setplaytimelimits`, `setplaytimeactivities`
   (`server/src/transport/timekpr/{commands,client}.ts`, with unit tests).

2. **A custom usage-poll → decide → force-close path.** The server pulls
   ActivityWatch telemetry (Phase 5), rolls it into `UsageSample`s, and the
   decision logic (**#98**, with cool-down) compares per-activity consumption
   against the *effective* budget for the user's current window. When a quota is
   exhausted it emits `enforce.force_close` over the event stream after the
   grace period (**#99**); the per-user agent kills the activity, with an SSH
   ad-hoc `pkill` fallback. **#98 and #99 are built and shipped.**

The open question was whether PlayTime could *replace* the custom path — it
looked like duplicated effort — so we checked what PlayTime can actually express.

## The deciding fact: PlayTime is a single shared budget

Per the upstream Timekpr-nExT documentation
(<https://mjasnik.gitlab.io/timekpr-next/>, "PlayTime configuration"):

> "PlayTime limits are similar to standard time limits and allowances,
> configuration is the same, but these only apply to PlayTime."

PlayTime defines **one** time allowance (per-weekday seconds, plus allowed
days), and a **list of activities** (process masks). All listed activities draw
down the **same** budget; when it is exhausted, *every* matched process is
terminated. There is no per-activity limit in the model — `setplaytimelimits`
takes a per-*weekday* vector, not a per-*activity* one, and
`setplaytimeactivities` is just the mask set. Confirmed against the `timekpra`
CLI grammar already documented in `server/src/transport/timekpr/commands.ts`:
there is also **no `setplaytimeallowedhours`** — PlayTime has allowed *days* and
a budget, but no intra-day time-of-day windows.

So PlayTime can model exactly **one** shared sub-budget across a single set of
apps per user. It **cannot** model the multiple independent per-activity budgets
the policy schema already supports — which is the actual product requirement.

## Decision

**Per-activity and per-group time enforcement is owned solely by the custom
usage-poll → decision → force-close path (#98/#99). Timekpr PlayTime is not
wired into the policy push.**

Rationale:

- The custom path is a **superset** of what PlayTime offers for time quotas: it
  enforces N independent per-activity *and* per-group budgets, composes with
  grants and the effective-policy resolver (#143), and handles activities that
  PlayTime's single shared budget cannot separate. The single-group case
  PlayTime *can* do is just a degenerate instance the custom path already covers.
- Adding PlayTime as a *second* partial mechanism would mean reconciling two
  enforcement authorities for the subset of policies PlayTime happens to fit —
  more surface area, more ways for the two to disagree, for no capability gain.
- PlayTime brings no graceful UX (it hard-terminates); the user-facing warning
  cadence and grace period are the agent's job (Phase 8b) regardless.

The `setplaytime*` CLI wrappers shipped under #83 are **retained but
intentionally unused** — they are correct, tested, and cheap to keep, and they
leave the door open to the revisit below without re-deriving the grammar. They
must not be flagged as accidental dead code; tracked for annotation as a
Phase-4 housekeeping follow-up.

## Consequences

- **One enforcement authority for per-activity time.** The enforcement
  responsibilities table in [`docs/architecture.md`](../architecture.md)
  collapses "App-group time → PlayTime" into the custom polling path; PlayTime
  is removed from that table.
- **Offline-enforcement gap (accepted).** PlayTime enforces locally on the
  client even when the server is unreachable; the custom path needs the server
  online (telemetry pull + decision + event/SSH). A supervised user who
  disconnects the network evades *granular per-app* enforcement until the next
  reachable poll. This is acceptable within the project's threat model:
  **overall session limits remain Timekpr-enforced locally** (the daemon counts
  time offline), and the tamper-resistance posture is deliberately bounded — a
  user defeating per-app limits by pulling the network is the "outgrown the
  product" case described in `CLAUDE.md` ("Tamper resistance is deliberately
  bounded"), not a defect to engineer against.
- **Revisit trigger.** If offline-robust per-app enforcement of a *single*
  aggregate app budget later becomes a hard requirement, PlayTime is the natural
  backstop for that one case — the wrappers are already in place. Any such
  revisit must update this ADR first and define how PlayTime's single budget and
  the custom path's per-activity budgets reconcile, rather than silently running
  both.

## Alternatives considered

- **PlayTime as primary, custom as fallback.** Rejected: PlayTime can't express
  the multi-budget requirement, so it could only ever be primary for a narrow
  subset, leaving the custom path to cover everything else anyway — two
  authorities for no gain.
- **PlayTime only, retire the custom path.** Rejected on the same fact: it would
  drop support for multiple simultaneous independent per-activity budgets and for
  activities not cleanly separable by a single shared budget.
