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
  auditOutcomeValues,
  budgetWindowValues,
  matchTypeValues,
  platformValues,
  retentionCategoryValues,
  scheduleActionValues,
  scopeValues,
  soundProfileValues,
  transportQueueStatusValues,
} from "./enums.js";
import {
  DEFAULT_GRACE_SECONDS,
  DEFAULT_NOTIFICATION_ENABLED,
  DEFAULT_SOUND_PROFILE,
  GRACE_SECONDS_MAX,
  GRACE_SECONDS_MIN,
  type CadenceOverrides,
} from "./notification.js";
import {
  MINUTE_OF_DAY_MAX,
  MINUTE_OF_DAY_MIN,
  WEEKDAY_MASK_MAX,
  WEEKDAY_MASK_MIN,
} from "./recurrence.js";

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
 * Per-user PIN credential for the `/app` child-scoped session (#112).
 *
 * A supervised `User` is normally a policy subject, not an auth principal
 * (`docs/server-deployment.md` → "Authentication"); this is the one, optional
 * exception — a child opens `/app`, enters a numeric PIN, and gets a session
 * scoped to **their own** data only. The credential lives in its own table
 * (not a `users` column) so the Argon2id hash never rides along on the
 * widely-read `users` rows / DTOs, mirroring the `integration_tokens`
 * credential-isolation precedent. One PIN per user (`user_id` is unique); the
 * row is removed with its user (`ON DELETE CASCADE`). Only the hash is stored
 * — the plaintext PIN is never persisted.
 */
export const userPins = sqliteTable("user_pins", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  hashedPin: text("hashed_pin").notNull(),
  createdAt: timestampNow("created_at"),
  updatedAt: timestampNow("updated_at"),
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
 *
 * The `*_version` columns (#164) record what each client is running so Phase 14
 * (#163) has an inventory to diff against. They are nullable because a client
 * that doesn't report versions (an older install script, an admin-CRUD client)
 * still enrols; `versions_reported_at` is set only when at least one version is
 * reported. `component_versions` is a JSON blob keyed by managed component.
 *
 * `platform` (#229) is the OS-family discriminator — `linux` today, `windows`
 * reserved (post-Phase-14 epic #233). It defaults to `linux` so every existing
 * row and every current enrolment carries it without a backfill; reserving it
 * now keeps a future per-platform transport/UI branch off a schema migration.
 */
export interface ComponentVersions {
  // `| undefined` on each optional field so this lines up with the zod-inferred
  // `componentVersionsSchema` shape under `exactOptionalPropertyTypes`.
  timekpr?: string | undefined;
  e2guardian?: string | undefined;
  activitywatch?: string | undefined;
}

export const clients = sqliteTable(
  "clients",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hostname: text("hostname").notNull(),
    /**
     * An admin-chosen label ("kids' living-room PC") shown as the card title in
     * the Clients view, in preference to the raw `hostname` (#355). Nullable:
     * carried from the enrolment token's `friendlyName` at claim time when the
     * admin set one, and editable afterwards via `PATCH /api/clients/:id`.
     */
    friendlyName: text("friendly_name"),
    sshUser: text("ssh_user").notNull(),
    bearerTokenHash: text("bearer_token_hash"),
    enrolledAt: timestampNow("enrolled_at"),
    lastSeen: integer("last_seen", { mode: "timestamp" }),
    /**
     * The client's own primary IPv4/IPv6 address(es) as it reported them at
     * enrol (#355), a JSON string array. Advisory only — self-reported IPs go
     * stale under DHCP (re-announce is tracked separately) — and never used as
     * an SSH target in this slice; recorded so the admin can recognise a box and
     * so a later SSH-target override has candidate addresses to offer.
     */
    reportedIps: text("reported_ips", { mode: "json" }).$type<string[]>(),
    /**
     * The observed source IP of the enrol request (#355): `request.ip`, which is
     * the direct socket peer unless `trustProxy` is configured (#235), in which
     * case it is the real client IP derived from a trusted `X-Forwarded-For`. A
     * self-report-free ground truth of the address that actually reached the
     * server client→server, for the admin and the post-enrol verification.
     */
    sourceIp: text("source_ip"),
    /**
     * Durable telemetry pull cursor (#382): the `end` of the last window whose
     * `UsageSample` rows were successfully persisted for this client. The
     * Phase-5 pull seeds its in-memory cursor from this on boot and advances
     * both together after each successful insert, so the first pass after a
     * restart resumes exactly here instead of re-pulling the whole
     * `initialLookback` window (a bounded double-count). `NULL` = no successful
     * pull yet → the pull falls back to `initialLookback`.
     */
    lastTelemetryPullAt: integer("last_telemetry_pull_at", { mode: "timestamp" }),
    agentVersion: text("agent_version"),
    componentVersions: text("component_versions", { mode: "json" }).$type<ComponentVersions>(),
    versionsReportedAt: integer("versions_reported_at", { mode: "timestamp" }),
    platform: text("platform", { enum: platformValues }).notNull().default("linux"),
    /**
     * Set when the client's event-stream `hello` was refused for being older
     * than the supported protocol window (ADR 0007 §5, #165); cleared once it
     * connects compatibly again. A flag + admin signal only — remediation
     * (pushing an agent update) is the Phase-14 update mechanism.
     */
    updateRequired: integer("update_required", { mode: "boolean" }).notNull().default(false),
    /**
     * The post-enrol connectivity verification outcome (#354): a real
     * server→client SSH round-trip (`POST /api/clients/:id/verify-connection`),
     * distinct from the passive `last_seen` liveness signal. Enrolment only
     * proves the client can reach the dashboard; these columns record whether
     * the *dashboard can reach the client over SSH* — the direction every push,
     * probe, and telemetry pull uses — so the admin can tell "enrolled but never
     * verified" from "verified once, currently offline".
     *
     * `last_verified_at` is `NULL` until the first verification runs.
     * `last_verify_reachable` is the boolean verdict of the most recent run.
     * `last_verify_reason` carries the classified SSH failure cause (#353 —
     * `dns` / `connection_refused` / `timeout` / `auth` / `handshake` /
     * `unknown`) when the last run failed, and `NULL` when it succeeded or has
     * never run. Stored as plain text so the `policy/` layer keeps no dependency
     * on `transport/`; the write path is the only writer and is typed against
     * the {@link SshUnreachableReason} enum.
     */
    lastVerifiedAt: integer("last_verified_at", { mode: "timestamp" }),
    lastVerifyReachable: integer("last_verify_reachable", { mode: "boolean" }),
    lastVerifyReason: text("last_verify_reason"),
  },
  (table) => [
    uniqueIndex("clients_hostname_unique").on(table.hostname),
    // The per-client bearer token is the credential the Phase-8b event stream
    // authenticates against (a lookup by hash), so make that lookup single-row
    // by construction. SQLite treats multiple NULLs as distinct, so the
    // admin-CRUD clients that carry no bearer token are unaffected.
    uniqueIndex("clients_bearer_token_hash_unique").on(table.bearerTokenHash),
    check("clients_platform_check", oneOf(table.platform, platformValues)),
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
 * `supervised_users` is a JSON array of `{ userId, osUsername }` the admin
 * bound at mint time (the policy user ↔ OS account mapping); the client
 * supplies each user's `osUserRef` at enrol time. Single-use is enforced by
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
    /**
     * An optional admin-chosen label set at mint time and applied to the
     * {@link clients} row's `friendlyName` at claim (#355). Reframes the
     * enrol-token form's former "Expected hostname" input into a friendly
     * identity the admin picks up front; the informational `hostname` column
     * above is retained for backward compatibility.
     */
    friendlyName: text("friendly_name"),
    supervisedUsers: text("supervised_users", { mode: "json" })
      .$type<{ userId: number; osUsername: string }[]>()
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
 * Maps a {@link users} row to its local OS account on a {@link clients}
 * box. Composite-keyed: a user appears at most once per client, and an OS
 * account reference maps to at most one user on a given client.
 *
 * The columns are OS-neutral (#230, `docs/windows-client-support.md` →
 * "Modularity tweaks to make cheaply now", item 2): `os_username` is the local
 * login name, `os_user_ref` is the account reference — a **uid on Linux, a SID
 * on Windows** — so it is `TEXT`, holding the Linux uid as a decimal string
 * today. Neutralised now while every consumer is first-party; renaming the
 * published `/api/*` field after the PWA and the calendar integrator bind to it
 * would be a breaking-contract change.
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
    osUsername: text("os_username").notNull(),
    osUserRef: text("os_user_ref").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.clientId] }),
    index("users_on_clients_client_idx").on(table.clientId),
    uniqueIndex("users_on_clients_client_user_ref_unique").on(table.clientId, table.osUserRef),
  ],
);

/**
 * A named set of supervised {@link users} that policy can target as a unit
 * (#124) — "set bedtime for all the kids once". A user may belong to ≥0 groups
 * (membership is many-to-many via {@link userGroupMemberships}); group-targeted
 * {@link schedules}/{@link exceptions} are inherited by every member, with the
 * member's own rules taking precedence (see `policy/group-resolution.ts`).
 *
 * This is a distinct axis from {@link activityGroups}, which bundles
 * *activities*; `UserGroup` bundles *users*.
 */
export const userGroups = sqliteTable(
  "user_groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    createdAt: timestampNow("created_at"),
  },
  (table) => [uniqueIndex("user_groups_name_unique").on(table.name)],
);

/**
 * Join table for the {@link users} ↔ {@link userGroups} M2M (multi-group
 * membership). Composite-keyed so a user appears at most once per group; the
 * `group_id` index serves the "who is in this group?" read (the user-id read
 * is the composite PK's left prefix).
 */
export const userGroupMemberships = sqliteTable(
  "user_group_memberships",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => userGroups.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.groupId] }),
    index("user_group_memberships_group_idx").on(table.groupId),
  ],
);

