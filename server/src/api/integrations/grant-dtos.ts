/**
 * zod DTOs for the inbound integration grant endpoint (#113), pinned by
 * ADR 0014.
 *
 * Unlike the internal `/api/*` DTOs (camelCase, consumed by the built-in
 * frontends), this is the **external** machine-to-machine contract with a
 * third-party integrator (first: next-digital-wall-calendar), so its wire shape
 * is **snake_case**, matching `docs/architecture.md` → "External integrations"
 * verbatim. The route maps these snake_case fields onto the camelCase
 * repository input at the boundary, keeping the storage layer on the house
 * convention.
 *
 * Scope vocabulary is derived from the canonical {@link scopeValues} tuple so
 * the request validation can never drift from what the ledger accepts.
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

import { scopeValues } from "../../policy/enums.js";

/** A positive integer id (activity / activity-group target, resolved user). */
const positiveIdSchema = z.number().int().positive();

// --- Request ---------------------------------------------------------------

/**
 * `POST /api/integrations/grants` body (ADR 0014 §1–§4).
 *
 * `user_ref` is a string (v1: the dashboard `User.id` in decimal form) so a
 * future release can also accept a human alias without a `v2`. `target` is
 * required for `activity`/`group` and forbidden for `overall` — the
 * `superRefine` enforces that coherence here (a clear `400`) ahead of the
 * table's coherence CHECK. Target **existence** and `expires_at` being in the
 * future are checked in the route (they need a DB read / the current instant).
 */
export const createGrantSchema = z
  .object({
    /** The subject user; v1 = the dashboard `User.id` in decimal-string form. */
    user_ref: z.string().trim().min(1).max(64),
    /** Grant scope; mirrors policy scopes. */
    scope: z.enum(scopeValues),
    /**
     * Target id: an `activities.id` (`activity`) or `activity_groups.id`
     * (`group`). Omit for `overall`.
     */
    target: positiveIdSchema.optional(),
    /** Seconds granted; must be a positive integer (table CHECK: > 0). */
    seconds: positiveIdSchema,
    /**
     * ISO-8601 datetime; must be in the future (checked in the route).
     * `offset: true` accepts a timezone **offset** (e.g. `-04:00`), not just
     * `Z`, so the documented contract value from `docs/architecture.md` / ADR
     * 0014 (`2026-06-05T23:59:59-04:00`) — the natural end-of-day expiry a
     * calendar integrator emits in local time — is accepted, not 400'd.
     */
    expires_at: z.string().datetime({ offset: true }),
    /** The integrator-owned idempotency key; unique across the ledger. */
    source_ref: z.string().trim().min(1).max(512),
    /** Optional free-text reason for the audit trail / ledger UI (#116). */
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.scope === "overall" && body.target !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "target must be omitted for the 'overall' scope",
      });
    }
    if (body.scope !== "overall" && body.target === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: `target is required for the '${body.scope}' scope`,
      });
    }
  });

export type CreateGrantRequest = z.infer<typeof createGrantSchema>;

// --- Response --------------------------------------------------------------

/**
 * A recorded grant as returned to the integrator (snake_case wire). Returned
 * with `201` on first creation and `200` on an idempotent `source_ref` replay
 * (ADR 0014 §5). `revoked_at` is always `null` on creation; it is included so
 * the shape matches a later ledger read.
 */
export const grantResponseSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  scope: z.enum(scopeValues),
  target: z.number().int().nullable(),
  seconds: z.number().int(),
  expires_at: z.string(),
  source: z.string(),
  source_ref: z.string().nullable(),
  reason: z.string().nullable(),
  granted_at: z.string(),
  revoked_at: z.string().nullable(),
});

export type GrantResponse = z.infer<typeof grantResponseSchema>;
