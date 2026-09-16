/**
 * Unit tests for the Phase-5 telemetry pull (#86): the bounded-concurrency
 * pass that opens a port-forward per client, the croner schedule wrapper, and
 * the cron-pattern validator. The SSH facade is replaced with a fake forwarder
 * (the real `withPortForward` is covered in `../ssh/facade.test.ts`); the
 * default consumer's liveness probe runs against a real loopback HTTP server.
 */
import { createServer, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isValidCronPattern,
  probeAwServer,
  runTelemetryPull,
  scheduleTelemetryPull,
  type TelemetryClient,
  type TelemetryLogger,
} from "../../../src/transport/activitywatch/telemetry.js";
import {
  SshUnreachableError,
  type PortForwardTarget,
  type SshTarget,
} from "../../../src/transport/ssh/index.js";

/** A capturing logger satisfying the {@link TelemetryLogger} surface. */
function makeLogger(): TelemetryLogger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A stand-in for the SSH facade's `withPortForward` (one method is enough). */
class FakeForwarder {
  readonly visited: string[] = [];

  constructor(
    private readonly local: { host: string; port: number } = { host: "127.0.0.1", port: 5600 },
    private readonly unreachable: ReadonlySet<string> = new Set(),
  ) {}

  async withPortForward<T>(
    target: SshTarget,
    _remote: PortForwardTarget,
    fn: (local: { host: string; port: number }) => Promise<T>,
  ): Promise<T> {
    this.visited.push(target.host);
    if (this.unreachable.has(target.host)) {
      throw new SshUnreachableError({
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
      });
    }
    return fn(this.local);
  }
}

const credentials = { privateKey: "KEY" };

function clientsNamed(...hostnames: string[]): TelemetryClient[] {
  return hostnames.map((hostname, index) => ({
    id: index + 1,
    hostname,
    sshUser: "pct-agent",
    sshTarget: null,
  }));
}

