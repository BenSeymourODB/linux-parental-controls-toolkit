/**
 * Unit tests for the live telemetry consumer (#88 normaliser wired into the
 * #162 pull, turned on by #327). Drives `createUsageTelemetryConsumer` against a
 * seeded in-memory DB and a fake `aw-server` event source — no live tunnel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createUsageTelemetryConsumer,
  type AwEventSource,
} from "../../src/enforcement/telemetry-consumer.js";
import {
  activities,
  clients,
  users,
  usersOnClients,
  usageSamples,
} from "../../src/policy/schema.js";
import type { EventQuery } from "../../src/transport/activitywatch/client.js";
import type { AwAfkEvent, AwWindowEvent } from "../../src/transport/activitywatch/schemas.js";
import type {
  TelemetryConsumeContext,
  TelemetryLogger,
} from "../../src/transport/activitywatch/telemetry.js";
import { testDb, type TestDb } from "../helpers/db.js";

/** A logger whose calls are inspectable. */
function fakeLogger(): TelemetryLogger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * A fake `aw-server` that returns the fixed window/afk events **within the
 * requested window** — mirroring the real server, so a cursor-narrowed query
 * returns only its slice (the key to the double-count test).
 */
function fakeSource(windowEvents: AwWindowEvent[], afkEvents: AwAfkEvent[] = []): AwEventSource {
  const inWindow = <T extends { timestamp: Date }>(events: T[], q: EventQuery): T[] =>
    events.filter(
      (e) => e.timestamp.getTime() >= q.start.getTime() && e.timestamp.getTime() < q.end.getTime(),
    );
  return {
    getWindowEvents: (q) => Promise.resolve(inWindow(windowEvents, q)),
    getAfkEvents: (q) => Promise.resolve(inWindow(afkEvents, q)),
  };
}

function windowEvent(app: string, timestamp: string, durationSeconds: number): AwWindowEvent {
  return {
    bucketId: "aw-watcher-window_host",
    timestamp: new Date(timestamp),
    durationSeconds,
    app,
    title: "",
  };
}

