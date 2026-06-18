/**
 * Drizzle schema for the policy store (SQLite).
 *
 * This is the data foundation for Phase 2 (#48): the entities sketched in
 * `docs/architecture.md` → "Policy model", with foreign keys, `user_id`-
 * leading indexes on the hot query paths, and `CHECK` constraints derived
 * from the shared enum tuples in {@link ./enums.ts}.
 *
 * Conventions:
 * - **Timestamps** are `integer({ mode: "timestamp" })` (epoch seconds).
 *   Epoch is offset-free, so this honours the ADR-0001 rule that everything
 *   is stored in UTC; only budget *rollover* boundaries are interpreted in a
 *   user's effective timezone, and that happens in query code, not storage.
 * - **Enums** are `text` columns plus a `CHECK (col IN (...))` built from the
 *   same tuples the API DTOs validate against — one source of truth.
 * - **Polymorphic `target_id`** (Budget/Schedule/Exception/Grant) points at
 *   an `activity.id` when scope=`activity`, an `activity_group.id` when
 *   scope=`group`, and is NULL when scope=`overall`. It is intentionally not
 *   a foreign key (the referent table depends on the scope); orphan cleanup
 *   is an application-layer concern.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

import {
  activityKindValues,
  budgetWindowValues,
  scheduleActionValues,
  scopeValues,
  transportQueueStatusValues,
} from "./enums.js";

/**
 * Build a `CHECK (column IN ('a', 'b', ...))` constraint expression from a
 * tuple of allowed values. The values are compile-time string literals from
 * {@link ./enums.ts} (never user input), so inlining them as SQL literals is
 * safe and keeps the storage-layer constraint in lock-step with the zod enum
 * the API layer validates against.
 */
function oneOf(column: AnySQLiteColumn, values: readonly string[]): SQL {
  const literals = sql.raw(values.map((value) => `'${value}'`).join(", "));
  return sql`${column} in (${literals})`;
}

/**
 * `CHECK` enforcing the polymorphic-target invariant on Budget/Schedule/
 * Exception/Grant: a row is scoped to the whole user (`overall`) exactly when
 * it has no `target_id`, and to a specific activity/group (`activity` /
 * `group`) exactly when it carries one. Keeps the storage layer from holding
 * an "overall budget for activity 7" or an "activity budget for nothing".
 */
function targetCoherence(kind: AnySQLiteColumn, targetId: AnySQLiteColumn): SQL {
  return sql`(${kind} = 'overall') = (${targetId} is null)`;
}

