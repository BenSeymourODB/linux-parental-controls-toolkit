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

import { type SoundProfile } from "./enums.js";

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
  /** Optional per-budget cadence overrides; `null` ⇒ the built-in cadence. */
  cadenceOverrides: Record<string, unknown> | null;
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
