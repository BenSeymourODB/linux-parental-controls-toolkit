/**
 * DTOs for the per-user PIN auth model (#112): admin PIN management
 * (`/api/users/:userId/pin`) and the `/app` child-scoped session
 * (`/api/app/*`).
 *
 * zod schemas are the single source of truth for the contract; the inferred
 * types are re-exported from `server/src/api/index.ts` so the SvelteKit
 * frontend imports them from the same `/api` surface as every other DTO
 * (`CLAUDE.md` → "Validation / DTOs").
 */
import { z } from "zod";

/**
 * `PUT /api/users/:userId/pin` body — the new PIN. A 4–10 **digit** numeric
 * passcode: long enough to resist trivial guessing (helped by the per-user
 * lockout), short and numeric enough for a child to enter on a phone. Stored
 * only as an Argon2id hash; the plaintext is never persisted or logged.
 */
export const setUserPinSchema = z.object({
  pin: z.string().regex(/^\d{4,10}$/, "PIN must be 4 to 10 digits"),
});
export type SetUserPinRequest = z.infer<typeof setUserPinSchema>;

/**
 * Response of the admin PIN-management routes: whether the user currently has a
 * PIN set. Never reveals the PIN or its hash — the admin UI only needs to show
 * a "PIN set / not set" state and a set/reset/clear control.
 */
export const userPinStatusResponseSchema = z.object({
  pinSet: z.boolean(),
});
export type UserPinStatusResponse = z.infer<typeof userPinStatusResponseSchema>;

/**
 * `POST /api/app/session` body — a child logs in by their stable `userId` plus
 * their PIN. Login is by id (not name) so there is no unauthenticated endpoint
 * disclosing the household roster; the friendly name/avatar picker is the job
 * of the per-child status screen (#110/#111). The PIN is only length-checked
 * here (`min(1)`); its digit format is enforced when an admin *sets* it.
 */
export const pinLoginRequestSchema = z.object({
  userId: z.number().int().positive(),
  pin: z.string().min(1),
});
export type PinLoginRequest = z.infer<typeof pinLoginRequestSchema>;

/** The supervised user a PIN session belongs to, as the `/app` UI sees them. */
export const pinSessionUserSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
});

/**
 * Response of `GET`/`POST /api/app/session`: whether the caller holds a valid
 * PIN session, and the supervised user it is scoped to when they do. The `/app`
 * UI reads this to decide between the PIN-entry screen and the status view.
 */
export const pinSessionResponseSchema = z.object({
  authenticated: z.boolean(),
  user: pinSessionUserSchema.optional(),
});
export type PinSessionResponse = z.infer<typeof pinSessionResponseSchema>;

/**
 * Response of `GET /api/app/me` — the authenticated child's **own** record, the
 * first own-data-only read proving the deny-by-default scoping. Serves only the
 * session's user; never accepts a caller-supplied id.
 */
export const appMeResponseSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
  tz: z.string().nullable(),
});
export type AppMeResponse = z.infer<typeof appMeResponseSchema>;

/**
 * The overall daily screen-time picture for the status screen (#110).
 *
 * `allowedSeconds` / `remainingSeconds` are `null` when the user has **no**
 * overall daily budget (no limit — the ring renders as unlimited rather than
 * empty). Otherwise `remainingSeconds` is `max(0, allowed − consumed)`, so a
 * rounding artefact or an over-run never prints a negative time.
 */
export const appOverallStatusSchema = z.object({
  allowedSeconds: z.number().int().nullable(),
  consumedSeconds: z.number().int(),
  remainingSeconds: z.number().int().nullable(),
});
export type AppOverallStatus = z.infer<typeof appOverallStatusSchema>;

/**
 * One row of the "My limits today" list — an effective per-activity or
 * per-group daily quota with today's consumption against it. `label` is the
 * user-facing name (a group's `name`, or an activity's `matcher`); the client
 * renders it, never re-deriving the vocabulary. `activityKind` carries the
 * activity's kind (`app` / `domain` / …) for icon selection, and is `null` for
 * a group row. Only *budgeted* targets appear — the enforceable set.
 */
export const appActivityStatusSchema = z.object({
  scope: z.enum(["activity", "group"]),
  targetId: z.number().int(),
  label: z.string(),
  activityKind: z.string().nullable(),
  allowedSeconds: z.number().int(),
  consumedSeconds: z.number().int(),
  remainingSeconds: z.number().int(),
});
export type AppActivityStatus = z.infer<typeof appActivityStatusSchema>;

/**
 * The next overall-access transition, as a local wall-clock time (a schedule
 * boundary is a wall-clock concept — see `policy/next-transition.ts`).
 * `access_ends` = access pauses (a lock begins); `access_resumes` = it returns.
 * `null` when access does not change between now and the end of tomorrow.
 */
export const appNextTransitionSchema = z.object({
  kind: z.enum(["access_ends", "access_resumes"]),
  localDate: z.string(),
  atMinuteOfDay: z.number().int(),
});
export type AppNextTransition = z.infer<typeof appNextTransitionSchema>;

/**
 * Response of `GET /api/app/status` — the PIN-scoped per-child status screen
 * (#110). Composed from the effective-policy resolver (grant-adjusted,
 * weekday-varying quotas + allowed windows) and today's usage rollup, all in
 * the user's effective timezone (ADR 0001); the client renders. Deny-by-
 * default: served only for the PIN session's own user.
 *
 * A `rewards` field (recent grants) will be added additively once the Phase-10
 * grant ledger (#113/#116/#117) lands; the shape here is forward-compatible
 * with that addition.
 */
export const appStatusResponseSchema = z.object({
  user: pinSessionUserSchema,
  tz: z.string(),
  now: z.string(),
  date: z.string(),
  overall: appOverallStatusSchema,
  activities: z.array(appActivityStatusSchema),
  access: z.object({
    allowedNow: z.boolean(),
    nextTransition: appNextTransitionSchema.nullable(),
  }),
});
export type AppStatusResponse = z.infer<typeof appStatusResponseSchema>;
