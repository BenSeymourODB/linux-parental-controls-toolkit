/**
 * Event-stream version-compatibility contract (#165, Phase 8b).
 *
 * The pure, I/O-free core of ADR 0007 (event-stream + API version
 * compatibility): the `eventProtocol` integer, the `hello`/`accept`/`refuse`
 * handshake frame schemas, and the total {@link negotiate} decision the stream
 * route ({@link ./stream.ts}) runs on every connect. Isolating the decision
 * here — mirroring `policy/budget-window.ts` and `policy/schedule-precedence.ts`
 * — keeps the N-1 window logic testable with zero I/O and keeps the route a thin
 * transport wrapper around it.
 *
 * Why a separate version axis from `/api/meta`'s `apiVersion`: the JSON API and
 * the WebSocket frame envelope break on different schedules, so each gets its
 * own integer governed by the same "additive doesn't bump, breaking does" rule
 * (ADR 0007 §1). This module owns the **event-protocol** axis.
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

import { API_VERSION } from "../api/version.js";

/**
 * The frame-envelope/handshake protocol version this server speaks (ADR 0007
 * §1). A **positive integer**, bumped only on a *breaking* change to the frame
 * envelope or the handshake itself (additive changes — a new event type, a new
 * optional field, a new capability — never bump it; they ride on
 * {@link helloFrameSchema}'s `capabilities`, §4).
 */
export const EVENT_PROTOCOL = 1;

/**
 * Default backward-compatibility window: how many protocol versions *below* the
 * server's own the handshake still accepts (ADR 0007 §3). `1` is the historical
 * N-1 window. Operators can widen it via `PCT_PROTOCOL_COMPAT_WINDOW`
 * (`config.ts`), which threads through {@link negotiate} — the single source of
 * truth for when a client is refused as `client_too_old` (and thereby flagged
 * `update_required`, the admin-facing "must update" signal).
 */
export const DEFAULT_COMPAT_WINDOW = 1;

/**
 * Client → server opening frame, sent first on every (re)connect (ADR 0007 §2).
 * `capabilities` is an order-independent, additively-extensible flag set naming
 * the optional frame types / enforcement primitives the client supports.
 */
export const helloFrameSchema = z.object({
  type: z.literal("hello"),
  /** The `pct-client` agent `.deb` version (refreshes the live inventory, §164). */
  agentVersion: z.string().min(1).max(100),
  /** The integer frame-protocol version the client speaks. */
  eventProtocol: z.number().int().positive(),
  /** Additive feature flags the client supports (§4); unknown flags are ignored. */
  capabilities: z.array(z.string().min(1).max(100)).max(64).default([]),
});

/** A decoded client `hello`. */
export type HelloFrame = z.infer<typeof helloFrameSchema>;

/**
 * Server → client `accept` frame: the stream proceeds in the agreed dialect.
 * `eventProtocol` is the dialect the server will *speak* on this connection
 * (the client's version when within the window — i.e. `P` or `P−1`), so the
 * client knows whether it is getting the current or the N-1 dialect.
 */
export const acceptFrameSchema = z.object({
  type: z.literal("accept"),
  /** The agreed frame dialect (`P` or `P−1`). */
  eventProtocol: z.number().int().positive(),
  /** The JSON-contract version, so a client reads both axes from the handshake. */
  apiVersion: z.number().int().positive(),
});

export type AcceptFrame = z.infer<typeof acceptFrameSchema>;

/** The single refusal code (reuses the `/api/*` error-envelope vocabulary, §2). */
export const INCOMPATIBLE_PROTOCOL_CODE = "incompatible_protocol";

/**
 * Server → client `refuse` frame: the connection is incompatible and the server
 * will close the socket. Carries the standard error-envelope `{ code, message }`
 * — no second error shape is introduced (ADR 0007 §2).
 */
export const refuseFrameSchema = z.object({
  type: z.literal("refuse"),
  error: z.object({
    code: z.literal(INCOMPATIBLE_PROTOCOL_CODE),
    message: z.string(),
  }),
});

