/**
 * The agent's inbound AF_UNIX reader (#103, Phase 8b).
 *
 * `docs/client-notifications.md`: the per-user agent "Subscribes to its own
 * socket from the bridge (`/run/pct/<uid>.sock`) for server-pushed events." The
 * bridge is the socket **owner/listener** (`bridge/dispatch.ts`) and writes
 * **newline-delimited JSON `EventFrame`s**; this client connects in, splits the
 * stream on newlines, validates each frame with the shared `decodeFrame`, and
 * hands the decoded {@link ServerEvent} to a callback. It reconnects with the
 * package's full-jitter backoff whenever the bridge restarts or the socket
 * drops — the mirror of the bridge's own outbound `ws-client.ts`.
 *
 * The socket is created through an injected {@link SocketFactory} and timers
 * through the injected {@link Scheduler}, so the connect → frames → close →
 * reconnect lifecycle unit-tests with a fake socket and, end-to-end, against a
 * real in-process bridge `Dispatcher`. A malformed frame is logged and dropped
 * so one poison line never tears down the connection.
 *
 * License boundary: none touched — `node:net` + the shared zod frame decoder.
 */
import net from "node:net";

import { computeBackoffDelayMs, type BackoffOptions } from "../bridge/backoff.js";
import type { Logger } from "../bridge/logger.js";
import { decodeFrame, FrameDecodeError, type ServerEvent } from "../bridge/protocol.js";
import type { Scheduler, TimerHandle } from "./scheduler.js";

/** The minimal slice of a connected socket {@link AgentSocketClient} drives. */
export interface SocketLike {
  on(event: "connect" | "close", listener: () => void): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  /** Drop the socket (used on stop and before a reconnect). */
  destroy(): void;
}

/** Opens a connection to the given AF_UNIX path. */
export type SocketFactory = (path: string) => SocketLike;

const defaultFactory: SocketFactory = (path) => net.connect(path);

/** Options for {@link AgentSocketClient}. */
export interface AgentSocketClientOptions {
  /** AF_UNIX path the bridge listens on for this user. */
  socketPath: string;
  /** Called with each decoded, validated server event. */
  onEvent: (event: ServerEvent) => void;
  backoff: BackoffOptions;
  scheduler: Scheduler;
  logger: Logger;
  /** Override the socket constructor (tests inject a fake). */
  factory?: SocketFactory;
  /** Override the jitter RNG (tests inject a deterministic one). */
  rng?: () => number;
}

/** Newline that delimits frames on the bridge socket (see `bridge/dispatch.ts`). */
const FRAME_DELIMITER = "\n";

/**
 * Connects to the bridge's per-user socket, decodes newline-delimited frames,
 * and reconnects with backoff on every drop until {@link stop} is called.
 */
export class AgentSocketClient {
  readonly #options: AgentSocketClientOptions;
  readonly #factory: SocketFactory;
  readonly #rng: () => number;

  #socket: SocketLike | null = null;
  #reconnectTimer: TimerHandle | null = null;
  #buffer = "";
  #attempt = 0;
  #stopped = false;

  constructor(options: AgentSocketClientOptions) {
    this.#options = options;
    this.#factory = options.factory ?? defaultFactory;
    this.#rng = options.rng ?? Math.random;
  }

  /** Open the connection. Subsequent drops reconnect automatically. */
  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  /** Stop reconnecting and drop the current socket. Idempotent. */
  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer !== null) {
      this.#options.scheduler.cancel(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.destroy();
    this.#socket = null;
    this.#buffer = "";
  }

  #connect(): void {
    this.#reconnectTimer = null;
    this.#buffer = "";
    const socket = this.#factory(this.#options.socketPath);
    this.#socket = socket;

    socket.on("connect", () => {
      this.#attempt = 0;
      this.#options.logger.info({ path: this.#options.socketPath }, "bridge socket connected");
    });
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (err) => {
      this.#options.logger.warn({ err }, "bridge socket error");
    });
    socket.on("close", () => {
      this.#socket = null;
      if (this.#stopped) return;
      this.#scheduleReconnect();
    });
  }

  #onData(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    let index = this.#buffer.indexOf(FRAME_DELIMITER);
    while (index !== -1) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim() !== "") this.#handleLine(line);
      index = this.#buffer.indexOf(FRAME_DELIMITER);
    }
  }

  #handleLine(line: string): void {
    try {
      const frame = decodeFrame(line);
      this.#options.onEvent(frame.event);
    } catch (err) {
      if (err instanceof FrameDecodeError) {
        this.#options.logger.warn({ err }, "dropping undecodable frame");
        return;
      }
      throw err;
    }
  }

  #scheduleReconnect(): void {
    const delay = computeBackoffDelayMs(this.#attempt, this.#options.backoff, this.#rng);
    this.#attempt += 1;
    this.#options.logger.info(
      { attempt: this.#attempt, delayMs: delay },
      "scheduling bridge socket reconnect",
    );
    this.#reconnectTimer = this.#options.scheduler.timeout(() => {
      if (!this.#stopped) this.#connect();
    }, delay);
  }
}
