/**
 * Unit tests for the WebSocket keepalive (#100), driven with fake timers over
 * a fake socket: a ping each interval, termination after a missed pong, pong
 * keeping the peer alive, and stop releasing the timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startHeartbeat, type HeartbeatSocket } from "../../src/events/heartbeat.js";

class FakeSocket implements HeartbeatSocket {
  pings = 0;
  terminated = false;
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe("startHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pings each interval and terminates a peer that misses a pong", () => {
    const socket = new FakeSocket();
    const hb = startHeartbeat(socket, 1000);

    // First interval: peer was alive (just connected) → ping, mark not-alive.
    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(1);
    expect(socket.terminated).toBe(false);

    // Second interval with no pong in between → terminate, no further ping.
    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(1);
    expect(socket.terminated).toBe(true);

    hb.stop();
  });

  it("keeps a peer alive while pongs arrive", () => {
    const socket = new FakeSocket();
    const hb = startHeartbeat(socket, 1000);

    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(1);
    hb.onPong(); // peer answered

    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(2);
    expect(socket.terminated).toBe(false);

    hb.stop();
  });

  it("stops pinging once stopped", () => {
    const socket = new FakeSocket();
    const hb = startHeartbeat(socket, 1000);
    hb.stop();
    vi.advanceTimersByTime(5000);
    expect(socket.pings).toBe(0);
    expect(socket.terminated).toBe(false);
  });
});
