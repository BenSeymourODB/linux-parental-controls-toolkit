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

/** What a {@link Schedule} (or {@link Exception}) does in its window. */
export const scheduleActionValues = ["allow", "deny", "extend"] as const;
export const scheduleActionSchema = z.enum(scheduleActionValues);
export type ScheduleAction = z.infer<typeof scheduleActionSchema>;
