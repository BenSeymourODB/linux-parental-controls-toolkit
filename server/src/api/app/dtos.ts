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
