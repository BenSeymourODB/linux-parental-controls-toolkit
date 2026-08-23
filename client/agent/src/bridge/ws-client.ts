/**
 * The bridge's outbound event-stream WebSocket client (#101, Phase 8b).
 *
 * Holds the single long-lived, **client-initiated** connection to the
 * dashboard's `GET /api/events/stream` (`docs/client-notifications.md`):
 * authenticated with the per-client enrolment bearer token, decoding each
 * inbound frame and handing it to a callback, and **reconnecting with
 * exponential backoff** whenever the socket drops. Outbound-only because the
 * client is typically behind NAT.
 *
 * ## Version handshake (ADR 0007, #303)
 *
 * On every (re)connect the bridge **speaks first**: it sends a `hello`
 * (`agentVersion`, `eventProtocol`, `capabilities`) and forwards **no** event
 * frames to {@link WsClientOptions.onFrame} until the server's `accept`. The
 * server always sends its `accept`/`refuse` as the first message (before it
 * starts the event fan-out), so the first inbound message is treated as the
 * handshake reply and everything after it as an event frame.
 *
 * - `accept` → the stream proceeds in the agreed dialect.
 * - `refuse` (`code: "incompatible_protocol"`) → the server closes the socket;
 *   the bridge surfaces the `update_required` condition (via
 *   {@link WsClientOptions.onRefuse}) and **stops reconnecting**, since retrying
 *   the same protocol against the same server cannot succeed until the agent is
 *   updated (ADR 0007 §2, §5).
 * - A bounded {@link WsClientOptions.handshakeTimeoutMs} closes and reconnects
 *   if no reply arrives (backstop for a server that never replies).
 *
 * Liveness (post-accept) is the standard `ws` ping/pong: the server pings
 * (`server/src/events/heartbeat.ts`) and the `ws` runtime auto-replies with a
 * pong, so the bridge needs no heartbeat logic of its own — a dead peer is
 * surfaced to us as a `close`, which drives the reconnect.
 *
 * The actual `WebSocket` is created through an injected {@link WebSocketFactory}
 * so the lifecycle (open → hello → accept → frames → close → backoff →
 * reconnect) is unit-tested with a fake socket and no network. A malformed event
 * frame is logged and dropped — one poison frame must never tear down the
 * connection.
 *
 * License boundary: none touched — `ws` (MIT) behind an injected factory.
 */
import { WebSocket } from "ws";

import { computeBackoffDelayMs, type BackoffOptions } from "./backoff.js";
import {
  BRIDGE_CAPABILITIES,
  buildHello,
  parseHandshakeReply,
  type AcceptFrame,
  type RefuseFrame,
} from "./handshake.js";
import type { Logger } from "./logger.js";
import { decodeFrame, FrameDecodeError, type EventFrame } from "./protocol.js";

/** Raw message payloads `ws` can deliver. */
type RawMessage = string | Buffer | ArrayBuffer | Buffer[];

