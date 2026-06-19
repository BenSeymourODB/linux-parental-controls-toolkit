# Issue #124 — User groups + group-level schedules with per-user override precedence

Roadmap: `docs/roadmap.md` → Phase 2. Builds on #51 (policy CRUD), #63
(per-user precedence), composes beside #143/PR #176 (resolver).

## Decisions (per the issue's recommendations)

- **Multi-group membership** — a `User` belongs to ≥0 `UserGroup`s (the issue
  body's wording). Modelled exactly like `activities ↔ activity_groups`
  (`user_group_memberships` join table, composite PK).
- **Precedence**: a user's **own** schedule rules are evaluated first (they
  win), then the rules of the groups the user belongs to, preserving #63's
  first-match-wins *within* each level (ADR 0004). Group order is deterministic
  (ascending group id, then ordinal, then rule id).
- **Budgets are out of scope** here → tracked by #134.
- **Admin UI is deferred** — blocked by #53/#63 (not landed). Remains in #124.

## Phases

### Phase 1 — model + repository (new, additive tables; zero contention)
- `user_groups` (id, name unique, created_at) + `user_group_memberships`
  (user_id, group_id; composite PK; group-id index). Mirrors `activity_groups`.
- Migration via `npm run db:generate`.
- Repository: group CRUD, membership add/remove/list (both directions:
  members of a group; groups of a user), `isUserGroupMember`.
- Schema tests + repository tests.

### Phase 2 — `/api/groups` CRUD + membership routes
- zod DTOs (create/update/response, params) mirroring activity-group DTOs.
- Routes under the existing policy `/api` scope, behind `requireAdmin`,
  409 on name collision, 404 on missing.
- Route tests via `app.inject()`.

### Phase 3 — group-targeting on Schedule/Exception + resolution helper
- Migration B: relax `schedules.user_id` / `exceptions.user_id` to nullable;
  add nullable `user_group_id` FK; CHECK exactly-one-of(user_id, user_group_id);
  add `(user_group_id, ordinal)` / `(user_group_id, expires_at)` indexes.
- Repository: `listGroupSchedules`, group-scoped create; extend
  `ScheduleCreate`/`ExceptionCreate` with `userGroupId` (XOR userId).
- `gatherUserScheduleRules(db, userId)` → merged precedence-ordered list
  (own rules first, then inherited group rules), re-sequenced ordinals so it
  drops straight into `resolveEffectiveRule`. Tagged with `source`
  (user vs group) for the deferred inherited-vs-local UI.
- DTO/route extension to create group-targeted rules; tests.

## Deferred (tracked)
- Admin UI (manage groups, inherited-vs-local) — #53/#63 (stays in #124).
- Feeding `gatherUserScheduleRules` into the #143 effective-policy resolver —
  follow-up once PR #176 merges.
- Group-level budgets — #134.

## License boundary
N/A — plain TypeScript + zod + Drizzle (Apache-2.0) / better-sqlite3 (MIT).
No GPL linkage, no subprocess/REST boundary, no Docker-image change.
