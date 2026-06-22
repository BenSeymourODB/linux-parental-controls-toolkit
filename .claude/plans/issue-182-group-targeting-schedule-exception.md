# Issue #182 — Group-targeting on Schedule/Exception + user-over-group resolution

Roadmap: Phase 2. Foundation #181 (`UserGroup` + membership + CRUD) is merged;
the effective-policy resolver #143 (`policy/resolve.ts`, `schedule-precedence.ts`)
is merged, so the blocker is cleared.

## Decision (ADR 0007)

Two storage options were on the table (issue #182):

- **A.** Relax `schedules.user_id` / `exceptions.user_id` to nullable, add a
  nullable `user_group_id`, and an exactly-one-of CHECK. One table, but
  `user_id` becomes nullable on the wire and the change ripples through
  `ScheduleRow`/`ExceptionRow`, `ScheduleResponse`/`ExceptionResponse`, the
  resolver, the push stub, and every in-flight consumer — plus a SQLite
  table-recreate of the two hottest policy tables.
- **B.** Separate `group_schedules` / `group_exceptions` tables. No change to
  the existing user-keyed tables or their wire contracts; additive only.

**Chosen: B (separate tables).** The precedence module's `ScheduleRule`
interface is already owner-agnostic and structural, so a group rule and a user
rule both satisfy it — the column "duplication" does *not* duplicate logic; one
resolver/precedence path serves both. Recorded in
`docs/adr/0007-group-targeted-policy-rules.md`.

## Resolution / precedence

`gatherUserScheduleRules(db, userId)` → a single precedence-ordered
`GatheredScheduleRule[]` that drops straight into `effectivePolicy` /
`resolveEffectiveRule`:

1. the user's **own** schedules (ascending `ordinal`, then `id`) — they win;
2. then, for each group the user belongs to (ascending group `id` for
   determinism), that group's schedules (ascending `ordinal`, then `id`);
3. concatenated user-first and **re-sequenced** to dense `0..n-1` ordinals over
   the merged list, so `byOrdinal` reproduces exactly this order and the
   per-table `id` tiebreak (ids collide across tables) never matters.

Each rule is tagged with its `source` (`{ kind: "user" }` or
`{ kind: "group", groupId }`) for the inherited-vs-local editor (#124, UI
deferred). `GatheredScheduleRule extends ScheduleRule`, so it feeds the resolver
unchanged.

`GET /api/users/:userId/effective` is rewired to load schedules via this helper,
so group rules actually take effect in the one resolver every surface reads —
the strongest end-to-end check that the composition is correct.

Exceptions get group-targeting **storage + CRUD + API** (per the issue), but no
resolution helper: exception resolution composition is #142 and is not consumed
by `resolve.ts` yet (user exceptions aren't either) — adding one now would be
speculative.

## Phases

1. **ADR 0007 + schema + migration + tests.** `group_schedules`,
   `group_exceptions` tables mirroring `schedules`/`exceptions` (minus
   `user_id`, plus `user_group_id` FK → `user_groups` ON DELETE CASCADE; per-
   group `(user_group_id, ordinal)` index for schedules, `(user_group_id,
   expires_at)` for exceptions; same recurrence/coherence CHECKs). Generate the
   timestamp-prefixed migration via `npm run db:generate`. Schema + migration
   tests.
2. **Repository + resolution helper.** CRUD for group schedules/exceptions;
   `policy/group-resolution.ts` with `gatherUserScheduleRules`. Wire
   `effective.ts` to use it. Repository + resolution tests.
3. **API.** DTOs (`createGroupScheduleSchema`, … reusing the shared recurrence
   schema) + nested routes under `/api/user-groups/:groupId/schedules` and
   `/api/user-groups/:groupId/exceptions`; group-rule mutations fan out the push
   stub to every member's clients (reusing `userPushCommands` per member — no new
   command shape). Route tests via `app.inject()`.

## License boundary

N/A — pure TypeScript + zod + Drizzle. No GPL linkage, no subprocess/REST
boundary, no Docker-image change.
