/**
 * The `pct-client-bridge` orchestrator (#101, Phase 8b).
 *
 * Wires the two halves of the bridge together: the {@link WsClient} holds the
 * outbound event-stream connection and hands each decoded frame to the
 * {@link Dispatcher}, which fans it out to the addressed user's
 * `pct-client-agent` over AF_UNIX. This is the whole data path
 * `docs/client-notifications.md` describes:
 *
 *   dashboard  ──WS /api/events/stream──▶  bridge  ──AF_UNIX /run/pct/<uid>──▶  agent
 *
 * Startup order matters: the per-user sockets must be listening *before* the
 * WebSocket starts delivering frames, so {@link start} binds the dispatcher
 * first and only then opens the stream. Shutdown reverses it — stop reconnects
 * first, then tears the sockets down. The WebSocket's network seams (factory /
 * timers / rng) are forwarded through so the whole bridge is testable end to
 * end with a fake socket and a real in-process AF_UNIX path.
 *
 * License boundary: none touched — composes the dispatch + ws-client modules.
 */
import { socketPathForUid, type BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatch.js";
import type { Logger } from "./logger.js";
import { WsClient, type Timers, type WebSocketFactory } from "./ws-client.js";

/** Injected collaborators for {@link Bridge} (tests override the WS seams). */
export interface BridgeDeps {
  logger: Logger;
  /** Override the WebSocket constructor (defaults to the real `ws`). */
  wsFactory?: WebSocketFactory;
  /** Override the reconnect timer source. */
  timers?: Timers;
  /** Override the backoff jitter RNG. */
  rng?: () => number;
  /** Optional handshake seam fired on each successful connect (ADR-0007, #165). */
  onOpen?: () => void;
}

/** The composed bridge: an event-stream client feeding an AF_UNIX dispatcher. */
export class Bridge {
  readonly #dispatcher: Dispatcher;
  readonly #wsClient: WsClient;
  readonly #logger: Logger;

  constructor(config: BridgeConfig, deps: BridgeDeps) {
    this.#logger = deps.logger;
    this.#dispatcher = new Dispatcher({
      users: config.users,
      socketPath: (linuxUid) => socketPathForUid(config, linuxUid),
      socketMode: config.socketMode,
      logger: deps.logger,
    });
    this.#wsClient = new WsClient({
      url: config.serverUrl,
      token: config.token,
      onFrame: (frame) => this.#dispatcher.dispatch(frame),
      backoff: config.backoff,
      logger: deps.logger,
      ...(deps.wsFactory ? { factory: deps.wsFactory } : {}),
      ...(deps.timers ? { timers: deps.timers } : {}),
      ...(deps.rng ? { rng: deps.rng } : {}),
      ...(deps.onOpen ? { onOpen: deps.onOpen } : {}),
    });
  }

  /** Bind the per-user sockets, then open the event stream. */
  async start(): Promise<void> {
    await this.#dispatcher.start();
    this.#wsClient.start();
    this.#logger.info({}, "pct-client-bridge started");
  }

  /** Stop reconnecting and close the stream, then tear down the sockets. */
  async stop(): Promise<void> {
    this.#wsClient.stop();
    await this.#dispatcher.stop();
    this.#logger.info({}, "pct-client-bridge stopped");
  }

  /** The live dispatcher, for observability in tests. */
  get dispatcher(): Dispatcher {
    return this.#dispatcher;
  }
}
