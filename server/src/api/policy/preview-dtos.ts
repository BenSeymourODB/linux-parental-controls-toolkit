/**
 * DTOs for the save-and-push **preview** endpoint (#64):
 * `POST /api/users/:userId/policy-preview`.
 *
 * The request carries a *proposed* policy — the budgets and schedule rules the
 * admin is about to save — as the **same** `budgetResponseSchema` /
 * `scheduleResponseSchema` the editor already holds after a GET (no parallel
 * wire shape). The endpoint resolves it against the user's *current* persisted
 * policy and returns the human-readable change set plus the clients the push
 * would fan out to. The change/response shapes mirror the pure diff engine
 * (`transport/policy-push/diff.ts`) so the frontend renders exactly what the
 * engine computes.
 *
 * License boundary: none touched — zod over plain objects.
 */
import { z } from "zod";

import { clientReachabilityValues } from "../../transport/health/index.js";
import { budgetResponseSchema, scheduleResponseSchema } from "./dtos.js";

/**
 * The proposed-policy preview request body. `budgets`/`schedules` reuse the
 * single-source response DTOs (what the editor holds), so a proposed rule
 * carries its `id`/`ordinal` — which the resolver needs for precedence.
 *
 * Two ways to pick the reference the proposed/current resolution is computed
 * against, in precedence order:
 *
 * - `date` — a calendar date (`YYYY-MM-DD`) the admin picks to preview a
 *   **future-dated** policy (#281). The server resolves it to an instant at
 *   local noon of that date in the *user's effective timezone*, so the
 *   recurring resolver selects the right reference week (a date-scoped schedule
 *   rule dormant today but active that week then shows in the diff). Because the
 *   tz-aware conversion is the server's to make, the client sends only the date.
 * - `now` — an instant-precise reference (ISO-8601 date-time), the seam
 *   deterministic tests pin the clock with.
 *
 * When both are present `date` wins; when neither is, the current time is used.
 *
 * Note: `scheduleResponseSchema` validates the recurrence fields only
 * structurally (each `int | null`), not the cross-field invariants the write
 * path enforces (`scheduleRecurrenceSchema`: both-or-neither minutes,
 * `start < end`, `effectiveFrom < effectiveTo`). That is acceptable here — the
 * body is the already-validated rows the admin editor holds, the route is
 * `requireAdmin`-only, and preview neither persists nor pushes; a malformed
 * proposed rule at worst yields a misleading *preview*, never a bad write. If a
 * non-editor caller is ever given this endpoint, tighten this to apply
 * `scheduleRecurrenceSchema`'s refinements.
 *
 * `probe` is an **opt-in** flag: absent/false keeps the endpoint
 * side-effect-free (last-seen + queue depth only); `true` asks it to also probe
 * each affected client's live reachability over the Phase-4 SSH facade (only
 * effective once the live prober is wired, #39). It is deliberately *not*
 * `.default(false)` so the inferred request type keeps `probe?: boolean` and
 * callers that never probe omit it.
 */
export const policyPreviewRequestSchema = z.object({
  budgets: z.array(budgetResponseSchema).default([]),
  schedules: z.array(scheduleResponseSchema).default([]),
  now: z.string().datetime().optional(),
  /**
   * A calendar date (`YYYY-MM-DD`) to preview the policy *as of*. Optional and,
   * like `now`, deliberately not `.default(...)` so the inferred type keeps
   * `date?: string` and a caller previewing "today" omits it. Validated as a
   * real calendar date (rejects `2026-13-40` and any date-time string).
   */
  date: z.iso.date().optional(),
  probe: z.boolean().optional(),
});

export type PolicyPreviewRequest = z.infer<typeof policyPreviewRequestSchema>;

/** Which resolved-push field a preview change row concerns. */
export const policyPushChangeFieldSchema = z.enum([
  "daily-overall",
  "weekly-limit",
  "monthly-limit",
  "allowed-hours",
]);

/** Whether a value was added, removed, or changed. */
export const policyPushChangeKindSchema = z.enum(["added", "removed", "changed"]);

/** One human-readable difference between the current and proposed push. */
export const policyPushChangeResponseSchema = z.object({
  field: policyPushChangeFieldSchema,
  kind: policyPushChangeKindSchema,
  weekday: z.number().int().min(1).max(7).nullable(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  summary: z.string(),
});

/**
 * A client the push would fan out to, with the annotations the preview can
 * offer: when the client was last seen and how many actions are already queued
 * for it (both cheap, always present), plus — only when the request opted into
 * `probe` and the live prober is wired — a point-in-time `reachability`
 * (`online`/`offline`/`unknown`) and the `probedAt` instant. When the probe was
 * not requested or no prober is wired, both are `null` (the default,
 * side-effect-free shape); the live push-vs-queue decision still happens at push
 * time against real reachability regardless.
 */
export const previewAffectedClientSchema = z.object({
  clientId: z.number().int(),
  hostname: z.string(),
  lastSeen: z.string().nullable(),
  pendingQueueDepth: z.number().int().nonnegative(),
  reachability: z.enum(clientReachabilityValues).nullable(),
  probedAt: z.string().nullable(),
});

/** The preview response: the change set + the clients it would reach. */
export const policyPreviewResponseSchema = z.object({
  userId: z.number().int(),
  hasChanges: z.boolean(),
  changes: z.array(policyPushChangeResponseSchema),
  affectedClients: z.array(previewAffectedClientSchema),
});

export type PolicyPreviewResponse = z.infer<typeof policyPreviewResponseSchema>;
export type PreviewAffectedClient = z.infer<typeof previewAffectedClientSchema>;
