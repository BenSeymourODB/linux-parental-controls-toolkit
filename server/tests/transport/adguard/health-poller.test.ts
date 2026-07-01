/**
 * Unit tests for the managed-mode AdGuard health poller (#283). The cron
 * schedule itself isn't fired — `tick()` (the same function each cron tick
 * invokes) is driven directly, so the probe→transition-log behaviour and the
 * start/stop lifecycle are exercised deterministically against a fake service.
 */
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { DnsHealth, DnsStatus } from "../../../src/transport/adguard/index.js";
import {
  DEFAULT_ADGUARD_HEALTH_POLL_PATTERN,
  startAdGuardHealthPoll,
  type PollableAdGuardService,
} from "../../../src/transport/adguard/index.js";

const ENDPOINT = "http://127.0.0.1:3000";

/** A managed `DnsStatus` at a given health. */
function status(health: DnsHealth, detail: string | null = null): DnsStatus {
  return {
    mode: "managed",
    configured: health === "ok" || health === "unhealthy",
    health,
    baseUrl: ENDPOINT,
    checkedAt: "2026-06-23T12:00:00.000Z",
    detail,
  };
}

/**
 * A service whose `status` seeds the baseline and whose `runPreflight` returns
 * the next status from a scripted sequence (the last entry repeats).
 */
function fakeService(initial: DnsStatus, sequence: DnsStatus[]): PollableAdGuardService {
  let i = 0;
  return {
    get status() {
      return initial;
    },
    runPreflight: vi.fn(() => {
      const next = sequence[Math.min(i, sequence.length - 1)] ?? initial;
      i += 1;
      return Promise.resolve(next);
    }),
  };
}

/** A recording logger whose `child` returns itself so the poller's lines land here. */
function recordingLogger(): FastifyBaseLogger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const logger = {
    level: "info",
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child() {
      return logger;
    },
  };
  return logger;
}

describe("startAdGuardHealthPoll", () => {
  it("exposes the default 30-second cadence", () => {
    expect(DEFAULT_ADGUARD_HEALTH_POLL_PATTERN).toBe("*/30 * * * * *");
  });

  it("re-probes the service on each tick", async () => {
    const service = fakeService(status("unknown"), [status("ok")]);
    const poll = startAdGuardHealthPoll({ service, log: recordingLogger() });
    await poll.tick();
    await poll.tick();
    expect(service.runPreflight).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("logs at info when health transitions to ok", async () => {
    const log = recordingLogger();
    const service = fakeService(status("unknown"), [status("ok")]);
    const poll = startAdGuardHealthPoll({ service, log });
    await poll.tick();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    poll.stop();
  });

  it("logs at error (with the status detail) when health degrades", async () => {
    const log = recordingLogger();
    const service = fakeService(status("ok"), [status("unreachable", "instance is stopped")]);
    const poll = startAdGuardHealthPoll({ service, log });
    await poll.tick();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[1]).toBe("instance is stopped");
    poll.stop();
  });

  it("logs only on transitions, not every tick", async () => {
    const log = recordingLogger();
    const service = fakeService(status("unknown"), [status("ok"), status("ok"), status("ok")]);
    const poll = startAdGuardHealthPoll({ service, log });
    await poll.tick(); // unknown → ok: one info
    await poll.tick(); // ok → ok: silent
    await poll.tick(); // ok → ok: silent
    expect(log.info).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("re-logs when health flaps back to a bad state", async () => {
    const log = recordingLogger();
    const service = fakeService(status("ok"), [status("unreachable"), status("ok")]);
    const poll = startAdGuardHealthPoll({ service, log });
    await poll.tick(); // ok → unreachable: error
    await poll.tick(); // unreachable → ok: info
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("stop() is safe to call (and idempotent)", () => {
    const poll = startAdGuardHealthPoll({
      service: fakeService(status("unknown"), [status("ok")]),
      log: recordingLogger(),
    });
    expect(() => {
      poll.stop();
      poll.stop();
    }).not.toThrow();
  });
});
