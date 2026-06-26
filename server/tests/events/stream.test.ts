/**
 * Route-level tests for `GET /api/events/stream` (#100). These exercise the
 * real WebSocket upgrade over a loopback listener with the `ws` client (the
 * same library the `pct-client-bridge` will use), so they are in-process and
 * hermetic — no external services, so a plain `*.test.ts`, not an integration
 * test.
 *
 * Covered: a missing/invalid bearer token is rejected as a 401 *before* the
 * upgrade; a valid token connects, registers in the hub, sets `last_seen`,
 * receives a published frame, and is unregistered when it closes.
 */
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { generateToken, hashToken } from "../../src/auth/secret-token.js";
import type { EventFrame } from "../../src/events/taxonomy.js";
import * as repo from "../../src/policy/repository.js";
import { clients } from "../../src/policy/schema.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

let harness: TestApp | undefined;
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of openSockets.splice(0)) ws.terminate();
  if (harness !== undefined) {
    await harness.close();
    harness = undefined;
  }
});

/** The bound loopback port of a listening test app. */
function boundPort(app: TestApp["app"]): number {
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return (address as AddressInfo).port;
}

/** Open a tracked `ws` connection to the stream route. */
function connect(app: TestApp["app"], headers?: Record<string, string>): WebSocket {
  const url = `ws://127.0.0.1:${boundPort(app)}/api/events/stream`;
  const ws = headers === undefined ? new WebSocket(url) : new WebSocket(url, { headers });
  openSockets.push(ws);
  return ws;
}

/** Insert a client carrying `token`'s hash; return its id. */
function enrolClientWithToken(harnessRef: TestApp, token: string): number {
  return harnessRef.db
    .insert(clients)
    .values({ hostname: "mint-01", sshUser: "pct-agent", bearerTokenHash: hashToken(token) })
    .returning()
    .get().id;
}

describe("GET /api/events/stream — authentication", () => {
  it("rejects a connection with no bearer token (401, no upgrade)", async () => {
    harness = buildTestApp();
    await harness.app.listen({ port: 0, host: "127.0.0.1" });

    const ws = connect(harness.app);
    const outcome = await new Promise<string>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(`status:${res.statusCode}`));
      ws.on("open", () => resolve("open"));
      ws.on("error", (err) => resolve(`error:${err.message}`));
    });
    expect(outcome).toBe("status:401");
  });

  it("rejects a connection with an unknown bearer token (401)", async () => {
    harness = buildTestApp();
    enrolClientWithToken(harness, generateToken());
    await harness.app.listen({ port: 0, host: "127.0.0.1" });

    const ws = connect(harness.app, { authorization: `Bearer ${generateToken()}` });
    const outcome = await new Promise<string>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(`status:${res.statusCode}`));
      ws.on("open", () => resolve("open"));
      ws.on("error", (err) => resolve(`error:${err.message}`));
    });
    expect(outcome).toBe("status:401");
  });
});

describe("GET /api/events/stream — connected lifecycle", () => {
  it("connects, registers, sets last_seen, delivers a frame, and unregisters on close", async () => {
    harness = buildTestApp();
    const { app, db } = harness;
    const token = generateToken();
    const clientId = enrolClientWithToken(harness, token);
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws = connect(app, { authorization: `Bearer ${token}` });
    const firstMessage = new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(data.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    // The handler registers the connection and stamps last_seen on open.
    await vi.waitFor(() => expect(app.eventHub.isClientLive(clientId)).toBe(true));
    expect(app.eventHub.connectionCount).toBe(1);
    expect(repo.getClient(db, clientId)?.lastSeen).toBeInstanceOf(Date);

    // A producer publishing to this client reaches the open socket.
    const delivered = app.eventHub.publishToClient(clientId, {
      type: "grant.applied",
      userId: 1,
      grantedSeconds: 1800,
      reason: "chores done",
      activityId: null,
    });
    expect(delivered).toBe(1);

    const frame = JSON.parse(await firstMessage) as EventFrame;
    expect(frame.seq).toBe(1);
    expect(frame.event.type).toBe("grant.applied");
    expect(frame.event).toMatchObject({ userId: 1, grantedSeconds: 1800 });

    // Closing the client connection unregisters it server-side.
    ws.close();
    await vi.waitFor(() => expect(app.eventHub.isClientLive(clientId)).toBe(false));
    expect(app.eventHub.connectionCount).toBe(0);
  });
});