/** A matchable app or domain (or a named group of them). */
export const activities = sqliteTable(
  "activities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: activityKindValues }).notNull(),
    matcher: text("matcher").notNull(),
    // How `matcher` is interpreted (ADR 0006). Defaults to `exact` so every
    // row predating this column keeps the #88 v1 behaviour with no backfill.
    matchType: text("match_type", { enum: matchTypeValues }).notNull().default("exact"),
  },
  (table) => [
    check("activities_kind_check", oneOf(table.kind, activityKindValues)),
    check("activities_match_type_check", oneOf(table.matchType, matchTypeValues)),
  ],
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
    // Weekday-varying budgets (#141, ADR 0013): a 7-bit ISO-weekday mask (bit 0
    // = Monday … bit 6 = Sunday) restricting the day(s) this allowance applies
    // to; NULL = uniform (every day), the degenerate default identical to a
    // pre-#141 row. Only meaningful for `daily` budgets — a rolling weekly/
    // monthly cap is a period total, not a per-day figure.
    recurrenceDays: integer("recurrence_days"),
  },
  (table) => [
    index("budgets_user_scope_window_idx").on(table.userId, table.scope, table.window),
    check("budgets_scope_check", oneOf(table.scope, scopeValues)),
    check("budgets_window_check", oneOf(table.window, budgetWindowValues)),
    check("budgets_seconds_check", sql`${table.secondsAllowed} >= 0`),
    check("budgets_target_coherence_check", targetCoherence(table.scope, table.targetId)),
    // Weekday mask, when present, names at least one ISO weekday (1..127).
    check(
      "budgets_recurrence_days_check",
      sql`${table.recurrenceDays} is null or (${table.recurrenceDays} between ${sql.raw(String(WEEKDAY_MASK_MIN))} and ${sql.raw(String(WEEKDAY_MASK_MAX))})`,
    ),
    // A weekday mask only makes sense on a daily budget (ADR 0013 §1).
    check(
      "budgets_recurrence_daily_only_check",
      sql`${table.recurrenceDays} is null or ${table.window} = 'daily'`,
    ),
  ],
);

