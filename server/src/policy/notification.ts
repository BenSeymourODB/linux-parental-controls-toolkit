/**
 * Shared bounds, defaults, and validators for the per-user
 * {@link ../policy/schema.ts | NotificationPolicy} (#104), the single source
 * the storage layer ({@link ./schema.ts} `CHECK` constraints + column
 * defaults) and the API layer (`api/policy/dtos.ts` zod validation +
 * default synthesis) both read — so the database constraint and the request
 * validation can never drift, exactly as {@link ./recurrence.ts} does for the
 * schedule recurrence fields.
 *
 * The vocabulary and defaults come from `docs/client-notifications.md` →
 * "Configuration knobs" and "Sound design" (the authoritative source per
 * `CLAUDE.md`):
 *
 * | knob            | default  | bounds                      |
 * |-----------------|----------|-----------------------------|
 * | `enabled`       | `true`   | master switch               |
 * | `sound_profile` | `subtle` | `off` / `subtle` / `prominent` (see {@link ./enums.ts}) |
 * | `grace_seconds` | `15`     | `0`–`60` (0 disables grace) |
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

import { scopeValues, type Scope, type SoundProfile } from "./enums.js";

/** Minimum grace-period length: `0` disables the grace countdown entirely. */
export const GRACE_SECONDS_MIN = 0;
/** Maximum grace-period length (`docs/client-notifications.md`: range 0–60). */
export const GRACE_SECONDS_MAX = 60;

/** Default master switch — notifications on unless the admin opts out. */
export const DEFAULT_NOTIFICATION_ENABLED = true;
/** Default sound theme (`docs/client-notifications.md` → "Sound design"). */
export const DEFAULT_SOUND_PROFILE: SoundProfile = "subtle";
/** Default grace-period length in seconds. */
export const DEFAULT_GRACE_SECONDS = 15;

/**
 * A grace period in whole seconds within `[GRACE_SECONDS_MIN,
 * GRACE_SECONDS_MAX]`. Shared by the create/update DTOs so the API bound and
 * the storage `CHECK` are one source.
 */
export const notificationGraceSecondsSchema = z
  .number()
  .int()
  .min(GRACE_SECONDS_MIN)
  .max(GRACE_SECONDS_MAX);

// --- Per-budget warning-cadence overrides (#302) ---------------------------
//
// `docs/client-notifications.md` -> "Notification cadence" fires warnings at a
// budget's remaining-time boundaries; the built-in low-threshold set is
// {15,10,5,4,3,2,1} minutes (plus the >15-minute quarter-hour boundaries the
// agent derives). An override replaces that low-threshold set *for one budget*
// (e.g. "no sub-5-minute warnings for the homework activity"). #104 shipped
// the column as a deliberately loose `Record<string, unknown>`; #302 pins the
// grammar here so the storage `$type`, the API DTOs, and the frontend read one
// source, exactly as this module already does for grace/sound.

/** Smallest warn-at mark: whole minutes remaining, >= 1 (0:00 is always "time's up"). */
export const WARNING_MINUTE_MIN = 1;
/** Largest warn-at mark: a full day of remaining time (generous but bounded). */
export const WARNING_MINUTE_MAX = 1440;
/** Ceiling on the number of distinct warn-at marks in one budget's override. */
export const WARNING_MINUTES_MAX_COUNT = 32;
/** Ceiling on the number of per-budget overrides in one policy. */
export const CADENCE_OVERRIDE_KEYS_MAX = 64;

/**
 * The built-in low-threshold warning set (minutes) that a per-budget override
 * replaces — `docs/client-notifications.md` -> "Notification cadence — exact
 * rules". The >15-minute quarter-hour cadence is derived by the agent and is
 * not part of the overridable low-threshold set.
 */
export const DEFAULT_WARNING_MINUTES: readonly number[] = [15, 10, 5, 4, 3, 2, 1];