/** Epoch-seconds `created_at`-style column defaulting to the insert time. */
function timestampNow(name: string) {
  return integer(name, { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`);
}

/**
 * A supervised account. `tz` is a nullable IANA timezone; NULL means "inherit
 * the server default" (`PCT_DEFAULT_TZ`). The effective timezone defines
 * daily/weekly/monthly budget rollover — see `docs/adr/0001-budget-timezone.md`.
 */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  displayName: text("display_name").notNull(),
  tz: text("tz"),
  createdAt: timestampNow("created_at"),
});

/**
 * An enrolled Linux desktop the dashboard orchestrates over SSH.
 *
 * `bearer_token_hash` is the SHA-256 of the per-client bearer token issued at
 * enrolment (#77), which the Phase-8b event stream (`/api/events/stream`)
 * authenticates against. Only the hash is stored — never the plaintext. It is
 * nullable because a client created through the admin CRUD (`POST /api/clients`,
 * #51) has not been through the enrolment exchange and so holds no bearer
 * token; only `POST /api/clients/enrol` sets it.
 */
export const clients = sqliteTable(
  "clients",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hostname: text("hostname").notNull(),
    sshUser: text("ssh_user").notNull(),
    bearerTokenHash: text("bearer_token_hash"),
    enrolledAt: timestampNow("enrolled_at"),
    lastSeen: integer("last_seen", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("clients_hostname_unique").on(table.hostname),
    // The per-client bearer token is the credential the Phase-8b event stream
    // authenticates against (a lookup by hash), so make that lookup single-row
    // by construction. SQLite treats multiple NULLs as distinct, so the
    // admin-CRUD clients that carry no bearer token are unaffected.
    uniqueIndex("clients_bearer_token_hash_unique").on(table.bearerTokenHash),
  ],
);

/**
 * A single-use, expiring client-enrolment credential (#77).
 *
 * The admin mints one ("Add client" flow) bound to the supervised-user mapping
 * being provisioned; the install script (#76) presents it once to
 * `POST /api/clients/enrol`, which creates the {@link clients} row and the
 * {@link usersOnClients} links and then **consumes** the token. Like
 * {@link integrationTokens}, only the SHA-256 `token_hash` is stored — never
 * the plaintext.
 *
 * `supervised_users` is a JSON array of `{ userId, linuxUsername }` the admin
 * bound at mint time (the policy user ↔ Linux account mapping); the client
 * supplies each user's `linuxUid` at enrol time. Single-use is enforced by
 * `consumed_at` (set when redeemed, with `consumed_client_id` pointing at the
 * client it created); expiry by `expires_at`. The token is never edited
 * in-place beyond being marked consumed.
 */
export const enrolmentTokens = sqliteTable(
  "enrolment_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenHash: text("token_hash").notNull(),
    hostname: text("hostname"),
    supervisedUsers: text("supervised_users", { mode: "json" })
      .$type<{ userId: number; linuxUsername: string }[]>()
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: timestampNow("created_at"),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
    consumedClientId: integer("consumed_client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
  },
  (table) => [uniqueIndex("enrolment_tokens_token_hash_unique").on(table.tokenHash)],
);

/**
 * Maps a {@link users} row to its local Linux account on a {@link clients}
 * box. Composite-keyed: a user appears at most once per client, and a Linux
 * UID maps to at most one user on a given client.
 */
export const usersOnClients = sqliteTable(
  "users_on_clients",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    linuxUsername: text("linux_username").notNull(),
    linuxUid: integer("linux_uid").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.clientId] }),
    index("users_on_clients_client_idx").on(table.clientId),
    uniqueIndex("users_on_clients_client_uid_unique").on(table.clientId, table.linuxUid),
  ],
);

/** A matchable app or domain (or a named group of them). */
export const activities = sqliteTable(
  "activities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: activityKindValues }).notNull(),
    matcher: text("matcher").notNull(),
  },
  (table) => [check("activities_kind_check", oneOf(table.kind, activityKindValues))],
);

/** A named bundle of {@link activities}, linked many-to-many. */
export const activityGroups = sqliteTable(
  "activity_groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
  },
  (table) => [uniqueIndex("activity_groups_name_unique").on(table.name)],
);

/** Join table for the {@link activities} ↔ {@link activityGroups} M2M. */
export const activitiesToGroups = sqliteTable(
  "activities_to_groups",
  {
    activityId: integer("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => activityGroups.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.activityId, table.groupId] })],
);

/**
 * A time allowance for a user. `scope` + `target_id` select what is limited
 * (see the polymorphic `target_id` note in the file header); `window` is the
 * rollover period; `seconds_allowed` is the baseline budget before grants.
 */
export const budgets = sqliteTable(
  "budgets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: scopeValues }).notNull(),
    targetId: integer("target_id"),
    window: text("window", { enum: budgetWindowValues }).notNull(),
    secondsAllowed: integer("seconds_allowed").notNull(),
  },
  (table) => [
    index("budgets_user_scope_window_idx").on(table.userId, table.scope, table.window),
    check("budgets_scope_check", oneOf(table.scope, scopeValues)),
    check("budgets_window_check", oneOf(table.window, budgetWindowValues)),
    check("budgets_seconds_check", sql`${table.secondsAllowed} >= 0`),
    check("budgets_target_coherence_check", targetCoherence(table.scope, table.targetId)),
  ],
);

/**
 * A recurring allow/deny/extend rule. `cron_or_window` carries the schedule
 * expression; `target_kind` reuses the scope vocabulary (overall/activity/
 * group) with the same polymorphic `target_id` semantics as {@link budgets}.
 *
 * `ordinal` makes evaluation order **explicit and stored**, not implied by
 * insertion: a user's rules are evaluated ascending by `ordinal` and the
 * first whose window is active wins (first-match-wins, see
 * `docs/adr/0004-schedule-precedence.md`). The same `(user_id, ordinal)`
 * order is what the admin drag-reorder editor persists and what the
 * client/`/app` surfaces replay to show "what's allowed right now", so the
 * column is the single source of precedence across every surface. The
 * `(user_id, ordinal)` index serves both the ordered evaluation read and the
 * plain per-user lookup (left-prefix), so no separate user-only index is kept.
 */
export const schedules = sqliteTable(
  "schedules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetKind: text("target_kind", { enum: scopeValues }).notNull(),
    targetId: integer("target_id"),
    cronOrWindow: text("cron_or_window").notNull(),
    action: text("action", { enum: scheduleActionValues }).notNull(),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (table) => [
    index("schedules_user_ordinal_idx").on(table.userId, table.ordinal),
    check("schedules_target_kind_check", oneOf(table.targetKind, scopeValues)),
    check("schedules_action_check", oneOf(table.action, scheduleActionValues)),
    check("schedules_target_coherence_check", targetCoherence(table.targetKind, table.targetId)),
  ],
);

/**
 * A one-off, expiring override of the normal policy (e.g. "allow games until
 * 9pm tonight"). `expires_at` is UTC; the active-exception lookup is the hot
 * path the `(user_id, expires_at)` index serves.
 */
export const exceptions = sqliteTable(
  "exceptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetKind: text("target_kind", { enum: scopeValues }).notNull(),
    targetId: integer("target_id"),
    action: text("action", { enum: scheduleActionValues }).notNull(),
    reason: text("reason"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: timestampNow("created_at"),
  },
  (table) => [
    index("exceptions_user_expires_idx").on(table.userId, table.expiresAt),
    check("exceptions_target_kind_check", oneOf(table.targetKind, scopeValues)),
    check("exceptions_action_check", oneOf(table.action, scheduleActionValues)),
    check("exceptions_target_coherence_check", targetCoherence(table.targetKind, table.targetId)),
  ],
);

/**
 * A normalised usage interval pulled from ActivityWatch. Both `started_at`
 * and `ended_at` are UTC. Burndown views read these per user over a time
 * window, optionally narrowed to one activity — hence the two indexes.
 */
export const usageSamples = sqliteTable(
  "usage_samples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    activityId: integer("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("usage_samples_user_started_idx").on(table.userId, table.startedAt),
    index("usage_samples_user_activity_started_idx").on(
      table.userId,
      table.activityId,
      table.startedAt,
    ),
    // A sample's interval must be non-negative, so burndown rollups never
    // credit negative time from an inverted or corrupt sample.
    check("usage_samples_interval_check", sql`${table.endedAt} >= ${table.startedAt}`),
  ],
);

/**
 * The immutable grant ledger. A grant is an **additive** allowance on top of
 * the policy baseline; the per-day effective budget is `policy + Σ(active,
 * non-revoked grants)`, computed later (Phase 10).
 *
 * Immutability is encoded structurally, not by trigger:
 * - `source_ref` carries a UNIQUE index — the integrator's idempotency key,
 *   so a retried calendar webhook cannot double-grant. SQLite treats NULLs
 *   as distinct, so admin-issued grants (no `source_ref`) are unconstrained.
 * - revocation is a separate `revoked_at` timestamp, never an in-place edit.
 *   The application layer must never UPDATE a grant's business columns; the
 *   ledger is append-plus-revoke only.
 *
 * `source` is `'admin'` or `'integration:<name>'` (e.g.
 * `integration:next-digital-wall-calendar`).
 */
export const grants = sqliteTable(
  "grants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: scopeValues }).notNull(),
    targetId: integer("target_id"),
    secondsGranted: integer("seconds_granted").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    reason: text("reason"),
    grantedAt: timestampNow("granted_at"),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("grants_source_ref_unique").on(table.sourceRef),
    index("grants_user_scope_target_idx").on(table.userId, table.scope, table.targetId),
    index("grants_user_expires_idx").on(table.userId, table.expiresAt),
    check("grants_scope_check", oneOf(table.scope, scopeValues)),
    check("grants_seconds_check", sql`${table.secondsGranted} > 0`),
    check("grants_target_coherence_check", targetCoherence(table.scope, table.targetId)),
    check(
      "grants_source_check",
      sql`${table.source} = 'admin' or ${table.source} like 'integration:%'`,
    ),
  ],
);

/**
 * One row per external system allowed to call `/api/integrations/*`. Only the
 * `hashed_secret` is stored — never the plaintext token. `scopes` is a JSON
 * array of capability strings (e.g. `["grants:write"]`).
 */
export const integrationTokens = sqliteTable(
  "integration_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    hashedSecret: text("hashed_secret").notNull(),
    createdAt: timestampNow("created_at"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
  },
  (table) => [uniqueIndex("integration_tokens_name_unique").on(table.name)],
);

/**
 * The single dashboard administrator's login credential (#52).
 *
 * This is **not** part of the policy model: a policy-model {@link users} row is
 * a *supervised person*, never an auth principal (`docs/architecture.md` →
 * "Policy model"). There is exactly one admin login for the whole dashboard,
 * and that singleton invariant is encoded structurally — `CHECK (id = 1)` means
 * the table can hold at most one row, so the schema itself rules out a second
 * admin sneaking in. Only the Argon2id `password_hash` is stored; the plaintext
 * (from `PCT_ADMIN_PASSWORD` on first run) is hashed immediately and never
 * persisted. Accounts/roles/MFA are out of scope until the identity work
 * (Phase 11 / stretch #24 → #26).
 */
export const adminCredentials = sqliteTable(
  "admin_credentials",
  {
    id: integer("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestampNow("created_at"),
  },
  (table) => [check("admin_credentials_singleton_check", sql`${table.id} = 1`)],
);

/**
 * Per-user knobs for the client-side notification experience (Phase 8b).
 * 1:1 with {@link users} (the `user_id` is the primary key).
 * `cadence_overrides_json` is an optional JSON blob of warning-cadence
 * overrides; NULL means "use the built-in 15/5/1-minute cadence".
 */
export const notificationPolicies = sqliteTable(
  "notification_policies",
  {
    userId: integer("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    soundProfile: text("sound_profile").notNull().default("default"),
    graceSeconds: integer("grace_seconds").notNull().default(60),
    cadenceOverridesJson: text("cadence_overrides_json", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
  },
  (table) => [check("notification_policies_grace_check", sql`${table.graceSeconds} >= 0`)],
);

/**
 * Durable offline-queue of pending per-client transport actions (#84).
 *
 * When a policy change can't be pushed because the client is offline (the SSH
 * facade raises a retriable {@link SshUnreachableError} —
 * `transport/ssh/errors.ts`), the intended action is persisted here and
 * replayed on the next successful probe (`transport/queue`). Conservative
 * semantics: a missed push is queued, never silently dropped
 * (`docs/architecture.md` → "Client offline at policy-change time").
 *
 * **Coalescing is structural.** The UNIQUE index on `(client_id, coalesce_key)`
 * means a newer push for the same target supersedes the older queued one (the
 * `enqueue` upsert resets it to `pending`), so the queue can't grow unboundedly
 * while a client stays offline — only the latest desired state per target is
 * kept. `kind` is a discriminator (`policy.push`, later `ansible.push`) so a
 * future executor can route `payload` without re-parsing it here. Rows are
 * **deleted** once drained successfully; a non-retriable failure parks the row
 * in `failed` (a dead-letter the admin Clients page #81 can surface) rather
 * than wedging the queue head. The `(client_id, status, id)` index serves the
 * ordered per-client drain read (oldest `pending` first).
 */
export const transportQueue = sqliteTable(
  "transport_queue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    coalesceKey: text("coalesce_key").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: transportQueueStatusValues }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    enqueuedAt: timestampNow("enqueued_at"),
    updatedAt: timestampNow("updated_at"),
  },
  (table) => [
    uniqueIndex("transport_queue_client_coalesce_unique").on(table.clientId, table.coalesceKey),
    index("transport_queue_client_status_id_idx").on(table.clientId, table.status, table.id),
    check("transport_queue_status_check", oneOf(table.status, transportQueueStatusValues)),
    check("transport_queue_attempts_check", sql`${table.attempts} >= 0`),
  ],
);