export type RefuseFrame = z.infer<typeof refuseFrameSchema>;

/** Why a `hello` was refused — drives the server's follow-up bookkeeping. */
export type RefusalReason =
  /** `eventProtocol < P − 1`: client too old → flag `update_required` (§5). */
  | "client_too_old"
  /** `eventProtocol > P`: server is behind the client ("upgrade server first" broken). */
  | "server_too_old"
  /** Missing/unparseable `hello`: the server never assumes a dialect (§2). */
  | "malformed_hello";

/** The outcome of {@link negotiate}: accept in a dialect, or refuse with a reason. */
export type NegotiationResult =
  | { readonly kind: "accept"; readonly frame: AcceptFrame }
  | { readonly kind: "refuse"; readonly reason: RefusalReason; readonly frame: RefuseFrame };

/** Build the `refuse` outcome for `reason` with a secret-free message. */
function refuse(reason: RefusalReason, message: string): NegotiationResult {
  return {
    kind: "refuse",
    reason,
    frame: { type: "refuse", error: { code: INCOMPATIBLE_PROTOCOL_CODE, message } },
  };
}

/**
 * Decide whether to accept a client `hello` and in which dialect, per the
 * backward-compatibility window (ADR 0007 §3), against the given server protocol
 * (defaults to {@link EVENT_PROTOCOL}; injectable for tests). `compatWindow` is
 * how many versions below the server the window reaches (defaults to
 * {@link DEFAULT_COMPAT_WINDOW}; the deployment sets it from
 * `PCT_PROTOCOL_COMPAT_WINDOW`).
 *
 * - `hello` is `null`/unparseable → refuse `malformed_hello` (never assume a
 *   dialect).
 * - `eventProtocol === P` → accept, current dialect.
 * - `P − compatWindow ≤ eventProtocol < P` → accept in the client's (older)
 *   dialect (the server withholds frame types introduced by the newer bumps;
 *   that withholding is the stream's job, this returns the agreed dialect
 *   integer).
 * - `eventProtocol < P − compatWindow` → refuse `client_too_old` (→
 *   `update_required`).
 * - `eventProtocol > P` → refuse `server_too_old`.
 *
 * Total and pure: it never throws and performs no I/O.
 */
export function negotiate(
  hello: HelloFrame | null,
  serverProtocol: number = EVENT_PROTOCOL,
  apiVersion: number = API_VERSION,
  compatWindow: number = DEFAULT_COMPAT_WINDOW,
): NegotiationResult {
  if (hello === null) {
    return refuse("malformed_hello", "Missing or unparseable hello frame");
  }

  // A window narrower than 1 would be meaningless (it could refuse a client
  // speaking the server's own protocol); clamp defensively even though the
  // config schema already enforces a positive integer.
  const window = Math.max(1, Math.trunc(compatWindow));
  const oldestAccepted = serverProtocol - window;
  const client = hello.eventProtocol;

  if (client > serverProtocol) {
    return refuse(
      "server_too_old",
      `Server speaks eventProtocol ${serverProtocol}; client requires ${client}. Upgrade the server.`,
    );
  }
  if (client >= oldestAccepted) {
    return {
      kind: "accept",
      frame: { type: "accept", eventProtocol: client, apiVersion },
    };
  }
  return refuse(
    "client_too_old",
    `Client eventProtocol ${client} is older than the supported window (${oldestAccepted}–${serverProtocol}); update the client.`,
  );
}

/**
 * Parse an untrusted incoming WebSocket text frame as a {@link HelloFrame},
 * returning `null` for anything that is not a valid hello (bad JSON, wrong
 * shape, wrong `type`). The caller feeds the `null` straight into
 * {@link negotiate}, which refuses it — so a malformed opener can never crash
 * the connection handler.
 */
export function parseHello(raw: string): HelloFrame | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = helloFrameSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
