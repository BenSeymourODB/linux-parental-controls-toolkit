/**
 * The bridge's copy of the server-to-client event contract (#101, Phase 8b).
 *
 * This is the **client side** of the wire contract single-sourced on the
 * server in `server/src/events/taxonomy.ts`: the five events the dashboard
 * pushes (`grant.applied`, `policy.changed`, `enforce.force_close`,
 * `enforce.session_lock`, `lockout.cleared`) and the `{ seq, at, event }` frame
 * envelope. The bridge re-declares the schemas rather than importing them
 * because it is a separate package that ships in the `.deb` with its own
 * bundled Node runtime (`docs/client-notifications.md`) — there is no workspace
 * to import `server/src` across, and ADR 0007 makes the contract a *negotiated*
 * one in any case. `tests/bridge/protocol.test.ts` pins these shapes so the two
 * declarations cannot silently drift.
 *
 * Every inbound frame is validated against {@link eventFrameSchema} before the
 * bridge acts on it (`CLAUDE.md` → "Validate all external input … before it
 * crosses into typed code"). The `at` timestamp is ISO-8601 UTC (ADR 0001) and
 * `seq` is a server-process-wide monotonic counter the bridge may use for
 * ordering/de-dup but not as a per-connection resume cursor.
 *
 * License boundary: none touched — plain TypeScript + zod (MIT).
 */
import { z } from "zod";

/** A policy `User.id` — every pushed event addresses one supervised user. */
const userIdSchema = z.number().int().positive();

/** `grant.applied` — a `Grant` was recorded (admin UI or external integrator). */
export const grantAppliedSchema = z.object({
  type: z.literal("grant.applied"),
  userId: userIdSchema,
  grantedSeconds: z.number().int().positive(),
  reason: z.string().min(1).max(200),
  /** Targeted activity, or `null` for the overall budget. */
  activityId: z.number().int().positive().nullable(),
});

/** `policy.changed` — a budget, schedule, or activity rule for the user changed. */
export const policyChangedSchema = z.object({
  type: z.literal("policy.changed"),
  userId: userIdSchema,
  summary: z.string().min(1).max(200).optional(),
});

/** `enforce.force_close` — a per-app/group budget is exhausted and grace elapsed. */
export const enforceForceCloseSchema = z.object({
  type: z.literal("enforce.force_close"),
  userId: userIdSchema,
  activityId: z.number().int().positive(),
});

/** `enforce.session_lock` — the overall-screen-time budget is exhausted and grace elapsed. */
export const enforceSessionLockSchema = z.object({
  type: z.literal("enforce.session_lock"),
  userId: userIdSchema,
});

/** `lockout.cleared` — a grant restored time after a lockout; login is allowed again. */
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

/** A single server-pushed event. */
export type ServerEvent = z.infer<typeof serverEventSchema>;

/** The literal `type` discriminants, for exhaustive client-side handling. */
export type ServerEventType = ServerEvent["type"];

/** The wire frame: one per WebSocket message. */
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

/** Raised when a WebSocket message is not a valid {@link EventFrame}. */
export class FrameDecodeError extends Error {
  constructor(
    message: string,
    /** The original cause (a `ZodError` or `SyntaxError`), for logging. */
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FrameDecodeError";
  }
}

/**
 * Decode and validate one raw WebSocket message into a typed {@link EventFrame}.
 *
 * `raw` is the message as received from `ws` — a `string` for a text frame, or
 * a `Buffer`/`ArrayBuffer`-like for a binary frame, which is decoded as UTF-8.
 * Throws {@link FrameDecodeError} on malformed JSON or a shape that fails the
 * schema, so the caller can log-and-drop a single bad frame without tearing
 * down the connection (the stream is best-effort per frame; a poison frame
 * must not kill the bridge).
 */
export function decodeFrame(raw: string | Uint8Array): EventFrame {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new FrameDecodeError("event frame is not valid JSON", err);
  }

  const parsed = eventFrameSchema.safeParse(json);
  if (!parsed.success) {
    throw new FrameDecodeError("event frame failed schema validation", parsed.error);
  }
  return parsed.data;
}
