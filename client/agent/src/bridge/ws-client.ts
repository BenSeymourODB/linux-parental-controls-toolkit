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
 * Liveness is the standard `ws` ping/pong: the server pings
 * (`server/src/events/heartbeat.ts`) and the `ws` runtime auto-replies with a
 * pong, so the bridge needs no heartbeat logic of its own — a dead peer is
 * surfaced to us as a `close`, which drives the reconnect.
 *
 * The actual `WebSocket` is created through an injected {@link WebSocketFactory}
 * so the lifecycle (open → frames → close → backoff → reconnect) is unit-tested
 * with a fake socket and no network. A malformed frame is logged and dropped —
 * one poison frame must never tear down the connection.
 *
 * Deferred: the ADR-0007 `hello`/`accept`/`refuse` version handshake. Its
 * server side + shared schemas land with #165 (PR #286); {@link WsClient}
 * exposes the {@link WsClientOptions.onOpen} seam where it will slot in. Against
 * `main`'s current handshake-less stream the connection proceeds straight to
 * frames.
 *
 * License boundary: none touched — `ws` (MIT) behind an injected factory.
 */
import { WebSocket } from "ws";

import { computeBackoffDelayMs, type BackoffOptions } from "./backoff.js";
import type { Logger } from "./logger.js";
import { decodeFrame, FrameDecodeError, type EventFrame } from "./protocol.js";

/** Raw message payloads `ws` can deliver. */
type RawMessage = string | Buffer | ArrayBuffer | Buffer[];

/** The minimal slice of a WebSocket {@link WsClient} drives (injectable). */
export interface WebSocketLike {
  on(event: "open" | "close", listener: () => void): unknown;
  on(event: "message", listener: (data: RawMessage) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
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

/** Options for {@link WsClient}. */
export interface WsClientOptions {
  /** Dashboard event-stream URL (`ws(s)://…/api/events/stream`). */
  url: string;
  /** Per-client bearer token sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Called with each decoded, validated frame. */
  onFrame: (frame: EventFrame) => void;
  backoff: BackoffOptions;
  logger: Logger;
  /** Optional hook fired on each successful open (the handshake seam). */
  onOpen?: () => void;
  /** Override the WebSocket constructor (tests inject a fake). */
  factory?: WebSocketFactory;
  /** Override the timer source (tests inject a controllable one). */
  timers?: Timers;
  /** Override the jitter RNG (tests inject a deterministic one). */
  rng?: () => number;
}

/**
 * Manages the event-stream connection: connect, decode-and-forward frames, and
 * reconnect with backoff on every drop until {@link stop} is called.
 */
export class WsClient {
  readonly #options: WsClientOptions;
  readonly #factory: WebSocketFactory;
  readonly #timers: Timers;
  readonly #rng: () => number;

  #socket: WebSocketLike | null = null;
  #reconnectTimer: { unref?: () => void } | null = null;
  #attempt = 0;
  #stopped = false;

  constructor(options: WsClientOptions) {
    this.#options = options;
    this.#factory = options.factory ?? defaultFactory;
    this.#timers = options.timers ?? defaultTimers;
    this.#rng = options.rng ?? Math.random;
  }

  /** Open the connection. Subsequent drops reconnect automatically. */
  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  /** Stop reconnecting and close the current socket. Idempotent. */
  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer !== null) {
      this.#timers.clear(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.terminate();
    this.#socket = null;
  }

  #connect(): void {
    this.#reconnectTimer = null;
    const socket = this.#factory(this.#options.url, {
      headers: { Authorization: `Bearer ${this.#options.token}` },
    });
    this.#socket = socket;

    socket.on("open", () => {
      this.#attempt = 0;
      this.#options.logger.info({ url: this.#options.url }, "event stream connected");
      this.#options.onOpen?.();
    });

    socket.on("message", (data) => this.#onMessage(data));

    socket.on("error", (err) => {
      // `ws` emits `close` after `error`, so reconnect is scheduled there; here
      // we only record the cause so a refused/dropped connect is diagnosable.
      this.#options.logger.warn({ err }, "event stream error");
    });

    socket.on("close", () => {
      this.#socket = null;
      if (this.#stopped) return;
      this.#scheduleReconnect();
    });
  }

  #onMessage(data: RawMessage): void {
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

  #scheduleReconnect(): void {
    const delay = computeBackoffDelayMs(this.#attempt, this.#options.backoff, this.#rng);
    this.#attempt += 1;
    this.#options.logger.info(
      { attempt: this.#attempt, delayMs: delay },
      "scheduling event stream reconnect",
    );
    const handle = this.#timers.set(() => {
      if (!this.#stopped) this.#connect();
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
