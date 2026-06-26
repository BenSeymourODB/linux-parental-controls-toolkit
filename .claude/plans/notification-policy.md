# Plan — #104 NotificationPolicy: persist in the policy store + push to the client

Roadmap: Phase 8b. Issue #104. Branch: `claude/optimistic-sagan-f1yszu`.

## Context / starting state

The `notification_policies` table is **already scaffolded** on `main` (from the
#48 schema work, `policy/schema.ts`), but with placeholder values that
contradict the authoritative docs:

- `sound_profile` — `text` with **no enum CHECK**, default `"default"`.
  `docs/client-notifications.md` requires one of `off | subtle | prominent`,
  default `subtle`.
- `grace_seconds` — default `60`, only a `>= 0` CHECK.
  Docs require default `15`, range `0–60`.

`docs/architecture.md` lists the columns; `docs/client-notifications.md` →
"Configuration knobs" fixes the vocabulary and defaults. The docs are
authoritative (`CLAUDE.md`), so #104's job is to build the entity out to match
them: correct the schema, add the enum + bounds, DTOs, repository, CRUD API,
and wire it into the existing Phase-2 policy-push stub.

`tests/policy/schema.test.ts` currently asserts the placeholder defaults
(`"default"`, `60`); those assertions get updated to the corrected,
doc-faithful defaults (`"subtle"`, `15`). This is correcting placeholder
scaffolding to the spec, not weakening a test that protects behaviour.

## Scope (this PR)

1. **Schema correction + migration**
   - `enums.ts`: add `soundProfileValues`/`soundProfileSchema`/`SoundProfile`
     (`["off", "subtle", "prominent"]`).
   - New `policy/notification.ts`: grace bounds (`GRACE_SECONDS_MIN=0`,
     `GRACE_SECONDS_MAX=60`), defaults (`DEFAULT_SOUND_PROFILE="subtle"`,
     `DEFAULT_GRACE_SECONDS=15`, `DEFAULT_NOTIFICATION_ENABLED=true`),
     `notificationGraceSecondsSchema`, and `defaultNotificationPolicy(userId)`.
   - `schema.ts`: `sound_profile` enum-typed + CHECK, default `subtle`;
     `grace_seconds` default `15` + CHECK `between 0 and 60`.
   - `npm run db:generate` → one timestamp-prefixed migration (table-recreate,
     SQLite limitation) committed under `server/drizzle/`. `npm run db:check`
     clean. No new table → `migrations.test.ts` table set unchanged.

2. **Repository** (`policy/repository.ts`)
   - `NotificationPolicyRow` type; `getNotificationPolicy(db, userId)`,
     `upsertNotificationPolicy(db, userId, input)` (insert … on conflict update
     by the `user_id` PK), `deleteNotificationPolicy(db, userId)`.

3. **DTOs** (`api/policy/dtos.ts` + barrel exports)
   - `notificationPolicyResponseSchema`, `upsertNotificationPolicySchema`
     (`enabled`, `soundProfile`, `graceSeconds` 0–60, `cadenceOverrides`
     nullable object), `toNotificationPolicyResponse(row)`.

4. **Routes** (`api/policy/routes.ts`) — keyed by user (1:1):
   - `GET /api/users/:userId/notification-policy` → persisted row, or the
     synthesized **default** policy when unset (a user always *has* an
     effective notification policy).
   - `PUT /api/users/:userId/notification-policy` → upsert; emits a
     `notification.upserted` user-scoped push to each linked client.
   - `DELETE /api/users/:userId/notification-policy` → revert to defaults
     (delete row); emits `notification.deleted`. 404 if no row.

5. **Push wiring** (`transport/stub.ts`)
   - Add `notification.upserted` / `notification.deleted` to `PolicyPushReason`
     and `notification.${string}` to `UserPushReason`. A change fans out to the
     user's clients exactly like `budget.*` — the existing offline-queue adapter
     (`queue/policy-push.ts`) needs no change (coalesce key is `user:<id>`).

6. **Tests**
   - `schema.test.ts`: corrected defaults; reject invalid `sound_profile`;
     reject `grace_seconds > 60`.
   - `repository.test.ts`: upsert insert+replace, get, delete.
   - new `tests/api/policy-notification.test.ts`: GET-defaults-when-unset,
     PUT-persists + 200, GET-after-PUT, DELETE-reverts + 404-when-absent, 404
     for unknown user, validation (bad profile / out-of-range grace).
   - `policy-push-stub.test.ts`: `notification.upserted`/`notification.deleted`
     fan-out to linked clients; no push for reads/rejected writes.

## Deferred (downstream consumers, already tracked)

- Wire delivery via `policy.changed` on the event stream — **#100** (PR #193).
- Admin `/admin/notifications` editor — **#105**.
- Agent consumption (cache + cadence) — **#103**.

The push payload + DTOs land here so those are thin follow-ups.

## License boundary

None touched — plain TypeScript + zod + Drizzle (Apache-2.0) + better-sqlite3
(MIT). No GPL linkage, no GPL binary added to the image.