/**
 * A cadence-override map key: which budget the override applies to. Budgets are
 * keyed by `(scope, target_id)` ({@link ./schema.ts}), so the key is `overall`
 * (the whole-user budget) or `<scope>:<targetId>` for a per-activity /
 * per-group budget. Keyed by `(scope, target)`, not rollover window — a cadence
 * preference is per-activity, not per daily/weekly/monthly window. Derived from
 * {@link scopeValues} so the grammar and the scope enum can't drift.
 */
const KEYED_SCOPES = scopeValues.filter((s) => s !== "overall");
const CADENCE_KEY_PATTERN = new RegExp(`^(?:overall|(?:${KEYED_SCOPES.join("|")}):[1-9][0-9]*)$`);

/** Build the {@link cadenceOverridesSchema} key for a budget's `(scope, target)`. */
export function budgetCadenceKey(scope: Scope, targetId: number | null): string {
  return scope === "overall" ? "overall" : `${scope}:${String(targetId)}`;
}

/** A budget-override map key: `overall` | `activity:<id>` | `group:<id>`. */
export const budgetCadenceKeySchema = z
  .string()
  .regex(CADENCE_KEY_PATTERN, "must be 'overall', 'activity:<id>', or 'group:<id>'");

/** A single warn-at mark: whole minutes remaining within the documented bounds. */
export const warningMinuteSchema = z.number().int().min(WARNING_MINUTE_MIN).max(WARNING_MINUTE_MAX);

/**
 * One budget's cadence override: the explicit set of "minutes remaining" marks
 * at which to warn, *replacing* {@link DEFAULT_WARNING_MINUTES} for that budget.
 * Normalised to a de-duplicated, descending list; an empty list means "no
 * pre-expiry warnings for this budget" (only the 0:00 time's-up toast). An
 * object (not a bare array) so a later per-budget knob can be added without a
 * reshape.
 */
export const budgetCadenceOverrideSchema = z
  .object({
    warningMinutes: z
      .array(warningMinuteSchema)
      .max(WARNING_MINUTES_MAX_COUNT)
      .transform((mins) => Array.from(new Set(mins)).sort((a, b) => b - a)),
  })
  .strict();

/**
 * The pinned `cadence_overrides_json` shape: a map of budget key -> override.
 * `null` (not this schema) still means "use the built-in cadence"; that nullable
 * lives on the DTOs/column. Capped at {@link CADENCE_OVERRIDE_KEYS_MAX} budgets.
 */
export const cadenceOverridesSchema = z
  .record(budgetCadenceKeySchema, budgetCadenceOverrideSchema)
  .refine((map) => Object.keys(map).length <= CADENCE_OVERRIDE_KEYS_MAX, {
    message: `at most ${String(CADENCE_OVERRIDE_KEYS_MAX)} per-budget cadence overrides`,
  });

/** A validated per-budget cadence override entry. */
export type BudgetCadenceOverride = z.infer<typeof budgetCadenceOverrideSchema>;
/** The validated per-budget cadence-override map (see {@link cadenceOverridesSchema}). */
export type CadenceOverrides = z.infer<typeof cadenceOverridesSchema>;

/**
 * The effective notification policy a user has before any admin customisation:
 * the documented defaults, with no cadence overrides. The `GET` route returns
 * this when no row is persisted, and a `DELETE` reverts a user to it — every
 * user always *has* an effective notification policy, it is just at defaults
 * until customised.
 */
export interface NotificationPolicyValues {
  enabled: boolean;
  soundProfile: SoundProfile;
  graceSeconds: number;
  /** Optional per-budget cadence overrides (#302); `null` ⇒ the built-in cadence. */
  cadenceOverrides: CadenceOverrides | null;
}

/** The documented default notification policy (no persisted row needed). */
export function defaultNotificationPolicy(): NotificationPolicyValues {
  return {
    enabled: DEFAULT_NOTIFICATION_ENABLED,
    soundProfile: DEFAULT_SOUND_PROFILE,
    graceSeconds: DEFAULT_GRACE_SECONDS,
    cadenceOverrides: null,
  };
}
