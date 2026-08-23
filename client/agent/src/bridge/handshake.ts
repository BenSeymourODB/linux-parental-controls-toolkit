/**
 * The bridge's client side of the ADR-0007 event-stream version handshake
 * (#303, Phase 8b).
 *
 * On every (re)connect the bridge **speaks first** with a `hello`
 * (`agentVersion`, `eventProtocol`, `capabilities`) and proceeds only on the
 * server's `accept`; on `refuse` (`code: "incompatible_protocol"`) it surfaces
 * the `update_required` condition and stops retrying (ADR 0007 §2). This module
 * is the pure, I/O-free contract — the frame builder + the reply parser —
 * mirroring the server's `server/src/events/protocol.ts` (`negotiate` /
 * `helloFrameSchema` / `acceptFrameSchema` / `refuseFrameSchema`).
 *
 * Why re-declare rather than import: the bridge ships as its own `.deb` with a
 * bundled Node runtime (`docs/client-notifications.md`) — there is no workspace
 * to import `server/src` across, exactly as `protocol.ts` already re-declares
 * the *event* envelope for the same reason. `tests/bridge/handshake.test.ts`
 * pins these shapes against the server contract so the two declarations cannot
 * silently drift.
 *
 * License boundary: none touched — plain TypeScript + zod (MIT).
 */
import { z } from "zod";

/**
 * The frame-envelope/handshake protocol version this bridge speaks (ADR 0007
 * §1) — a positive integer, kept in lockstep with the server's `EVENT_PROTOCOL`
 * and bumped only on a *breaking* envelope/handshake change (additive changes
 * ride on {@link BRIDGE_CAPABILITIES}).
 */
export const EVENT_PROTOCOL = 1;

/**
 * The enforcement primitives this (Linux) bridge honours, advertised in `hello`
 * (ADR 0007 §4). The bridge forwards all five server events, so it advertises
 * both capabilities the server gates on today (mirrors the server's
 * `events/capabilities.ts` `CLIENT_CAPABILITIES`):
 *
 * - `session_budget` — overall-screen-time lock/unlock (`enforce.session_lock`,
 *   `lockout.cleared`).
 * - `per_app_close` — per-app/group process force-close (`enforce.force_close`).
 *
 * `grant.applied` / `policy.changed` are baseline (ungated) frames every client
 * receives regardless. Capability strings are additively extensible — adding one
 * is never a breaking change.
 */
export const BRIDGE_CAPABILITIES: readonly string[] = ["session_budget", "per_app_close"];

/**
 * Client → server opening frame (ADR 0007 §2). Mirrors the server's
 * `helloFrameSchema`; used to validate {@link buildHello}'s own output in tests.
 */
export const helloFrameSchema = z.object({
  type: z.literal("hello"),
  /** The `pct-client` agent `.deb` version (refreshes the server inventory, #164). */
  agentVersion: z.string().min(1).max(100),
  /** The integer frame-protocol version this client speaks. */
  eventProtocol: z.number().int().positive(),
  /** Additive feature flags the client supports (§4). */
  capabilities: z.array(z.string().min(1).max(100)).max(64),
});

/** The client's opening `hello` frame. */
export type HelloFrame = z.infer<typeof helloFrameSchema>;

/** Inputs for {@link buildHello}. */
export interface HelloInput {
  /** The agent `.deb` version to report (the packaging stamps this). */
  agentVersion: string;
  /** The protocol version to advertise (defaults to {@link EVENT_PROTOCOL}). */
  eventProtocol?: number;
  /** The capabilities to advertise (defaults to {@link BRIDGE_CAPABILITIES}). */
  capabilities?: readonly string[];
}

/** Build the opening `hello` frame the bridge sends on each (re)connect. */
export function buildHello(input: HelloInput): HelloFrame {
  return {
    type: "hello",
    agentVersion: input.agentVersion,
    eventProtocol: input.eventProtocol ?? EVENT_PROTOCOL,
    capabilities: [...(input.capabilities ?? BRIDGE_CAPABILITIES)],
  };
}

/**
 * Server → client `accept` frame: the stream proceeds in the agreed dialect
 * (`eventProtocol` is the version the server will *speak* — the client's own
 * when within the N-1 window). Mirrors the server's `acceptFrameSchema`.
 */
export const acceptFrameSchema = z.object({
  type: z.literal("accept"),
  eventProtocol: z.number().int().positive(),
  apiVersion: z.number().int().positive(),
});

/** A decoded `accept` frame. */
export type AcceptFrame = z.infer<typeof acceptFrameSchema>;

/** The single refusal code (the `/api/*` error-envelope vocabulary, ADR 0007 §2). */
export const INCOMPATIBLE_PROTOCOL_CODE = "incompatible_protocol";

/**
 * Server → client `refuse` frame: the connection is incompatible and the server
 * will close the socket. Mirrors the server's `refuseFrameSchema`.
 */
export const refuseFrameSchema = z.object({
  type: z.literal("refuse"),
  error: z.object({
    code: z.literal(INCOMPATIBLE_PROTOCOL_CODE),
    message: z.string(),
  }),
});

/** A decoded `refuse` frame. */
export type RefuseFrame = z.infer<typeof refuseFrameSchema>;

/** The server's reply to a `hello`: either an accept or a refuse frame. */
export const handshakeReplySchema = z.discriminatedUnion("type", [
  acceptFrameSchema,
  refuseFrameSchema,
]);

/** The outcome of {@link parseHandshakeReply}. */
export type HandshakeReply =
  | { readonly kind: "accept"; readonly frame: AcceptFrame }
  | { readonly kind: "refuse"; readonly frame: RefuseFrame };

/**
 * Parse an untrusted incoming WebSocket message as the server's handshake reply.
 *
 * Returns `null` for anything that is not a valid `accept`/`refuse` frame (bad
 * JSON, wrong shape, or an event frame arriving where a reply was expected) so
 * the caller can treat a non-handshake opener as a protocol violation without
 * throwing — mirroring how {@link ./protocol.ts decodeFrame}'s server-side twin
 * (`parseHello`) tolerates a malformed opener.
 */
export function parseHandshakeReply(raw: string | Uint8Array): HandshakeReply | null {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = handshakeReplySchema.safeParse(json);
  if (!parsed.success) return null;

  return parsed.data.type === "accept"
    ? { kind: "accept", frame: parsed.data }
    : { kind: "refuse", frame: parsed.data };
}
