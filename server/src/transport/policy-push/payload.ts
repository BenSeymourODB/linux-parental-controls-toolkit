/**
 * Validation for a replayed `policy.push` queue payload (#201, #84).
 *
 * The offline queue (#84) persists a {@link import("../queue/policy-push.js").PolicyPushPayload}
 * as opaque JSON and hands it back to the executor on replay. Before that
 * untyped row crosses into the live-push code it is validated here, per
 * `CLAUDE.md` → "Validate all external input … subprocess stdout" (a persisted
 * queue row is external-at-rest just like subprocess output): a hand-edited or
 * schema-drifted row fails loudly rather than mis-pushing.
 *
 * Only `userId` is acted on (it selects the user whose effective policy is
 * recomputed and pushed); `reason`/`detail` are carried for audit attribution
 * and structured logging, so they are validated structurally but not narrowed
 * to the `PolicyPushReason` union — a future reason value must not wedge replay
 * of an already-enqueued row.
 *
 * License boundary: none touched — zod (MIT) over a plain object.
 */
import { z } from "zod";

/** zod schema for the queued `policy.push` payload the executor consumes. */
export const policyPushPayloadSchema = z.object({
  /** Affected user, or `null` for a client-scoped change with no per-user push. */
  userId: z.number().int().nullable(),
  /** The mutation that triggered the push (for audit/log context). */
  reason: z.string().min(1),
  /** Diff detail (logged as structured fields); shape is reason-specific. */
  detail: z.record(z.string(), z.unknown()),
});

/** The validated `policy.push` payload. */
export type ValidatedPolicyPushPayload = z.infer<typeof policyPushPayloadSchema>;
