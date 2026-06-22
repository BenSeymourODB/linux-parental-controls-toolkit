/**
 * Unit tests for the live policy-push dispatcher (#201): the drop-in
 * `PolicyPushStub` that routes each command through `pushOrEnqueue` — delivering
 * to reachable clients, queuing for offline ones (#84), and logging every
 * outcome without ever throwing into the request.
 */
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "../../../src/config.js";
import { createClient } from "../../../src/policy/repository.js";
import {
  POLICY_PUSH_COMPONENT,
  createPolicyPushDispatcher,
} from "../../../src/transport/policy-push/dispatcher.js";
import * as queue from "../../../src/transport/queue/repository.js";
import { SshCommandError, SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import type { PolicyPushCommand } from "../../../src/transport/stub.js";
import { buildApp } from "../../../src/web/app.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const target = { host: "mint-01", port: 22, username: "pct-agent" } as const;

describe("createPolicyPushDispatcher", () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;
  let log: FastifyBaseLogger;
  let lines: Record<string, unknown>[];
  let clientId: number;

  beforeEach(() => {
    db = testDb();
    lines = [];
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "info", PCT_SECRET_KEY: "test-secret-key" }),
      loggerStream: {
        write: (msg) => lines.push(JSON.parse(msg) as Record<string, unknown>),
      },
      db,
    });
    log = app.log;
    clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
  });
  afterEach(async () => {
    await app.close();
    db.$client.close();
  });

  function command(): PolicyPushCommand {
    return { clientId, userId: 1, reason: "budget.updated", detail: {} };
  }

  it("delivers a reachable push and logs it, queuing nothing", async () => {
    const executor = vi.fn(async () => undefined);
    const dispatcher = createPolicyPushDispatcher({ db, executor, log });

    dispatcher.push([command()]);

    await vi.waitFor(() => {
      expect(lines.find((l) => l.msg === "policy push delivered")).toBeDefined();
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(queue.listForClient(db, clientId)).toHaveLength(0);
    expect(lines.find((l) => l.msg === "policy push delivered")).toMatchObject({
      component: POLICY_PUSH_COMPONENT,
      status: "pushed",
      clientId,
    });
  });

  it("queues an unreachable push for replay and logs the deferral", async () => {
    const executor = vi.fn(async () => {
      throw new SshUnreachableError(target);
    });
    const dispatcher = createPolicyPushDispatcher({ db, executor, log });

    dispatcher.push([command()]);

    await vi.waitFor(() => {
      expect(queue.listPendingForClient(db, clientId)).toHaveLength(1);
    });
    expect(lines.find((l) => l.msg?.toString().includes("queued for replay"))).toMatchObject({
      component: POLICY_PUSH_COMPONENT,
      status: "queued",
    });
  });

  it("logs a non-retriable command failure without queuing or throwing", async () => {
    const executor = vi.fn(async () => {
      throw new SshCommandError(target, ["timekpra"], {
        stdout: "",
        stderr: "bad arg",
        code: 2,
        signal: null,
      });
    });
    const dispatcher = createPolicyPushDispatcher({ db, executor, log });

    // push() must not throw even though the command fails.
    expect(() => dispatcher.push([command()])).not.toThrow();

    await vi.waitFor(() => {
      expect(lines.find((l) => l.msg === "policy push failed")).toBeDefined();
    });
    expect(queue.listForClient(db, clientId)).toHaveLength(0);
  });

  it("dispatches each command in a batch", async () => {
    const other = createClient(db, { hostname: "mint-02", sshUser: "pct-agent" }).id;
    const executor = vi.fn(async () => undefined);
    const dispatcher = createPolicyPushDispatcher({ db, executor, log });

    dispatcher.push([
      { clientId, userId: 1, reason: "budget.updated", detail: {} },
      { clientId: other, userId: 1, reason: "budget.updated", detail: {} },
    ]);

    await vi.waitFor(() => {
      expect(executor).toHaveBeenCalledTimes(2);
    });
  });

  it("does nothing for an empty command list", () => {
    const executor = vi.fn(async () => undefined);
    const dispatcher = createPolicyPushDispatcher({ db, executor, log });
    dispatcher.push([]);
    expect(executor).not.toHaveBeenCalled();
  });
});