describe("createUsageTelemetryConsumer", () => {
  let db: TestDb;
  const PASS_END = new Date("2024-02-15T12:00:00.000Z");
  const LOOKBACK_MS = 15 * 60 * 1000;

  beforeEach(() => {
    db = testDb();
  });

  /** Seed a client + N supervised users linked to it; return ids. */
  function seedClient(userNames: string[]): { clientId: number; userIds: number[] } {
    const clientId = db
      .insert(clients)
      .values({ hostname: "alice-pc", sshUser: "pct-agent" })
      .returning()
      .get().id;
    const userIds = userNames.map((displayName, i) => {
      const userId = db.insert(users).values({ displayName }).returning().get().id;
      db.insert(usersOnClients)
        .values({ userId, clientId, osUsername: `u${i}`, osUserRef: String(1001 + i) })
        .run();
      return userId;
    });
    return { clientId, userIds };
  }

  function context(clientId: number, logger: TelemetryLogger): TelemetryConsumeContext {
    return {
      client: { id: clientId, hostname: "alice-pc", sshUser: "pct-agent" },
      baseUrl: "http://127.0.0.1:54321",
      logger,
    };
  }

  it("normalises a single-user client's window events into usage samples and advances the cursor", async () => {
    const { clientId, userIds } = seedClient(["Alice"]);
    const firefoxId = db
      .insert(activities)
      .values({ kind: "app", matcher: "firefox" })
      .returning()
      .get().id;
    const cursor = new Map<number, Date>();
    const logger = fakeLogger();

    const consume = createUsageTelemetryConsumer({
      db,
      cursor,
      passEnd: () => PASS_END,
      initialLookbackMs: LOOKBACK_MS,
      createSource: () => fakeSource([windowEvent("firefox", "2024-02-15T11:55:00.000Z", 120)]),
    });

    await consume(context(clientId, logger));

    const rows = db.select().from(usageSamples).all();
    expect(rows).toHaveLength(1);
    const [sample] = rows;
    if (sample === undefined) throw new Error("expected one usage sample");
    expect(sample).toMatchObject({ userId: userIds[0], clientId, activityId: firefoxId });
    expect((sample.endedAt.getTime() - sample.startedAt.getTime()) / 1000).toBe(120);
    // Cursor advanced to this pass's end so the next pass starts where this left off.
    expect(cursor.get(clientId)).toEqual(PASS_END);
  });

  it("does not double-count across passes: the cursor narrows the next window (#327)", async () => {
    const { clientId } = seedClient(["Alice"]);
    db.insert(activities).values({ kind: "app", matcher: "firefox" }).run();
    const cursor = new Map<number, Date>();
    // Same fixed events every pass; the source honours the query window, so once
    // the cursor advances past them the second pass pulls nothing.
    const events = [windowEvent("firefox", "2024-02-15T11:55:00.000Z", 120)];
    let passEnd = PASS_END;
    const consume = createUsageTelemetryConsumer({
      db,
      cursor,
      passEnd: () => passEnd,
      initialLookbackMs: LOOKBACK_MS,
      createSource: () => fakeSource(events),
    });

    await consume(context(clientId, fakeLogger())); // window [11:45, 12:00) → 1 row
    passEnd = new Date("2024-02-15T12:05:00.000Z"); // next pass, cursor now 12:00
    await consume(context(clientId, fakeLogger())); // window [12:00, 12:05) → nothing

    expect(db.select().from(usageSamples).all()).toHaveLength(1);
    expect(cursor.get(clientId)).toEqual(passEnd);
  });

  it("skips a client with no supervised user (nothing to attribute)", async () => {
    const clientId = db
      .insert(clients)
      .values({ hostname: "orphan-pc", sshUser: "pct-agent" })
      .returning()
      .get().id;
    const logger = fakeLogger();
    const consume = createUsageTelemetryConsumer({
      db,
      cursor: new Map(),
      passEnd: () => PASS_END,
      initialLookbackMs: LOOKBACK_MS,
      createSource: () => fakeSource([windowEvent("firefox", "2024-02-15T11:55:00.000Z", 120)]),
    });

    await consume(context(clientId, logger));

    expect(db.select().from(usageSamples).all()).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ clientId }),
      expect.stringContaining("no supervised user"),
    );
  });

  it("skips a multi-user client (per-user attribution not yet supported) with a warning", async () => {
    const { clientId } = seedClient(["Alice", "Bob"]);
    db.insert(activities).values({ kind: "app", matcher: "firefox" }).run();
    const logger = fakeLogger();
    const consume = createUsageTelemetryConsumer({
      db,
      cursor: new Map(),
      passEnd: () => PASS_END,
      initialLookbackMs: LOOKBACK_MS,
      createSource: () => fakeSource([windowEvent("firefox", "2024-02-15T11:55:00.000Z", 120)]),
    });

    await consume(context(clientId, logger));

    expect(db.select().from(usageSamples).all()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ clientId, userCount: 2 }),
      expect.stringContaining("multi-user"),
    );
  });

  it("does not advance the cursor when the pull fails (re-pull the same window next pass)", async () => {
    const { clientId } = seedClient(["Alice"]);
    db.insert(activities).values({ kind: "app", matcher: "firefox" }).run();
    const cursor = new Map<number, Date>();
    const boom: AwEventSource = {
      getWindowEvents: () => Promise.reject(new Error("aw-server exploded")),
      getAfkEvents: () => Promise.resolve([]),
    };
    const consume = createUsageTelemetryConsumer({
      db,
      cursor,
      passEnd: () => PASS_END,
      initialLookbackMs: LOOKBACK_MS,
      createSource: () => boom,
    });

    await expect(consume(context(clientId, fakeLogger()))).rejects.toThrow("aw-server exploded");
    expect(cursor.has(clientId)).toBe(false);
    expect(db.select().from(usageSamples).all()).toHaveLength(0);
  });
});
