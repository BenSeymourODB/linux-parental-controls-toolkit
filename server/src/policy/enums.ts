/**
 * Enumerated value sets shared between the policy schema and the API layer.
 *
 * Each enum is declared once as an `as const` tuple and a derived `z.enum`,
 * so there is a single source of truth: the Drizzle schema builds its SQLite
 * `CHECK` constraints from the tuples (see {@link ./schema.ts}), and the
 * `/api/*` zod DTOs (Phase 2, #50/#51) validate against the same schemas.
 * Keeping the tuple and the zod enum together guarantees the database
 * constraint and the request validation can never drift apart.
 *
 * Modelled as `text` columns rather than a native enum because SQLite has no
 * enum type; the `CHECK (col IN (...))` constraint is what enforces the set
 * at the storage layer (issue #48).
 */
import { z } from "zod";

/**
 * Budget / Grant / Schedule / Exception scope: what a limit applies to.
 *
 * - `overall` — the user's total screen time (`target_id` is NULL).
 * - `activity` — a single {@link Activity} (`target_id` → `activity.id`).
 * - `group` — an {@link ActivityGroup} (`target_id` → `activity_group.id`).
 */
export const scopeValues = ["overall", "activity", "group"] as const;
export const scopeSchema = z.enum(scopeValues);
export type Scope = z.infer<typeof scopeSchema>;

/**
 * The OS family an enrolled {@link Client} runs (#229).
 *
 * - `linux` — the only implemented enforcement target today, and the
 *   **default** for every existing and newly enrolled client.
 * - `windows` — **reserved**, not yet implemented; a Windows enforcement
 *   client is the post-Phase-14 epic (#233). Reserving the value now keeps
 *   the discriminator a trivial defaulted column instead of a
 *   migrate-with-data problem once a fleet exists (cf. how #146 reserved the
 *   recurrence columns ahead of need).
 */
export const platformValues = ["linux", "windows"] as const;
export const platformSchema = z.enum(platformValues);
export type Platform = z.infer<typeof platformSchema>;

/** Rollover window for a {@link Budget}; resolved in the user's effective TZ. */
export const budgetWindowValues = ["daily", "weekly", "monthly"] as const;
export const budgetWindowSchema = z.enum(budgetWindowValues);
export type BudgetWindow = z.infer<typeof budgetWindowSchema>;

/**
 * What kind of thing an {@link Activity} matches.
 *
 * App-level kinds match a running process/window; domain-level kinds match a
 * web request. The `*_group` kinds match a named bundle the client expands.
 */
export const activityKindValues = ["app", "app_group", "domain", "domain_group"] as const;
export const activityKindSchema = z.enum(activityKindValues);
export type ActivityKind = z.infer<typeof activityKindSchema>;

/**
 * How an {@link Activity}'s `matcher` is interpreted against a telemetry
 * identifier (the ActivityWatch foreground `app`, or — once web-proxy telemetry
 * lands — a request host). All matching is case-insensitive (ADR 0006).
 *
 * - `exact` — equality. **Default; == the #88 v1 behaviour**, so every
 *   pre-existing activity keeps its meaning with no data migration.
 * - `substring` — the matcher occurs anywhere in the identifier.
 * - `glob` — whole-string match with `*` (any run) and `?` (any one char) the
 *   only metacharacters; compiled to a bounded regex.
 * - `regex` — a JS regular expression, validated to compile at write time.
 */
export const matchTypeValues = ["exact", "substring", "glob", "regex"] as const;
export const matchTypeSchema = z.enum(matchTypeValues);
export type MatchType = z.infer<typeof matchTypeSchema>;

/** What a {@link Schedule} (or {@link Exception}) does in its window. */
export const scheduleActionValues = ["allow", "deny", "extend"] as const;
export const scheduleActionSchema = z.enum(scheduleActionValues);
export type ScheduleAction = z.infer<typeof scheduleActionSchema>;

/**
 * The client-side sound theme for a user's notifications, per
 * `docs/client-notifications.md` → "Sound design":
 *
 * - `off` — no sounds at all.
 * - `subtle` (default) — soft cues for routine warnings.
 * - `prominent` — louder cues routed through a higher-volume channel, for a
 *   user who routinely misses the subtle ones.
 *
 * The agent (#103) reads this from the pushed `NotificationPolicy` and the
 * admin sets it from `/admin/notifications` (#105).
 */
export const soundProfileValues = ["off", "subtle", "prominent"] as const;
export const soundProfileSchema = z.enum(soundProfileValues);
export type SoundProfile = z.infer<typeof soundProfileSchema>;

/**
 * Outcome of a transport command recorded in the audit log (#85), derived from
 * the SSH facade's error taxonomy (`transport/ssh/errors.ts`):
 *
 * - `ok` — the command ran and exited zero.
 * - `failed` — the host was reached but the command exited non-zero / was
 *   signal-killed (`SshCommandError`).
 * - `unreachable` — the host could not be reached (`SshUnreachableError`).
 * - `timeout` — the command exceeded its per-exec timeout (`SshExecTimeoutError`).
 * - `parse_error` — the command succeeded but its stdout failed validation
 *   (`SshParseError`).
 */
export const auditOutcomeValues = [
  "ok",
  "failed",
  "unreachable",
  "timeout",
  "parse_error",
] as const;
export const auditOutcomeSchema = z.enum(auditOutcomeValues);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

/**
 * Lifecycle of a queued offline transport action (#84, `transport_queue`).
 *
 * - `pending` — awaiting a successful push to the (currently offline) client;
 *   drained in order on the next reachable probe. A row is **deleted** once
 *   drained successfully, so the queue holds only outstanding work.
 * - `failed` — dead-lettered: the action failed non-retriably (the command
 *   itself is wrong, so replaying it unchanged won't help), so it is parked
 *   here rather than blocking the queue head, where the admin Clients page
 *   (#81) can surface it. A *retriable* failure never lands here — it stays
 *   `pending` and is retried on a later tick (a missed push is never dropped).
 */
export const transportQueueStatusValues = ["pending", "failed"] as const;
export const transportQueueStatusSchema = z.enum(transportQueueStatusValues);
export type TransportQueueStatus = z.infer<typeof transportQueueStatusSchema>;

/**
 * The classes of *dated* data a retention window can target (#135/#136).
 *
 * The vocabulary is grounded in `docs/adr/0005-recurrence-and-date-scoping.md`
 * §4: retention purges only rows that have an "age", never the recurrence
 * rules themselves. So the categories are the dated tables that exist today:
 *
 * - `usage_samples` — ActivityWatch usage history (`usage_samples.ended_at`).
 * - `grant_ledger` — the immutable {@link grants} ledger (`granted_at`).
 * - `audit_log` — transport audit entries (`audit_log.at`).
 * - `date_overrides` — date-specific policy rows whose effective window lies
 *   wholly in the past: an `exception` past `expires_at`, or a `schedule` past
 *   `effective_to`. A purely recurring schedule (no `effective_to`) has no age
 *   and is out of retention's scope entirely (ADR 0005 §4).
 *
 * The epic (#135) named `schedule_history` / `budget_history` as illustrative
 * examples; there are no such tables (schedules/budgets are live recurrence
 * rules, not dated history), so they are deliberately not categories here.
 */
export const retentionCategoryValues = [
  "usage_samples",
  "grant_ledger",
  "audit_log",
  "date_overrides",
] as const;
export const retentionCategorySchema = z.enum(retentionCategoryValues);
export type RetentionCategory = z.infer<typeof retentionCategorySchema>;
