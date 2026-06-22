/**
 * WebSocket keepalive for the long-lived event stream (#100, Phase 8b).
 *
 * The bridge connection is outbound and long-lived (it sits open through home
 * NAT for hours), so a half-open socket — peer gone, no TCP FIN seen — would
 * otherwise linger in the {@link ./hub.ts EventHub} forever and the dashboard
 * would wrongly think the client is "live". {@link startHeartbeat} runs the
 * standard ws ping/pong liveness check: each interval, if the previous ping
 * was not answered with a pong, the peer is presumed dead and the socket is
 * `terminate()`d (which fires `close`, so the route's cleanup unregisters it);
 * otherwise it arms the next ping.
 *
 * The logic is isolated from the network here (over the minimal
 * {@link HeartbeatSocket} interface) so it unit-tests deterministically with
 * fake timers; the route wires `socket.on("pong", …)` to {@link HeartbeatHandle.onPong}.
 *
 * License boundary: none touched — plain TypeScript + `node:timers`.
 */

/** The slice of a WebSocket the heartbeat drives. */
export interface HeartbeatSocket {
  /** Send a ping frame; the peer's stack answers with a pong. */
  ping(): void;
  /** Forcibly close the underlying socket (no close handshake). */
  terminate(): void;
}

/** Controls a running heartbeat. */
export interface HeartbeatHandle {
  /** Record that a pong arrived, marking the peer alive for this interval. */
  onPong(): void;
  /** Stop the heartbeat and release its timer. Idempotent. */
  stop(): void;
}

/** Default ping interval: 30s, matching common ws keepalive guidance. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Start pinging `socket` every `intervalMs`. A peer that misses one full
 * interval without a pong is `terminate()`d. The returned handle's `onPong`
 * must be called from the socket's `pong` listener, and `stop` from its
 * `close` listener.
 *
 * The interval timer is `unref()`d so a forgotten heartbeat can never keep the
 * Node process alive on its own.
 */
export function startHeartbeat(socket: HeartbeatSocket, intervalMs: number): HeartbeatHandle {
  // The peer starts assumed-alive: it has just completed the WS handshake.
  let alive = true;

  const timer = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, intervalMs);
  // Best-effort: not all timer impls expose unref (e.g. some fakes).
  timer.unref?.();

  return {
    onPong(): void {
      alive = true;
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
