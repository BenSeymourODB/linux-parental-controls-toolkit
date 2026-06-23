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

import { budgetResponseSchema, scheduleResponseSchema } from "./dtos.js";

/**
 * The proposed-policy preview request body. `budgets`/`schedules` reuse the
 * single-source response DTOs (what the editor holds), so a proposed rule
 * carries its `id`/`ordinal` — which the resolver needs for precedence. `now`
 * is an optional reference instant (ISO-8601) the proposed/current resolution
 * is computed against; it exists for deterministic tests and future-dated
 * previews, and defaults to the current time when absent.
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
 */
export const policyPreviewRequestSchema = z.object({
  budgets: z.array(budgetResponseSchema).default([]),
  schedules: z.array(scheduleResponseSchema).default([]),
  now: z.string().datetime().optional(),
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
 * A client the push would fan out to, with the side-effect-free annotation the
 * preview can offer: when the client was last seen, and how many actions are
 * already queued for it. The live push-vs-queue decision still happens at push
 * time against real reachability — preview never probes.
 */
export const previewAffectedClientSchema = z.object({
  clientId: z.number().int(),
  hostname: z.string(),
  lastSeen: z.string().nullable(),
  pendingQueueDepth: z.number().int().nonnegative(),
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