/**
 * A recurring allow/deny/extend rule. `target_kind` reuses the scope
 * vocabulary (overall/activity/group) with the same polymorphic `target_id`
 * semantics as {@link budgets}.
 *
 * **Recurrence + date-scoping (reserved by #146, model fixed in
 * `docs/adr/0005-recurrence-and-date-scoping.md`).** The window is a
 * purpose-built day-of-week + intra-day struct, replacing the never-defined
 * free-text `cron_or_window`:
 *
 * - `recurrence_days` — a 7-bit ISO-weekday mask (`1..127`, bit 0 = Monday …
 *   bit 6 = Sunday); NULL = no weekday restriction.
 * - `recurrence_start_minute` / `recurrence_end_minute` — minutes from local
 *   midnight, active on `[start, end)`; both NULL = no intra-day restriction,
 *   and when set `0 <= start < end <= 1440`.
 * - `effective_from` / `effective_to` — UTC instants that date-scope the rule;
 *   NULL on a side means open-ended there.
 *
 * A row with all five NULL is the **always-on degenerate** — behaviourally
 * identical to the pre-recurrence uniform rule, so this reservation is
 * non-breaking. The "is this rule active at instant *T*?" resolver (#143) and
 * the editors (#53/#63) are out of scope here; see {@link ./recurrence.ts} for
 * the shared bounds/validators and ADR 0005 for the model.
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
    recurrenceDays: integer("recurrence_days"),
    recurrenceStartMinute: integer("recurrence_start_minute"),
    recurrenceEndMinute: integer("recurrence_end_minute"),
    effectiveFrom: integer("effective_from", { mode: "timestamp" }),
    effectiveTo: integer("effective_to", { mode: "timestamp" }),
    action: text("action", { enum: scheduleActionValues }).notNull(),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (table) => [
    index("schedules_user_ordinal_idx").on(table.userId, table.ordinal),
    check("schedules_target_kind_check", oneOf(table.targetKind, scopeValues)),
    check("schedules_action_check", oneOf(table.action, scheduleActionValues)),
    check("schedules_target_coherence_check", targetCoherence(table.targetKind, table.targetId)),
    // Weekday mask, when present, names at least one ISO weekday (1..127).
    check(
      "schedules_recurrence_days_check",
      sql`${table.recurrenceDays} is null or (${table.recurrenceDays} between ${sql.raw(String(WEEKDAY_MASK_MIN))} and ${sql.raw(String(WEEKDAY_MASK_MAX))})`,
    ),
    // The intra-day bounds are both NULL or both set, and when set form a
    // non-empty half-open window 0 <= start < end <= 1440.
    check(
      "schedules_recurrence_minutes_check",
      sql`(${table.recurrenceStartMinute} is null) = (${table.recurrenceEndMinute} is null) and (${table.recurrenceStartMinute} is null or (${table.recurrenceStartMinute} >= ${sql.raw(String(MINUTE_OF_DAY_MIN))} and ${table.recurrenceEndMinute} <= ${sql.raw(String(MINUTE_OF_DAY_MAX))} and ${table.recurrenceStartMinute} < ${table.recurrenceEndMinute}))`,
    ),
    // A bounded effective window must be non-empty (strict `<`).
    check(
      "schedules_effective_window_check",
      sql`${table.effectiveFrom} is null or ${table.effectiveTo} is null or ${table.effectiveFrom} < ${table.effectiveTo}`,
    ),
  ],
);

/**
 * A one-off, expiring override of the normal policy (e.g. "allow games until
 * 9pm tonight"). `expires_at` is UTC; the active-exception lookup is the hot
 * path the `(user_id, expires_at)` index serves.
 *
 * `effective_from` (reserved by #146, ADR 0005) lets an override be
 * **pre-scheduled** for a future instant instead of being active the moment it
 * is created: the override is active during `[effective_from ?? created_at,
 * expires_at)`. NULL keeps today's behaviour (active from creation).
 * `expires_at` remains the effective end — no separate `effective_to` column,
 * per ADR 0005 §2.
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
    effectiveFrom: integer("effective_from", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: timestampNow("created_at"),
  },
  (table) => [
    index("exceptions_user_expires_idx").on(table.userId, table.expiresAt),
    check("exceptions_target_kind_check", oneOf(table.targetKind, scopeValues)),
    check("exceptions_action_check", oneOf(table.action, scheduleActionValues)),
    check("exceptions_target_coherence_check", targetCoherence(table.targetKind, table.targetId)),
    // A pre-scheduled override must begin strictly before it expires.
    check(
      "exceptions_effective_window_check",
      sql`${table.effectiveFrom} is null or ${table.effectiveFrom} < ${table.expiresAt}`,
    ),
  ],
);

/**
 * A recurring allow/deny/extend rule defined **once for a {@link userGroups
 * group}** and inherited by every member (#182, `docs/adr/0007-group-targeted-policy-rules.md`).
 * Column-for-column the same rule shape as {@link schedules} — including the
 * reserved recurrence + date-scoping window (ADR 0005) and the polymorphic
 * `target_id` (see the file header) — but keyed by `user_group_id` instead of
 * `user_id`, and with its own per-group `ordinal` (first-match-wins within the
 * group, ADR 0004).
 *
 * Kept in a separate table rather than relaxing `schedules.user_id` to nullable
 * (ADR 0007 §"Why B over A"): the user-keyed table and its wire contract stay
 * untouched. The two tables converge at resolution, not in storage — a member's
 * own rules and these inherited rules are merged into one precedence-ordered
 * list by `policy/group-resolution.ts`, both satisfying the owner-agnostic
 * `ScheduleRule` interface, so there is no duplicated precedence logic.
 */
