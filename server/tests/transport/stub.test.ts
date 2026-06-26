/**
 * Unit tests for the Phase-2 stub transport (#54).
 *
 * Two layers: the pure command builders (mutation → per-client commands) and
 * the {@link createPolicyPushStub} fan-out, captured via the real pino logger
 * through the `loggerStream` seam (so the `component` binding and structured
 * fields are asserted end-to-end, not against a hand-rolled logger).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { loadSettings } from "../../src/config.js";
import {
  PUSH_STUB_COMPONENT,
  PUSH_STUB_MESSAGE,
  clientPushCommands,
  createPolicyPushStub,
  linkPushCommands,
  userPushCommands,
} from "../../src/transport/stub.js";
import { buildApp } from "../../src/web/app.js";
import { testDb, type TestDb } from "../helpers/db.js";

describe("policy push command builders", () => {
  it("userPushCommands fans out one command per linked client", () => {
    expect(userPushCommands("user.updated", 7, [3, 5], { displayName: "Alice" })).toEqual([
      { clientId: 3, userId: 7, reason: "user.updated", detail: { displayName: "Alice" } },
      { clientId: 5, userId: 7, reason: "user.updated", detail: { displayName: "Alice" } },
    ]);
  });

  it("userPushCommands yields nothing for a user with no linked clients", () => {
    expect(userPushCommands("user.created", 7, [], { displayName: "Alice" })).toEqual([]);
  });

  it("clientPushCommands targets the one client with a null user", () => {
    expect(clientPushCommands("client.created", 9, { hostname: "mint-01" })).toEqual([
      { clientId: 9, userId: null, reason: "client.created", detail: { hostname: "mint-01" } },
    ]);
  });

  it("linkPushCommands targets the one user/client pair", () => {
    expect(linkPushCommands("link.upserted", 7, 9, { osUserRef: "1001" })).toEqual([
      { clientId: 9, userId: 7, reason: "link.upserted", detail: { osUserRef: "1001" } },
    ]);
  });
});

describe("createPolicyPushStub", () => {
  let app: FastifyInstance | undefined;
  let db: TestDb | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    if (db !== undefined) db.$client.close();
    app = undefined;
    db = undefined;
  });

  /** Build a real-logger app at `info` and return the stub + captured lines. */
  function makeStub(): {
    stub: ReturnType<typeof createPolicyPushStub>;
    lines: Record<string, unknown>[];
  } {
    const lines: Record<string, unknown>[] = [];
    db = testDb();
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "info" }),
      loggerStream: {
        write(msg: string) {
          lines.push(JSON.parse(msg) as Record<string, unknown>);
        },
      },
      db,
    });
    return { stub: createPolicyPushStub(app.log), lines };
  }

  it("emits one component-tagged 'would push' line per command", () => {
    const { stub, lines } = makeStub();

    stub.push([
      { clientId: 3, userId: 7, reason: "user.updated", detail: { displayName: "Alice" } },
      { clientId: 5, userId: 7, reason: "user.updated", detail: { displayName: "Alice" } },
    ]);

    const pushed = lines.filter((l) => l.component === PUSH_STUB_COMPONENT);
    expect(pushed).toHaveLength(2);
    expect(pushed[0]).toMatchObject({
      component: PUSH_STUB_COMPONENT,
      msg: PUSH_STUB_MESSAGE,
      clientId: 3,
      userId: 7,
      reason: "user.updated",
      detail: { displayName: "Alice" },
    });
    expect(pushed[1]).toMatchObject({ clientId: 5, userId: 7 });
  });

  it("is a no-op for an empty command list", () => {
    const { stub, lines } = makeStub();

    stub.push([]);

    expect(lines.filter((l) => l.component === PUSH_STUB_COMPONENT)).toHaveLength(0);
  });

  it("preserves a null user for client-level changes", () => {
    const { stub, lines } = makeStub();

    stub.push(clientPushCommands("client.deleted", 9, {}));

    const pushed = lines.filter((l) => l.component === PUSH_STUB_COMPONENT);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ clientId: 9, userId: null, reason: "client.deleted" });
  });
});
