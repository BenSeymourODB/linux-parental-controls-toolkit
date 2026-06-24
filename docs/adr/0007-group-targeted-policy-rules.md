# ADR 0007 — Group-targeted policy rules: separate tables

- **Status:** Accepted (2026-06-19)
- **Issue:** [#182](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/182)
  (follow-up to [#124](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/124))
- **Phase:** 2

## Context

[#124](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/124)
introduced the `UserGroup` entity, many-to-many membership, and `/api/user-groups`
CRUD (PR #181) — "set bedtime for all the kids once". The remaining half is
letting policy *rules* target a group and resolving them with per-user override
precedence: a member's own rule beats an inherited group rule.

Today `schedules` and `exceptions` are keyed by a `NOT NULL user_id`. Two ways
to add a group target were weighed (issue #182):

- **A. Relax + discriminate, one table each.** Make `user_id` nullable, add a
  nullable `user_group_id`, and an exactly-one-of CHECK
  (`(user_id IS NULL) != (user_group_id IS NULL)`).
- **B. Separate tables.** Add `group_schedules` / `group_exceptions` that mirror
  the rule shape but are keyed by `user_group_id`, leaving the user-keyed tables
  untouched.

## Decision

**Option B — separate `group_schedules` / `group_exceptions` tables.**

The two tables mirror `schedules` / `exceptions` column-for-column, with
`user_id` replaced by a `user_group_id INTEGER NOT NULL` foreign key to
`user_groups(id)` `ON DELETE CASCADE`, and the same recurrence (ADR 0005) and
`targetCoherence` CHECK constraints. `group_schedules` carries its own
`ordinal` (per-group first-match-wins, ADR 0004), indexed
`(user_group_id, ordinal)`; `group_exceptions` is indexed
`(user_group_id, expires_at)` like its user-keyed twin.

### Why B over A

- **Non-breaking.** The user-keyed tables, their `ScheduleRow`/`ExceptionRow`
  types, the `ScheduleResponse`/`ExceptionResponse` wire contracts, and every
  in-flight consumer (the resolver `resolve.ts`, the admin Users/Schedules
  editors, the push stub) are untouched. Option A would make `user_id` nullable
  on the wire — a breaking change rippling through all of them — and force a
  SQLite table-recreate of the two hottest policy tables for marginal storage
  savings.
- **No logic duplication.** The column "duplication" is just shape; it is **not**
  duplicated behaviour. `schedule-precedence.ts`'s `ScheduleRule` is a
  structural, owner-agnostic interface (ADR 0004 deliberately kept ownership out
  of it), so a `group_schedules` row and a `schedules` row both satisfy it and
  flow through the *one* precedence + resolution path. The resolver never learns
  there are two tables.
- **Isolated fan-out.** A group-rule mutation must push to every member's
  clients; keeping it on dedicated group routes contains that fan-out instead of
  branching the user-rule routes on a nullable column.

The cost — two tables sharing a shape, and group rules being authored on
dedicated endpoints (`/api/user-groups/:groupId/schedules`) rather than the
existing `/schedules` endpoint growing a group target — is accepted. It is the
natural, non-breaking consequence of the storage choice and is functionally
equivalent for the editor (pick a user target → `/schedules`; pick a group
target → the group endpoint).

## Resolution and precedence

A user's effective schedule rule list is produced by
`policy/group-resolution.ts` → `gatherUserScheduleRules(db, userId)`:

1. the user's **own** schedules, in evaluation order (ascending `ordinal`, then
   `id`) — they win;
2. then, for each group the user belongs to (ascending group `id`, a stable
   deterministic order across a user's multiple groups), that group's schedules
   in evaluation order;
3. concatenated **user-first** and **re-sequenced** to dense `0..n-1` ordinals
   over the merged list.

Re-sequencing matters because `byOrdinal` (ADR 0004) breaks ordinal ties by
`id`, and ids collide across the two autoincrement tables; assigning a fresh
global ordinal makes the merge order authoritative and the `id` tiebreak inert.
The result feeds `effectivePolicy` / `resolveEffectiveRule` unchanged, so
group rules compose with the existing recurrence + first-match-wins engine
rather than a second implementation — exactly the "build against the real
resolver" sequencing the roadmap intends (#182 is held until #176/#143 land for
this reason).

Each returned rule is tagged with its `source`
(`{ kind: "user" }` | `{ kind: "group"; groupId }`) so the future
inherited-vs-local editor (#124, UI deferred behind #53/#63) can show which
rules are local and which are inherited, and from which group.

`GET /api/users/:userId/effective` (#143) loads schedules via this helper, so
group-inherited rules take effect in the single resolver every surface reads.

## Exceptions

`group_exceptions` get full storage + repository CRUD + API, mirroring the
user-keyed exceptions. They are **not** given a resolution helper here:
exception composition into the effective policy is #142 and `resolve.ts` does
not consume exceptions yet (neither user-keyed nor group). Authoring now,
resolving in #142, matches how user exceptions already work.

## Consequences

- Group-level schedules/exceptions are authored via
  `/api/user-groups/:groupId/{schedules,exceptions}` and inherited by every
  member, with the member's own rules taking precedence.
- A group-rule mutation fans the push stub out to every member's linked clients
  (reusing the per-user `userPushCommands`); no new push command shape.
- `gatherUserScheduleRules` is the one place user-over-group precedence is
  applied; group budgets (#134) and date-specific overrides (#142) compose on
  top of the same model without new tables for the *rule* axis.
- The inherited-vs-local **editor UI** stays in #124, blocked on the admin
  shell (#53/#63).

## Alternatives not chosen

- **Option A (nullable `user_id` + `user_group_id` + exactly-one-of CHECK).**
  Rejected for the breaking wire change, the ripple through every in-flight
  schedule/exception consumer, and the table-recreate of the two hottest tables
  — none of which the marginal storage saving justifies.
