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
 * not-yet-closed socket), so connections are stored as a set per client and a
 * publish reaches every open one.
 *
 * License boundary: none touched — plain TypeScript.
 */
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
  /** Live connections per `Client.id`. Entries are pruned when a set empties. */
  readonly #byClient = new Map<number, Set<EventSocket>>();
  /** Monotonic sequence stamped onto each published frame. */
  #seq = 0;

  /** Register a client's connection. Idempotent for the same socket. */
  register(clientId: number, socket: EventSocket): void {
    const set = this.#byClient.get(clientId);
    if (set === undefined) {
      this.#byClient.set(clientId, new Set([socket]));
    } else {
      set.add(socket);
    }
  }

  /**
   * Remove a client's connection. Drops the client's entry once its last
   * connection is gone, so {@link isClientLive} reflects reality. A no-op if
   * the socket was never registered.
   */
  unregister(clientId: number, socket: EventSocket): void {
    const set = this.#byClient.get(clientId);
    if (set === undefined) return;
    set.delete(socket);
    if (set.size === 0) this.#byClient.delete(clientId);
  }

  /**
   * Publish an event to every open connection for `clientId`. Returns the
   * number of sockets the frame was written to (0 if the client is offline).
   */
  publishToClient(clientId: number, event: ServerEvent): number {
    const set = this.#byClient.get(clientId);
    if (set === undefined) return 0;
    return this.#send(set, event);
  }

  /**
   * Publish an event to every open connection on every client. Returns the
   * total number of sockets written to. The frame shares one `seq` across all
   * recipients — `seq` identifies the event, not each delivery.
   */
  broadcast(event: ServerEvent): number {
    const frame = this.#frame(event);
    let delivered = 0;
    for (const set of this.#byClient.values()) {
      delivered += this.#write(set, frame);
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
    for (const set of this.#byClient.values()) total += set.size;
    return total;
  }

  /** Stamp + serialize an event, then write it to a set of sockets. */
  #send(set: Set<EventSocket>, event: ServerEvent): number {
    return this.#write(set, this.#frame(event));
  }

  /** Write an already-serialized frame to every open socket in the set. */
  #write(set: Set<EventSocket>, frame: string): number {
    let delivered = 0;
    for (const socket of set) {
      if (socket.readyState !== SOCKET_OPEN) continue;
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