/** The minimal slice of a WebSocket {@link WsClient} drives (injectable). */
export interface WebSocketLike {
  on(event: "open" | "close", listener: () => void): unknown;
  on(event: "message", listener: (data: RawMessage) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  /** Send a text frame (the opening `hello`). */
  send(data: string): void;
  /** Begin a clean close handshake. */
  close(): void;
  /** Forcibly drop the socket (used on stop()). */
  terminate(): void;
}

/** Creates a connection to `url` with the given headers (e.g. the bearer auth). */
export type WebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocketLike;

/** A `setTimeout`/`clearTimeout` pair, injectable for deterministic tests. */
export interface Timers {
  set(handler: () => void, ms: number): { unref?: () => void };
  clear(handle: { unref?: () => void }): void;
}

const defaultTimers: Timers = {
  set: (handler, ms) => setTimeout(handler, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const defaultFactory: WebSocketFactory = (url, options) => new WebSocket(url, options);

/**
 * How long to wait for the server's `accept`/`refuse` after sending `hello`
 * before closing and reconnecting. Above the server's own hello-timeout (10s,
 * `server/src/events/stream.ts`), so in the normal too-slow case the server's
 * close drives the reconnect and this is only the backstop for a server that
 * accepts internally but never replies.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

/** Options for {@link WsClient}. */
export interface WsClientOptions {
  /** Dashboard event-stream URL (`ws(s)://…/api/events/stream`). */
  url: string;
  /** Per-client bearer token sent as `Authorization: Bearer <token>`. */
  token: string;
  /** The `pct-client` agent version advertised in `hello` (refreshes the inventory). */
  agentVersion: string;
  /** Called with each decoded, validated event frame (only after `accept`). */
  onFrame: (frame: EventFrame) => void;
  backoff: BackoffOptions;
  logger: Logger;
  /** Capabilities advertised in `hello` (defaults to {@link BRIDGE_CAPABILITIES}). */
  capabilities?: readonly string[];
  /** Protocol version advertised in `hello` (defaults to the handshake module's). */
  eventProtocol?: number;
  /** Fired when the server accepts the handshake. */
  onAccept?: (frame: AcceptFrame) => void;
  /**
   * Fired when the server refuses the handshake as incompatible. The bridge has
   * already stopped reconnecting; the hook surfaces the `update_required`
   * condition (ADR 0007 §5).
   */
  onRefuse?: (frame: RefuseFrame) => void;
  /** How long to wait for the handshake reply (defaults to {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}). */
  handshakeTimeoutMs?: number;
  /** Optional hook fired on each successful socket open (before `hello` is sent). */
  onOpen?: () => void;
  /** Override the WebSocket constructor (tests inject a fake). */
  factory?: WebSocketFactory;
  /** Override the timer source (tests inject a controllable one). */
  timers?: Timers;
  /** Override the jitter RNG (tests inject a deterministic one). */
  rng?: () => number;
}

/**
 * Manages the event-stream connection: connect, run the version handshake,
 * decode-and-forward frames, and reconnect with backoff on every drop until
 * {@link stop} is called (or the server refuses the handshake as incompatible).
 */
export class WsClient {
  readonly #options: WsClientOptions;
  readonly #factory: WebSocketFactory;
  readonly #timers: Timers;
  readonly #rng: () => number;
  readonly #handshakeTimeoutMs: number;

  #socket: WebSocketLike | null = null;
  #reconnectTimer: { unref?: () => void } | null = null;
  #handshakeTimer: { unref?: () => void } | null = null;
  #attempt = 0;
  #stopped = false;
  /** True once the server has refused this bridge's protocol; suppresses reconnect. */
  #refused = false;
  /** True between sending `hello` and receiving the `accept`/`refuse` reply. */
  #awaitingHandshake = false;

  constructor(options: WsClientOptions) {
    this.#options = options;
    this.#factory = options.factory ?? defaultFactory;
    this.#timers = options.timers ?? defaultTimers;
    this.#rng = options.rng ?? Math.random;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  /**
   * Open the connection. Subsequent drops reconnect automatically. Safe to call
   * again after {@link stop} or a refuse to restart; if called while a reconnect
   * is already pending it cancels that pending attempt first so a restart never
   * leaves two connect loops racing.
   */
  start(): void {
    this.#stopped = false;
    this.#refused = false;
    if (this.#reconnectTimer !== null) {
      this.#timers.clear(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#connect();
  }

  /** Stop reconnecting and close the current socket. Idempotent. */
  stop(): void {
    this.#stopped = true;
    this.#clearHandshakeTimer();
    if (this.#reconnectTimer !== null) {
      this.#timers.clear(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.terminate();
    this.#socket = null;
  }

  #connect(): void {
    this.#reconnectTimer = null;
    this.#awaitingHandshake = false;
    const socket = this.#factory(this.#options.url, {
      headers: { Authorization: `Bearer ${this.#options.token}` },
    });
    this.#socket = socket;

    socket.on("open", () => {
      this.#attempt = 0;
      this.#options.logger.info({ url: this.#options.url }, "event stream connected");
      this.#options.onOpen?.();
      this.#sendHello(socket);
    });

    socket.on("message", (data) => this.#onMessage(data));

    socket.on("error", (err) => {
      // `ws` emits `close` after `error`, so reconnect is scheduled there; here
      // we only record the cause so a refused/dropped connect is diagnosable.
      this.#options.logger.warn({ err }, "event stream error");
    });

    socket.on("close", () => {
      this.#socket = null;
      this.#clearHandshakeTimer();
      this.#awaitingHandshake = false;
      if (this.#stopped || this.#refused) return;
      this.#scheduleReconnect();
    });
  }

  /** Speak first: send `hello` and await the server's `accept`/`refuse`. */
  #sendHello(socket: WebSocketLike): void {
    const hello = buildHello({
      agentVersion: this.#options.agentVersion,
      ...(this.#options.eventProtocol !== undefined
        ? { eventProtocol: this.#options.eventProtocol }
        : {}),
      capabilities: this.#options.capabilities ?? BRIDGE_CAPABILITIES,
    });
    this.#awaitingHandshake = true;
    socket.send(JSON.stringify(hello));
    this.#options.logger.info(
      { eventProtocol: hello.eventProtocol, capabilities: hello.capabilities },
      "sent event-stream hello",
    );
    const handle = this.#timers.set(() => this.#onHandshakeTimeout(), this.#handshakeTimeoutMs);
    handle.unref?.();
    this.#handshakeTimer = handle;
  }

  #onMessage(data: RawMessage): void {
    if (this.#awaitingHandshake) {
      this.#onHandshakeReply(data);
      return;
    }
    let frame: EventFrame;
    try {
      frame = decodeFrame(toFrameInput(data));
    } catch (err) {
      if (err instanceof FrameDecodeError) {
        this.#options.logger.warn({ err }, "dropping undecodable frame");
        return;
      }
      throw err;
    }
    this.#options.onFrame(frame);
  }

  #onHandshakeReply(data: RawMessage): void {
    const reply = parseHandshakeReply(toFrameInput(data));

    if (reply === null) {
      // The server should send accept/refuse first; anything else pre-handshake
      // is a protocol violation. Close and reconnect (with backoff) rather than
      // forwarding a frame we can't trust the negotiation for.
      this.#clearHandshakeTimer();
      this.#awaitingHandshake = false;
      this.#options.logger.warn({}, "unexpected pre-handshake frame; closing to retry");
      this.#socket?.close();
      return;
    }

    this.#clearHandshakeTimer();
    this.#awaitingHandshake = false;

    if (reply.kind === "refuse") {
      this.#refused = true;
      this.#options.logger.error(
        { code: reply.frame.error.code, message: reply.frame.error.message },
        "event-stream handshake refused; client update required — not reconnecting",
      );
      this.#options.onRefuse?.(reply.frame);
      // The server closes the socket on refuse; terminate defensively so we do
      // not linger if it does not, and the close handler (with #refused set) will
      // not reconnect.
      this.#socket?.terminate();
      this.#socket = null;
      return;
    }

    this.#options.logger.info(
      { eventProtocol: reply.frame.eventProtocol, apiVersion: reply.frame.apiVersion },
      "event-stream handshake accepted",
    );
    this.#options.onAccept?.(reply.frame);
  }

  #onHandshakeTimeout(): void {
    if (!this.#awaitingHandshake) return;
    this.#handshakeTimer = null;
    this.#awaitingHandshake = false;
    this.#options.logger.warn({}, "no handshake reply before timeout; closing to retry");
    // Close → the close handler schedules a backoff reconnect.
    this.#socket?.close();
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer !== null) {
      this.#timers.clear(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
  }

  #scheduleReconnect(): void {
    const delay = computeBackoffDelayMs(this.#attempt, this.#options.backoff, this.#rng);
    this.#attempt += 1;
    this.#options.logger.info(
      { attempt: this.#attempt, delayMs: delay },
      "scheduling event stream reconnect",
    );
    const handle = this.#timers.set(() => {
      if (!this.#stopped && !this.#refused) this.#connect();
    }, delay);
    // Don't let a pending reconnect keep the process alive on its own.
    handle.unref?.();
    this.#reconnectTimer = handle;
  }
}

/** Normalise a `ws` message payload into what {@link decodeFrame} accepts. */
function toFrameInput(data: RawMessage): string | Uint8Array {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
