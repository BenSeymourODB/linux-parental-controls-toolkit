# Plan — #48 Drizzle policy schema + first real table migration

Roadmap: `docs/roadmap.md` → Phase 2. Data foundation for #49 (runtime
connection), #51 (CRUD), #52 (admin-credential row).

## Authoritative sources

- `docs/architecture.md` → "Policy model" (entity sketch, FKs).
- `docs/adr/0001-budget-timezone.md` → `User.tz` nullable IANA column
  (Option B/C: UTC storage, per-user TZ override, server default).
- Issue #48 notes: enums as `text` + check constraints sharing a
  zod-derived union; `Grant` immutable ledger (unique `source_ref`,
  revocation via `revoked_at`, never an edit); `IntegrationToken` stores
  only `hashed_secret`.

## Entities

`User`, `Client`, `UserOnClient`, `Activity`, `ActivityGroup`,
`activityToGroup` (M2M), `Budget`, `Schedule`, `Exception`, `UsageSample`,
`Grant`, `IntegrationToken`, `NotificationPolicy`.

## Design decisions

- **IDs:** `integer` autoincrement PKs; join tables use composite PKs
  (`UserOnClient` = (user_id, client_id); `activityToGroup` =
  (activity_id, group_id)). `NotificationPolicy` PK is `user_id` (1:1).
- **Timestamps:** `integer({ mode: "timestamp" })` (epoch seconds, UTC —
  epoch is offset-free, matching the ADR's "UTC everywhere"). DB defaults
  via `sql\`(unixepoch())\`` for `created_at` / `granted_at` /
  `enrolled_at`.
- **Enums** (`scope`, budget `window`, `Activity.kind`, `Schedule.action`)
  live in `src/policy/enums.ts` as `as const` tuples + derived `z.enum`s —
  one source of truth the schema's check constraints and the future API
  DTOs both consume. `Schedule.target_kind` / `Exception.target_kind`
  reuse the `scope` tuple.
- **Polymorphic `target_id`** (Budget / Schedule / Exception / Grant): an
  Activity id when scope=activity, an ActivityGroup id when scope=group,
  NULL when overall. No FK (polymorphic); orphan cleanup is app-layer.
- **`Grant` immutability, encoded structurally:** unique index on
  `source_ref` (the integrator idempotency key — NULL allowed/repeatable
  for admin grants since SQLite treats NULLs as distinct), and a
  `revoked_at` column so revocation is additive, never an in-place edit.
  No triggers (they would drift `db:check`); the no-edit rule is an
  app-layer invariant documented on the table.
- **FKs:** every `user_id` / `client_id` / `activity_id` / `group_id`
  reference is a real FK with `onDelete: "cascade"` (household context:
  removing a user removes their per-user rows).
- **Check constraints** derived from the enum tuples via a small
  `oneOf(column, values)` helper; `Grant.source` constrained to
  `'admin'` or `LIKE 'integration:%'`.
- **Indexes (user_id-leading on hot paths):** `Budget(user_id, scope,
  window)`, `Schedule(user_id)`, `Exception(user_id, expires_at)`,
  `UsageSample(user_id, started_at)` and `(user_id, activity_id,
  started_at)`, `Grant(user_id, scope, target_id)` and `(user_id,
  expires_at)`. Plus integrity uniques: `Client(hostname)`,
  `ActivityGroup(name)`, `IntegrationToken(name)`,
  `UserOnClient(client_id, linux_uid)`, `UserOnClient(client_id)` reverse
  lookup.

## Phases

1. `src/policy/enums.ts` + `src/policy/schema.ts` + `npm run db:generate`
   (commit the SQL + journal). Extend `tests/policy/migrations.test.ts` to
   assert the real tables exist after migrate and re-apply stays a no-op.
2. Behavioural tests in `tests/policy/schema.test.ts`: enum check
   constraints reject bad values, FK enforcement, `Grant.source_ref`
   uniqueness + NULL-repeatable, `Grant.source` constraint,
   `IntegrationToken` has no plaintext column. `enums.test.ts` pins the
   tuples ↔ zod alignment. Keep coverage ≥ 80%.

## License boundary

N/A — pure TypeScript schema + generated SQL. No GPL imports, no binaries
added to the image, no transport/packaging change.