export const groupSchedules = sqliteTable(
  "group_schedules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userGroupId: integer("user_group_id")
      .notNull()
      .references(() => userGroups.id, { onDelete: "cascade" }),
    targetKind: text("target_kind", { enum: scopeValues }).notNull(),
    targetId: integer("target_id"),
    recurrenceDays: integer("recurrence_days"),
    recurrenceStartMinute: integer("recurrence_start_minute"),
    recurrenceEndMinute: integer("recurrence_end_minute"),
    effectiveFrom: integer("effective_from", { mode: "timestamp" }),
    effectiveTo: integer("effective_to", { mode: "timestamp" }),
    action: text("action", { enum: scheduleActionValues }).notNull(),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (table) => [
    index("group_schedules_group_ordinal_idx").on(table.userGroupId, table.ordinal),
    check("group_schedules_target_kind_check", oneOf(table.targetKind, scopeValues)),
    check("group_schedules_action_check", oneOf(table.action, scheduleActionValues)),
    check(
      "group_schedules_target_coherence_check",
      targetCoherence(table.targetKind, table.targetId),
    ),
    check(
      "group_schedules_recurrence_days_check",
      sql`${table.recurrenceDays} is null or (${table.recurrenceDays} between ${sql.raw(String(WEEKDAY_MASK_MIN))} and ${sql.raw(String(WEEKDAY_MASK_MAX))})`,
    ),
    check(
      "group_schedules_recurrence_minutes_check",
      sql`(${table.recurrenceStartMinute} is null) = (${table.recurrenceEndMinute} is null) and (${table.recurrenceStartMinute} is null or (${table.recurrenceStartMinute} >= ${sql.raw(String(MINUTE_OF_DAY_MIN))} and ${table.recurrenceEndMinute} <= ${sql.raw(String(MINUTE_OF_DAY_MAX))} and ${table.recurrenceStartMinute} < ${table.recurrenceEndMinute}))`,
    ),
    check(
      "group_schedules_effective_window_check",
      sql`${table.effectiveFrom} is null or ${table.effectiveTo} is null or ${table.effectiveFrom} < ${table.effectiveTo}`,
    ),
  ],
);

