/**
 * Route-level tests for `GET /api/events/stream` (#100, + the #165 version
 * handshake). These exercise the real WebSocket upgrade over a loopback
 * listener with the `ws` client (the same library the `pct-client-bridge` will
 * use), so they are in-process and hermetic — no external services, so a plain
 * `*.test.ts`, not an integration test.
 *
 * Covered: a missing/invalid bearer token is rejected as a 401 *before* the
 * upgrade; a valid token that sends a compatible `hello` is accepted (gets the
 * `accept` frame, registers in the hub, sets `last_seen`, refreshes
 * `agent_version`, receives a published frame, unregisters on close); an
 * incompatible or unparseable `hello` is refused (gets a `refuse` frame, never
 * registers, socket closed).
 */
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { API_VERSION } from "../../src/api/version.js";
import { generateToken, hashToken } from "../../src/auth/secret-token.js";
import { EVENT_PROTOCOL } from "../../src/events/protocol.js";
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

/** A FIFO reader over a socket's text messages (handshake + event frames). */
function messageReader(ws: WebSocket): () => Promise<string> {
  const buffered: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  ws.on("message", (data) => {
    const m = data.toString();
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(m);
    else buffered.push(m);
  });
  return () =>
    new Promise<string>((resolve) => {
      const m = buffered.shift();
      if (m !== undefined) resolve(m);
      else waiters.push(resolve);
    });
}

/** Resolve once the socket is open (or reject on error). */
function awaitOpen(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

/** A well-formed client hello at the given protocol (defaults to the server's). */
function helloFrame(eventProtocol: number = EVENT_PROTOCOL): string {
  return JSON.stringify({
    type: "hello",
    agentVersion: "1.4.2",
    eventProtocol,
    capabilities: ["session_budget"],
  });
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

describe("GET /api/events/stream — version handshake (#165)", () => {
  it("accepts a compatible hello, registers, refreshes agent_version, delivers a frame", async () => {
    harness = buildTestApp();
    const { app, db } = harness;
    const token = generateToken();
    const clientId = enrolClientWithToken(harness, token);
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws = connect(app, { authorization: `Bearer ${token}` });
    const nextMessage = messageReader(ws);
    await awaitOpen(ws);
    ws.send(helloFrame());

    // The first server frame is the handshake accept.
    const accept = JSON.parse(await nextMessage()) as {
      type: string;
      eventProtocol: number;
      apiVersion: number;
    };
    expect(accept).toEqual({
      type: "accept",
      eventProtocol: EVENT_PROTOCOL,
      apiVersion: API_VERSION,
    });

    // Only after accept is the connection registered + the hello's agentVersion recorded.
    await vi.waitFor(() => expect(app.eventHub.isClientLive(clientId)).toBe(true));
    expect(app.eventHub.connectionCount).toBe(1);
    const row = repo.getClient(db, clientId);
    expect(row?.lastSeen).toBeInstanceOf(Date);
    expect(row?.agentVersion).toBe("1.4.2");
    expect(row?.versionsReportedAt).toBeInstanceOf(Date);

    // A producer publishing to this client reaches the open socket (2nd frame).
    const delivered = app.eventHub.publishToClient(clientId, {
      type: "grant.applied",
      userId: 1,
      grantedSeconds: 1800,
      reason: "chores done",
      activityId: null,
    });
    expect(delivered).toBe(1);

    const frame = JSON.parse(await nextMessage()) as EventFrame;
    expect(frame.seq).toBe(1);
    expect(frame.event.type).toBe("grant.applied");
    expect(frame.event).toMatchObject({ userId: 1, grantedSeconds: 1800 });

    // Closing the client connection unregisters it server-side.
    ws.close();
    await vi.waitFor(() => expect(app.eventHub.isClientLive(clientId)).toBe(false));
    expect(app.eventHub.connectionCount).toBe(0);
  });

  it("refuses an incompatible (too-new) hello and never registers", async () => {
    harness = buildTestApp();
    const { app } = harness;
    const token = generateToken();
    const clientId = enrolClientWithToken(harness, token);
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws = connect(app, { authorization: `Bearer ${token}` });
    const nextMessage = messageReader(ws);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    await awaitOpen(ws);
    ws.send(helloFrame(EVENT_PROTOCOL + 5));

    const refuse = JSON.parse(await nextMessage()) as { type: string; error: { code: string } };
    expect(refuse.type).toBe("refuse");
    expect(refuse.error.code).toBe("incompatible_protocol");
    expect(await closed).toBe(1008);
    expect(app.eventHub.isClientLive(clientId)).toBe(false);
  });

  it("refuses an unparseable hello (garbage first frame)", async () => {
    harness = buildTestApp();
    const { app } = harness;
    const token = generateToken();
    const clientId = enrolClientWithToken(harness, token);
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws = connect(app, { authorization: `Bearer ${token}` });
    const nextMessage = messageReader(ws);
    await awaitOpen(ws);
    ws.send("not a hello frame");

    const refuse = JSON.parse(await nextMessage()) as { type: string; error: { code: string } };
    expect(refuse.type).toBe("refuse");
    expect(refuse.error.code).toBe("incompatible_protocol");
    await vi.waitFor(() => expect(app.eventHub.isClientLive(clientId)).toBe(false));
  });

  it("clears a stale update_required flag when the client reconnects compatibly", async () => {
    harness = buildTestApp();
    const { app, db } = harness;
    const token = generateToken();
    const clientId = enrolClientWithToken(harness, token);
    // Simulate a client previously flagged as needing an update (set true by a
    // prior out-of-window refusal).
    repo.setClientUpdateRequired(db, clientId, true);
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws = connect(app, { authorization: `Bearer ${token}` });
    const nextMessage = messageReader(ws);
    await awaitOpen(ws);
    ws.send(helloFrame());

    const accept = JSON.parse(await nextMessage()) as { type: string };
    expect(accept.type).toBe("accept");
    // A compatible connect clears the stale flag.
    await vi.waitFor(() => expect(repo.getClient(db, clientId)?.updateRequired).toBe(false));
  });
});
