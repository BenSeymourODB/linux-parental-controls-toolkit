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

/** An enrolled Linux desktop the dashboard orchestrates over SSH. */
export const clients = sqliteTable(
  "clients",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hostname: text("hostname").notNull(),
    sshUser: text("ssh_user").notNull(),
    enrolledAt: timestampNow("enrolled_at"),
    lastSeen: integer("last_seen", { mode: "timestamp" }),
  },
  (table) => [uniqueIndex("clients_hostname_unique").on(table.hostname)],
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
  ],
);

/**
 * A recurring allow/deny/extend rule. `cron_or_window` carries the schedule
 * expression; `target_kind` reuses the scope vocabulary (overall/activity/
 * group) with the same polymorphic `target_id` semantics as {@link budgets}.
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
  },
  (table) => [
    index("schedules_user_idx").on(table.userId),
    check("schedules_target_kind_check", oneOf(table.targetKind, scopeValues)),
    check("schedules_action_check", oneOf(table.action, scheduleActionValues)),
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
 * Per-user knobs for the client-side notification experience (Phase 8b).
 * 1:1 with {@link users} (the `user_id` is the primary key).
 * `cadence_overrides_json` is an optional JSON blob of warning-cadence
 * overrides; NULL means "use the built-in 15/5/1-minute cadence".
 */
export const notificationPolicies = sqliteTable("notification_policies", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  soundProfile: text("sound_profile").notNull().default("default"),
  graceSeconds: integer("grace_seconds").notNull().default(60),
  cadenceOverridesJson: text("cadence_overrides_json", { mode: "json" }).$type<
    Record<string, unknown>
  >(),
});