/**
 * A one-off, expiring override defined **once for a {@link userGroups group}**
 * and inherited by every member (#182, ADR 0007). The {@link exceptions} shape
 * keyed by `user_group_id` instead of `user_id`: active during
 * `[effective_from ?? created_at, expires_at)` (ADR 0005 §2), the
 * `(user_group_id, expires_at)` index serving the active-override lookup.
 */
export const groupExceptions = sqliteTable(
  "group_exceptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userGroupId: integer("user_group_id")
      .notNull()
      .references(() => userGroups.id, { onDelete: "cascade" }),
    targetKind: text("target_kind", { enum: scopeValues }).notNull(),
    targetId: integer("target_id"),
    action: text("action", { enum: scheduleActionValues }).notNull(),
    reason: text("reason"),
    effectiveFrom: integer("effective_from", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: timestampNow("created_at"),
  },
  (table) => [
    index("group_exceptions_group_expires_idx").on(table.userGroupId, table.expiresAt),
    check("group_exceptions_target_kind_check", oneOf(table.targetKind, scopeValues)),
    check("group_exceptions_action_check", oneOf(table.action, scheduleActionValues)),
    check(
      "group_exceptions_target_coherence_check",
      targetCoherence(table.targetKind, table.targetId),
    ),
    check(
      "group_exceptions_effective_window_check",
      sql`${table.effectiveFrom} is null or ${table.effectiveFrom} < ${table.expiresAt}`,
    ),
  ],
);

