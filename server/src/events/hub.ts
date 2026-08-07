/**
 * Per-client fan-out registry for the event stream (#100, Phase 8b).
 *
 * {@link EventHub} is the single in-process publish surface the later event
 * *producers* (#99 enforcement, #108 lockout, the Phase-10 grant pipeline)
 * call to reach a connected client's bridge. It tracks the live WebSocket
 * connections keyed by `Client.id` and stamps each published event into a
 * {@link EventFrame} (`seq` + `at`) before sending.
 *
 * It is deliberately decoupled from `ws`: connections are held behind the
 * minimal {@link EventSocket} interface, so the hub unit-tests with plain
 * fakes and the route ({@link ./stream.ts}) supplies the real socket. A client
 * may briefly hold more than one connection (e.g. a reconnect racing a
 * not-yet-closed socket), so connections are stored per client and a publish
 * reaches every open one.
 *
 * **Capability gating (ADR 0007 §4).** Each connection carries the
 * `capabilities` it advertised in its `hello` (threaded in by {@link ./stream.ts}
 * at `accept`). Before writing a frame the hub asks {@link capabilityForEvent}
 * whether the event is gated; a gated frame is withheld from any connection
 * that did not advertise the matching capability — an older or
 * differently-capable client simply never receives a frame it can't honour, and
 * is not disconnected for it. Baseline frames (no required capability) reach
 * every open connection.
 *
 * License boundary: none touched — plain TypeScript.
 */
import { capabilityForEvent } from "./capabilities.js";
import type { ServerEvent } from "./taxonomy.js";

/**
 * The slice of a WebSocket the hub writes to. `readyState === OPEN` (1) gates
 * a send; anything else is skipped (a closing/closed socket is cleaned up by
 * its own close handler, not here).
 */
export interface EventSocket {
  /** WebSocket ready state; {@link EventSocket.OPEN} means writable. */
  readonly readyState: number;
  /** Send one text frame. */
  send(data: string): void;
}

/** The `OPEN` ready-state value (`ws.OPEN` / `WebSocket.OPEN`). */
export const SOCKET_OPEN = 1;

/**
 * The in-process event fan-out registry.
 *
 * One instance is created at app composition and decorated as `app.eventHub`
 * so producers anywhere in the process can publish without re-plumbing.
 */
export class EventHub {
  /**
   * Live connections per `Client.id`, each mapped to the capability set it
   * advertised at `accept`. Entries are pruned when a client's last connection
   * is gone.
   */
  readonly #byClient = new Map<number, Map<EventSocket, ReadonlySet<string>>>();
  /** Monotonic sequence stamped onto each published frame. */
  #seq = 0;

  /**
   * Register a client's connection with the `capabilities` it advertised in its
   * `hello` (ADR 0007 §4). Idempotent for the same socket; re-registering
   * refreshes its capability set. Defaults to an empty set — a connection that
   * advertised nothing receives only ungated (baseline) frames.
   */
  register(clientId: number, socket: EventSocket, capabilities: Iterable<string> = []): void {
    const caps: ReadonlySet<string> = new Set(capabilities);
    const conns = this.#byClient.get(clientId);
    if (conns === undefined) {
      this.#byClient.set(clientId, new Map([[socket, caps]]));
    } else {
      conns.set(socket, caps);
    }
  }

  /**
   * Remove a client's connection. Drops the client's entry once its last
   * connection is gone, so {@link isClientLive} reflects reality. A no-op if
   * the socket was never registered.
   */
  unregister(clientId: number, socket: EventSocket): void {
    const conns = this.#byClient.get(clientId);
    if (conns === undefined) return;
    conns.delete(socket);
    if (conns.size === 0) this.#byClient.delete(clientId);
  }

  /**
   * Publish an event to every open connection for `clientId`. Returns the
   * number of sockets the frame was written to (0 if the client is offline).
   */
  publishToClient(clientId: number, event: ServerEvent): number {
    const conns = this.#byClient.get(clientId);
    if (conns === undefined) return 0;
    return this.#write(conns, this.#frame(event), capabilityForEvent(event));
  }

  /**
   * Publish an event to every open connection on every client. Returns the
   * total number of sockets written to. The frame shares one `seq` across all
   * recipients — `seq` identifies the event, not each delivery.
   */
  broadcast(event: ServerEvent): number {
    const frame = this.#frame(event);
    const required = capabilityForEvent(event);
    let delivered = 0;
    for (const conns of this.#byClient.values()) {
      delivered += this.#write(conns, frame, required);
    }
    return delivered;
  }

  /** Whether at least one connection is currently registered for the client. */
  isClientLive(clientId: number): boolean {
    return this.#byClient.has(clientId);
  }

  /** The `Client.id`s with at least one live connection. */
  liveClientIds(): number[] {
    return [...this.#byClient.keys()];
  }

  /** Total live connections across all clients. */
  get connectionCount(): number {
    let total = 0;
    for (const conns of this.#byClient.values()) total += conns.size;
    return total;
  }

  /**
   * Write an already-serialized frame to every open connection whose advertised
   * capabilities satisfy `required` (`null` = ungated, so it reaches all).
   * A closing/closed socket is skipped (its close handler cleans it up).
   */
  #write(
    conns: Map<EventSocket, ReadonlySet<string>>,
    frame: string,
    required: string | null,
  ): number {
    let delivered = 0;
    for (const [socket, caps] of conns) {
      if (socket.readyState !== SOCKET_OPEN) continue;
      if (required !== null && !caps.has(required)) continue;
      socket.send(frame);
      delivered += 1;
    }
    return delivered;
  }

  /** Build the JSON wire frame for an event, assigning the next `seq`. */
  #frame(event: ServerEvent): string {
    this.#seq += 1;
    return JSON.stringify({ seq: this.#seq, at: new Date().toISOString(), event });
  }
}
