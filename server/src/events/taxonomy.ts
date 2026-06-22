/**
 * Server-to-client event taxonomy and wire frame (#100, Phase 8b).
 *
 * The five events the dashboard pushes to the `pct-client-bridge` over
 * `/api/events/stream`, modelled as a zod **discriminated union on `type`**
 * (`docs/client-notifications.md` → "Event types pushed by the server"). The
 * inferred {@link ServerEvent} type is what the publish API ({@link ../events/hub.ts})
 * accepts, and the schemas are re-exported from the `api/` barrel so the
 * client bridge (#101) and any external consumer share one contract.
 *
 * Every event targets one supervised user on the connected client, so each
 * carries a `userId` (the policy `User.id`); the bridge maps that to the local
 * Linux account it forwards to. The payloads here are the **v1** shapes: the
 * event *producers* land with their own phases (`enforce.*` with #99, the
 * lockout flow with #108, `grant.applied` with the Phase-10 grant pipeline)
 * and may extend a payload then — a change the `/api/meta` `apiVersion`
 * handshake (#165) lets an upgraded server negotiate with older clients. They
 * are kept deliberately minimal here: enough to address and describe the
 * event, not to duplicate state the client already holds from policy push.
 *
 * The wire format is one JSON {@link EventFrame} per WebSocket frame:
 * `{ seq, at, event }`, where `seq` is a **process-wide** monotonic counter
 * (shared across all clients and connections, so any single connection sees
 * gaps — the bridge uses it for ordering/de-dup, not as a per-connection
 * resume cursor) and `at` is the server send time (ISO-8601, UTC — ADR 0001).
 * The frame envelope is stamped by the hub at publish time, not by producers.
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

/** A policy `User.id` — every pushed event addresses one supervised user. */
const userIdSchema = z.number().int().positive();

/**
 * `grant.applied` — a `Grant` was recorded (admin UI or external integrator).
 * `activityId` is `null` for an overall-screen-time grant, or the targeted
 * `Activity.id` for a per-activity grant ("+45 min of YouTube").
 */
export const grantAppliedSchema = z.object({
  type: z.literal("grant.applied"),
  userId: userIdSchema,
  /** Seconds of screen time added by the grant. */
  grantedSeconds: z.number().int().positive(),
  /** Why the time was granted, surfaced in the toast (e.g. "chores done"). */
  reason: z.string().min(1).max(200),
  /** Targeted activity, or `null` for the overall budget. */
  activityId: z.number().int().positive().nullable(),
});

/**
 * `policy.changed` — a budget, schedule, or activity rule for the user
 * changed. The authoritative new policy is pushed over the SSH transport; this
 * event is the nudge to re-render, with an optional human-readable summary.
 */
export const policyChangedSchema = z.object({
  type: z.literal("policy.changed"),
  userId: userIdSchema,
  /** Optional one-line summary for the toast ("Your YouTube limit is now 1h"). */
  summary: z.string().min(1).max(200).optional(),
});

/**
 * `enforce.force_close` — a per-app/group budget is exhausted and the grace
 * period has elapsed; the agent should close the matching processes. Carries
 * the `Activity.id` whose matcher the agent uses to find the processes.
 */
export const enforceForceCloseSchema = z.object({
  type: z.literal("enforce.force_close"),
  userId: userIdSchema,
  activityId: z.number().int().positive(),
});

/**
 * `enforce.session_lock` — the overall-screen-time budget is exhausted and the
 * grace period has elapsed; the bridge hands off to Timekpr-nExT's
 * session-kill if it has not already fired.
 */
export const enforceSessionLockSchema = z.object({
  type: z.literal("enforce.session_lock"),
  userId: userIdSchema,
});

/**
 * `lockout.cleared` — a grant restored time after a lockout; login is allowed
 * again and any logged-in session toasts "more time".
 */
export const lockoutClearedSchema = z.object({
  type: z.literal("lockout.cleared"),
  userId: userIdSchema,
});

/** The discriminated union of every server-pushed event. */
export const serverEventSchema = z.discriminatedUnion("type", [
  grantAppliedSchema,
  policyChangedSchema,
  enforceForceCloseSchema,
  enforceSessionLockSchema,
  lockoutClearedSchema,
]);

/** A single server-pushed event (the publish API's input). */
export type ServerEvent = z.infer<typeof serverEventSchema>;

/** The literal `type` discriminants, for exhaustive client-side handling. */
export type ServerEventType = ServerEvent["type"];

/**
 * The wire frame: one per WebSocket message. `seq` is monotonic within a
 * server process (event ordering / client-side de-dup); `at` is the UTC send
 * time. The {@link ../events/hub.ts EventHub} stamps both at publish time.
 */
export const eventFrameSchema = z.object({
  /** Monotonic, non-negative sequence number assigned at publish time. */
  seq: z.number().int().nonnegative(),
  /** Server send time, ISO-8601 UTC. */
  at: z.iso.datetime(),
  /** The event payload. */
  event: serverEventSchema,
});

/** A decoded event frame as it appears on the wire. */
export type EventFrame = z.infer<typeof eventFrameSchema>;