describe("runTelemetryPull", () => {
  it("tunnels each reachable client and reports a success summary", async () => {
    const transport = new FakeForwarder();
    const logger = makeLogger();
    const consume = vi.fn(async () => undefined);

    const result = await runTelemetryPull({
      transport,
      credentials,
      logger,
      clients: clientsNamed("a", "b", "c"),
      consume,
    });

    expect(result).toEqual({ attempted: 3, succeeded: 3, skippedOffline: 0, failed: 0 });
    expect(consume).toHaveBeenCalledTimes(3);
    expect(transport.visited.sort()).toEqual(["a", "b", "c"]);
  });

  it("dials the per-client SSH-target override instead of the hostname (#406)", async () => {
    const transport = new FakeForwarder();
    const logger = makeLogger();
    const consume = vi.fn(async () => undefined);

    // hostname "unresolvable.local" would fail to resolve; the override pins the
    // pull to a reachable IP — the whole point of #406, verified end-to-end here.
    const clients: TelemetryClient[] = [
      { id: 1, hostname: "unresolvable.local", sshUser: "pct-agent", sshTarget: "192.168.1.50" },
    ];

    await runTelemetryPull({ transport, credentials, logger, clients, consume });

    expect(transport.visited).toEqual(["192.168.1.50"]);
  });

  it("forwards to the configured aw-server port and passes the loopback base URL", async () => {
    const transport = new FakeForwarder({ host: "127.0.0.1", port: 41234 });
    const logger = makeLogger();
    const seen: string[] = [];

    await runTelemetryPull({
      transport,
      credentials,
      logger,
      clients: clientsNamed("a"),
      awPort: 5600,
      consume: async (ctx) => {
        seen.push(ctx.baseUrl);
      },
    });

    expect(seen).toEqual(["http://127.0.0.1:41234"]);
  });

  it("skips an unreachable client as a non-punitive gap", async () => {
    const transport = new FakeForwarder({ host: "127.0.0.1", port: 5600 }, new Set(["b"]));
    const logger = makeLogger();
    const consume = vi.fn(async () => undefined);

    const result = await runTelemetryPull({
      transport,
      credentials,
      logger,
      clients: clientsNamed("a", "b", "c"),
      consume,
    });

    expect(result).toEqual({ attempted: 3, succeeded: 2, skippedOffline: 1, failed: 0 });
    expect(consume).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "b" }),
      expect.stringContaining("unreachable"),
    );
  });

  it("isolates a consumer failure without aborting the pass", async () => {
    const transport = new FakeForwarder();
    const logger = makeLogger();

    const result = await runTelemetryPull({
      transport,
      credentials,
      logger,
      clients: clientsNamed("a", "b", "c"),
      consume: async (ctx) => {
        if (ctx.client.hostname === "b") throw new Error("parse boom");
      },
    });

    expect(result).toEqual({ attempted: 3, succeeded: 2, skippedOffline: 0, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "b", error: "parse boom" }),
      expect.stringContaining("failed"),
    );
  });

  it("bounds concurrency to the configured limit", async () => {
    const transport = new FakeForwarder();
    const logger = makeLogger();
    let inFlight = 0;
    let maxInFlight = 0;

    await runTelemetryPull({
      transport,
      credentials,
      logger,
      clients: clientsNamed("a", "b", "c", "d", "e"),
      concurrency: 2,
      consume: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    });

    expect(maxInFlight).toBe(2);
  });

  it("handles an empty client list", async () => {
    const transport = new FakeForwarder();
    const logger = makeLogger();

    const result = await runTelemetryPull({ transport, credentials, logger, clients: [] });

    expect(result).toEqual({ attempted: 0, succeeded: 0, skippedOffline: 0, failed: 0 });
    expect(transport.visited).toEqual([]);
  });

  describe("default consumer (probeAwServer)", () => {
    let server: Server;
    let baseUrl: string;
    let serverPort: number;
    let lastPath: string | undefined;
    let infoBody: unknown;

    beforeEach(async () => {
      lastPath = undefined;
      infoBody = { hostname: "mint-01", version: "0.13.2", testing: false };
      server = createServer((req, res) => {
        lastPath = req.url;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(infoBody));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("server has no port");
      serverPort = address.port;
      baseUrl = `http://127.0.0.1:${serverPort}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("probes GET /api/0/info and logs the reachable server when no consumer is given", async () => {
      const transport = new FakeForwarder({ host: "127.0.0.1", port: serverPort });
      const logger = makeLogger();

      const result = await runTelemetryPull({
        transport,
        credentials,
        logger,
        clients: clientsNamed("mint-01"),
      });

      expect(result.succeeded).toBe(1);
      expect(lastPath).toBe("/api/0/info");
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ awVersion: "0.13.2" }),
        expect.stringContaining("reachable"),
      );
    });

    it("probeAwServer rejects (counted as a failure) when the server is unhealthy", async () => {
      infoBody = { not: "the info shape" };
      const logger = makeLogger();
      const client: TelemetryClient = {
        id: 1,
        hostname: "x",
        sshUser: "pct-agent",
        sshTarget: null,
      };

      await expect(probeAwServer({ client, baseUrl, logger })).rejects.toThrow();
    });
  });
});

describe("scheduleTelemetryPull", () => {
  it("returns a Cron that has a next run scheduled", () => {
    const logger = makeLogger();
    const cron = scheduleTelemetryPull(async () => undefined, { pattern: "*/5 * * * *" }, logger);

    try {
      expect(cron.nextRun()).toBeInstanceOf(Date);
    } finally {
      cron.stop();
    }
  });

  it("runs the pull when triggered", async () => {
    const logger = makeLogger();
    const run = vi.fn(async () => undefined);
    const cron = scheduleTelemetryPull(run, { pattern: "*/5 * * * *", timezone: "UTC" }, logger);

    try {
      await cron.trigger();
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      cron.stop();
    }
  });

  it("routes a thrown pass to the catch handler instead of crashing", async () => {
    const logger = makeLogger();
    const run = vi.fn(async () => {
      throw new Error("pass boom");
    });
    const cron = scheduleTelemetryPull(run, { pattern: "*/5 * * * *" }, logger);

    try {
      await cron.trigger();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: "pass boom" }),
        expect.stringContaining("threw"),
      );
    } finally {
      cron.stop();
    }
  });
});

describe("isValidCronPattern", () => {
  it("accepts a standard 5-field pattern", () => {
    expect(isValidCronPattern("*/5 * * * *")).toBe(true);
    expect(isValidCronPattern("0 */2 * * *")).toBe(true);
  });

  it("rejects gibberish", () => {
    expect(isValidCronPattern("not a cron")).toBe(false);
    expect(isValidCronPattern("")).toBe(false);
  });
});