/**
 * A time allowance defined **once for a {@link userGroups group}** and inherited
 * by every member as the baseline (#134,
 * `docs/adr/0008-group-targeted-budgets.md`). Column-for-column the same shape
 * as {@link budgets} — the same polymorphic `scope`/`target_id` (see the file
 * header) and `window`/`seconds_allowed` — but keyed by `user_group_id` instead
 * of `user_id`.
 *
 * Kept in a separate table rather than relaxing `budgets.user_id` to nullable,
 * for the same reasons ADR 0007 chose separate tables for group schedules: the
 * user-keyed table and its `BudgetResponse` wire contract stay untouched, and
 * the two tables converge at *resolution*, not in storage. `policy/group-
 * resolution.ts` → `gatherUserBudgets` resolves a member's effective baseline by
 * taking the member's own budget for a `(scope, window, target)` slot when set,
 * otherwise the inherited group budget for that slot (lowest group id wins). A
 * `Budget` is a single baseline figure, not an additive layer — grants are the
 * additive layer (architecture → "Policy model"), so override is full-replace
 * per slot, never a sum.
 */
export const groupBudgets = sqliteTable(
  "group_budgets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userGroupId: integer("user_group_id")
      .notNull()
      .references(() => userGroups.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: scopeValues }).notNull(),
    targetId: integer("target_id"),
    window: text("window", { enum: budgetWindowValues }).notNull(),
    secondsAllowed: integer("seconds_allowed").notNull(),
    // Weekday-varying group budgets (#141, ADR 0013); same 7-bit ISO-weekday
    // mask semantics as {@link budgets}.recurrenceDays. NULL = uniform.
    recurrenceDays: integer("recurrence_days"),
  },
  (table) => [
    index("group_budgets_group_scope_window_idx").on(table.userGroupId, table.scope, table.window),
    check("group_budgets_scope_check", oneOf(table.scope, scopeValues)),
    check("group_budgets_window_check", oneOf(table.window, budgetWindowValues)),
    check("group_budgets_seconds_check", sql`${table.secondsAllowed} >= 0`),
    check("group_budgets_target_coherence_check", targetCoherence(table.scope, table.targetId)),
    check(
      "group_budgets_recurrence_days_check",
      sql`${table.recurrenceDays} is null or (${table.recurrenceDays} between ${sql.raw(String(WEEKDAY_MASK_MIN))} and ${sql.raw(String(WEEKDAY_MASK_MAX))})`,
    ),
    check(
      "group_budgets_recurrence_daily_only_check",
      sql`${table.recurrenceDays} is null or ${table.window} = 'daily'`,
    ),
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
 * Per-user knobs for the client-side notification experience (#104, Phase 8b).
 * 1:1 with {@link users} (the `user_id` is the primary key). The values and
 * their defaults come from `docs/client-notifications.md` → "Configuration
 * knobs" (the authoritative source); the shared bounds/defaults live in
 * {@link ./notification.ts} so the storage `CHECK` and the API DTOs read one
 * source.
 *
 * - `enabled` — master switch, default `true`.
 * - `sound_profile` — `off` / `subtle` / `prominent` ({@link soundProfileValues}),
 *   default `subtle`; a `CHECK` pins it to the enum the DTO validates against.
 * - `grace_seconds` — 0–60, default 15 (0 disables the grace countdown).
 * - `cadence_overrides_json` — optional JSON map of per-budget warning-cadence
 *   overrides ({@link ./notification.ts} `cadenceOverridesSchema`, #302); NULL
 *   means "use the built-in 15/5/1-minute cadence".
 */
export const notificationPolicies = sqliteTable(
  "notification_policies",
  {
    userId: integer("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" })
      .notNull()
      .default(DEFAULT_NOTIFICATION_ENABLED),
    soundProfile: text("sound_profile", { enum: soundProfileValues })
      .notNull()
      .default(DEFAULT_SOUND_PROFILE),
    graceSeconds: integer("grace_seconds").notNull().default(DEFAULT_GRACE_SECONDS),
    cadenceOverridesJson: text("cadence_overrides_json", {
      mode: "json",
    }).$type<CadenceOverrides>(),
  },
  (table) => [
    check(
      "notification_policies_sound_profile_check",
      oneOf(table.soundProfile, soundProfileValues),
    ),
    // Grace period is a whole number of seconds in [0, 60] (ADR knobs: 0
    // disables the countdown, 60 is the documented ceiling).
    check(
      "notification_policies_grace_check",
      sql`${table.graceSeconds} between ${sql.raw(String(GRACE_SECONDS_MIN))} and ${sql.raw(String(GRACE_SECONDS_MAX))}`,
    ),
  ],
);

/**
 * Append-only audit of every command the dashboard issues to a client over the
 * SSH transport (timekpra now; Ansible runs and enforcement force-closes land
 * here as their phases arrive) — the one place to answer "what did the system
 * do to this client, and when" (#85, `docs/roadmap.md` → Phase 4).
 *
 * Immutability is a posture, not a trigger: the application layer only ever
 * INSERTs (via the `transport/audit` recorder) and SELECTs; a row is never
 * UPDATEd in place. Like the {@link grants} ledger, this is distinct data —
 * that records *grants*, this records *commands issued to clients*.
 *
 * - `at` is UTC (ADR 0001 / `docs/architecture.md` → "audit entries"): epoch
 *   seconds, offset-free.
 * - `target_host` / `target_port` / `target_user` are recorded **verbatim** so
 *   an entry stands alone — the `client_id`/`user_id` FKs are nullable and
 *   `ON DELETE SET NULL`, so removing a client or user never erases the history
 *   of what was done to it.
 * - `actor` is who/what triggered the command — `system` (scheduled/internal),
 *   `admin`, or `integration:<name>`; free text rather than an enum because the
 *   integration names are open-ended. Defaults to `system`.
 * - `command` is the **redacted** argv vector (JSON string array). No
 *   credential is ever in argv — the SSH key lives in the target, not the
 *   command — but the recorder redacts secret-bearing flags defensively
 *   (`CLAUDE.md`-aligned "command summary (no secrets)").
 * - `outcome` is derived from the SSH error taxonomy (see {@link auditOutcomeValues}).
 *
 * The `(at)` index serves the newest-first browse and the Phase-11 retention
 * purge scan (#137/#138); `(client_id, at)` serves the per-client view (#81).
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: timestampNow("at"),
    targetHost: text("target_host").notNull(),
    targetPort: integer("target_port").notNull(),
    targetUser: text("target_user").notNull(),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    actor: text("actor").notNull().default("system"),
    reason: text("reason"),
    command: text("command", { mode: "json" }).$type<string[]>().notNull(),
    outcome: text("outcome", { enum: auditOutcomeValues }).notNull(),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    durationMs: integer("duration_ms").notNull(),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("audit_log_at_idx").on(table.at),
    index("audit_log_client_at_idx").on(table.clientId, table.at),
    check("audit_log_outcome_check", oneOf(table.outcome, auditOutcomeValues)),
    check("audit_log_duration_check", sql`${table.durationMs} >= 0`),
  ],
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

/**
 * Per-category retention overrides (#136, epic #135).
 *
 * Retention has a global default window (env `PCT_RETENTION_DEFAULT_DAYS`, 365
 * days) plus optional per-category overrides stored here — one row per
 * {@link retentionCategoryValues} category that diverges from the default. A
 * category with **no row** inherits the default; a row either pins a custom
 * positive `days` count or sets `keep_forever`. The pure resolution rule and
 * the `isExpired` predicate that the purge job (#137/#138) reuses live in
 * `policy/retention.ts`; this table is just the persisted override layer.
 *
 * `category` is the primary key (at most one override per category). The
 * coherence CHECK encodes the keepForever ⊕ days invariant the model also
 * guards (`overrideToResolved`): keep-forever rows carry no day count, custom
 * rows carry a positive one. `updated_at` is UTC epoch seconds (ADR 0001).
 */
export const retentionOverrides = sqliteTable(
  "retention_overrides",
  {
    category: text("category", { enum: retentionCategoryValues }).primaryKey(),
    keepForever: integer("keep_forever", { mode: "boolean" }).notNull().default(false),
    days: integer("days"),
    updatedAt: timestampNow("updated_at"),
  },
  (table) => [
    check("retention_overrides_category_check", oneOf(table.category, retentionCategoryValues)),
    // keepForever ⊕ days: keep-forever rows carry no day count; custom-window
    // rows carry a strictly-positive one. Mirrors `overrideToResolved`.
    check(
      "retention_overrides_coherence_check",
      sql`(${table.keepForever} = 1 and ${table.days} is null) or (${table.keepForever} = 0 and ${table.days} > 0)`,
    ),
  ],
);
