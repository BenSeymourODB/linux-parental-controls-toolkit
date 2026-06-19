/**
 * Unit tests for the offline-queue scheduler (#84): the probe-gated, per-client
 * drain pass, error isolation across clients, structured logging, and the
 * start/stop lifecycle. The cron schedule itself isn't fired here — `tick()`
 * (the same function each cron tick invokes) is driven directly.
 */
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "../../../src/config.js";
import { buildApp } from "../../../src/web/app.js";
import { createClient } from "../../../src/policy/repository.js";
import * as queue from "../../../src/transport/queue/repository.js";
import {
  DEFAULT_DRAIN_PATTERN,
  QUEUE_LOG_COMPONENT,
  startOfflineQueueDrainer,
  type OfflineQueueDrainerHandle,
} from "../../../src/transport/queue/scheduler.js";
import { SshCommandError, SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const target = { host: "mint-01", port: 22, username: "pct-agent" } as const;

describe("startOfflineQueueDrainer", () => {
  let db: TestDb;
  let log: FastifyBaseLogger;
  let lines: Record<string, unknown>[];
  let app: ReturnType<typeof buildApp>;
  let handles: OfflineQueueDrainerHandle[];

  beforeEach(() => {
    db = testDb();
    lines = [];
    // A real pino logger (via buildApp) capturing JSON lines, so the child
    // logger + component tag the scheduler relies on are exercised for real.
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "info", PCT_SECRET_KEY: "test-secret-key" }),
      loggerStream: {
        write: (msg) => {
          lines.push(JSON.parse(msg) as Record<string, unknown>);
        },
      },
      db,
    });
    log = app.log;
    handles = [];
  });
  afterEach(async () => {
    for (const handle of handles) handle.stop();
    await app.close();
    db.$client.close();
  });

  function start(
    probe: (id: number) => Promise<boolean>,
    executor: () => Promise<void>,
  ): OfflineQueueDrainerHandle {
    const handle = startOfflineQueueDrainer({ db, probe, executor, log });
    handles.push(handle);
    return handle;
  }

  function enqueueFor(clientId: number, coalesceKey: string): void {
    queue.enqueue(db, { clientId, coalesceKey, kind: "policy.push", payload: {} });
  }

  it("drains a reachable client and logs the pass with the component tag", async () => {
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    enqueueFor(clientId, "user:1");
    const executor = vi.fn(async () => undefined);
    const probe = vi.fn(async () => true);

    await start(probe, executor).tick();

    expect(probe).toHaveBeenCalledWith(clientId);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(queue.listForClient(db, clientId)).toHaveLength(0);

    const drainLine = lines.find((l) => l.msg === "offline-queue drain pass");
    expect(drainLine).toMatchObject({ component: QUEUE_LOG_COMPONENT, clientId, drained: 1 });
  });

  it("skips an unreachable client and leaves its work queued (silently)", async () => {
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    enqueueFor(clientId, "user:1");
    const executor = vi.fn(async () => undefined);

    await start(async () => false, executor).tick();

    expect(executor).not.toHaveBeenCalled();
    expect(queue.listPendingForClient(db, clientId)).toHaveLength(1);
    // A no-op pass shouldn't spam the log.
    expect(lines.find((l) => l.msg === "offline-queue drain pass")).toBeUndefined();
  });

  it("only probes clients that have pending work", async () => {
    const withWork = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    createClient(db, { hostname: "mint-02", sshUser: "pct-agent" }); // idle, no queue
    enqueueFor(withWork, "user:1");
    const probe = vi.fn(async () => false);

    await start(probe, async () => undefined).tick();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(withWork);
  });

  it("isolates one client's probe failure and still drains the others", async () => {
    const bad = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const good = createClient(db, { hostname: "mint-02", sshUser: "pct-agent" }).id;
    enqueueFor(bad, "user:1");
    enqueueFor(good, "user:2");
    const executor = vi.fn(async () => undefined);
    const probe = vi.fn(async (id: number) => {
      if (id === bad) throw new SshUnreachableError(target);
      return true;
    });

    await start(probe, executor).tick();

    expect(executor).toHaveBeenCalledTimes(1); // only the good client drained
    expect(queue.listPendingForClient(db, good)).toHaveLength(0);
    expect(queue.listPendingForClient(db, bad)).toHaveLength(1); // untouched
    expect(lines.find((l) => l.msg === "offline-queue drain error")).toMatchObject({
      component: QUEUE_LOG_COMPONENT,
      clientId: bad,
    });
  });

  it("logs a pass that only dead-letters actions (failed > 0)", async () => {
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    enqueueFor(clientId, "user:1");
    const executor = vi.fn(async () => {
      throw new SshCommandError(target, ["timekpra"], {
        code: 1,
        signal: null,
        stdout: "",
        stderr: "bad args",
      });
    });

    await start(async () => true, executor).tick();

    expect(lines.find((l) => l.msg === "offline-queue drain pass")).toMatchObject({
      component: QUEUE_LOG_COMPONENT,
      clientId,
      drained: 0,
      failed: 1,
    });
  });

  it("does not log a pass that only defers (host dropped mid-drain)", async () => {
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    enqueueFor(clientId, "user:1");
    // Probe says reachable, but the push then hits a retriable failure → the
    // action stays pending and the pass is a no-op worth no log line.
    const executor = vi.fn(async () => {
      throw new SshUnreachableError(target);
    });

    await start(async () => true, executor).tick();

    expect(queue.listPendingForClient(db, clientId)).toHaveLength(1);
    expect(lines.find((l) => l.msg === "offline-queue drain pass")).toBeUndefined();
  });

  it("does nothing when no client has pending work", async () => {
    const probe = vi.fn(async () => true);
    await start(probe, async () => undefined).tick();
    expect(probe).not.toHaveBeenCalled();
  });

  it("stops cleanly and exposes the default cadence", () => {
    expect(DEFAULT_DRAIN_PATTERN).toBe("*/1 * * * *");
    const handle = start(
      async () => true,
      async () => undefined,
    );
    expect(() => handle.stop()).not.toThrow();
  });
});
