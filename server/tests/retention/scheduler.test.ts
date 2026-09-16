/**
 * Unit tests for the scheduled retention purge (#137). The cron schedule itself
 * isn't fired — `tick()` (the same function each cron tick invokes) is driven
 * directly. Covers: a tick purges + records a run and logs it; the effective
 * policy is rebuilt each tick (an override change applies without a restart); a
 * thrown pass is caught, logged, and isolated (never escapes the tick); and the
 * start/stop lifecycle.
 */
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config.js";
import { listPurgeRuns, upsertRetentionOverride } from "../../src/policy/repository.js";
import { activities, clients, usageSamples, users } from "../../src/policy/schema.js";
import {
  DEFAULT_RETENTION_PURGE_PATTERN,
  RETENTION_PURGE_LOG_COMPONENT,
  createRetentionPurgeScheduler,
} from "../../src/retention/index.js";
import { buildApp } from "../../src/web/app.js";
import { testDb, type TestDb } from "../helpers/db.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-20T03:00:00.000Z");

let db: TestDb;
let log: FastifyBaseLogger;
let lines: Record<string, unknown>[];
let app: ReturnType<typeof buildApp>;
let userId: number;
let clientId: number;
let activityId: number;

beforeEach(() => {
  db = testDb();
  lines = [];
  app = buildApp({
    settings: loadSettings({ PCT_LOG_LEVEL: "debug", PCT_SECRET_KEY: "test-secret-key" }),
    loggerStream: {
      write: (msg) => {
        lines.push(JSON.parse(msg) as Record<string, unknown>);
      },
    },
    db,
  });
  log = app.log;
  userId = db.insert(users).values({ displayName: "Alice" }).returning().get().id;
  clientId = db
    .insert(clients)
    .values({ hostname: "alice-pc", sshUser: "pct-agent" })
    .returning()
    .get().id;
  activityId = db
    .insert(activities)
    .values({ kind: "app", matcher: "firefox" })
    .returning()
    .get().id;
});

afterEach(async () => {
  await app.close();
  db.$client.close();
});

/** A usage sample `days` before {@link NOW}, one second long. */
function insertOldSample(days: number): void {
  const end = new Date(NOW.getTime() - days * DAY_MS);
  const start = new Date(end.getTime() - 1000);
  db.insert(usageSamples)
    .values({ userId, clientId, activityId, startedAt: start, endedAt: end })
    .run();
}

function scheduler(overrides: Partial<Parameters<typeof createRetentionPurgeScheduler>[0]> = {}) {
  return createRetentionPurgeScheduler({
    db,
    defaultDays: 30,
    log,
    now: () => NOW,
    ...overrides,
  });
}

describe("createRetentionPurgeScheduler", () => {
  it("purges expired records, records a run, and logs the pass", () => {
    insertOldSample(100); // expired under the 30-day window
    insertOldSample(5); // recent

    scheduler().tick();

    expect(db.select().from(usageSamples).all()).toHaveLength(1);
    const runs = listPurgeRuns(db, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("scheduled");
    expect(runs[0]?.totalDeleted).toBe(1);
    expect(runs[0]?.at).toEqual(NOW);

    const logLine = lines.find(
      (l) =>
        l.component === RETENTION_PURGE_LOG_COMPONENT && l.msg === "retention purge pass complete",
    );
    expect(logLine).toMatchObject({ totalDeleted: 1 });
  });

  it("rebuilds the effective policy each tick — an override change applies next pass", () => {
    insertOldSample(100);
    // Pin usage_samples to keep-forever before the tick: nothing should purge.
    upsertRetentionOverride(db, "usage_samples", { keepForever: true });

    scheduler().tick();

    expect(db.select().from(usageSamples).all()).toHaveLength(1);
    expect(listPurgeRuns(db, 10)[0]?.totalDeleted).toBe(0);
  });

  it("honours a configured batch size", () => {
    for (let i = 0; i < 4; i++) insertOldSample(100 + i);
    scheduler({ batchSize: 2 }).tick();
    expect(db.select().from(usageSamples).all()).toHaveLength(0);
    expect(listPurgeRuns(db, 10)).toHaveLength(1);
  });

  it("catches and logs a failed pass without throwing or wedging the schedule", () => {
    // A closed DB makes the purge query throw; the tick must swallow it.
    const brokenDb = testDb();
    brokenDb.$client.close();
    const handle = createRetentionPurgeScheduler({
      db: brokenDb,
      defaultDays: 30,
      log,
      now: () => NOW,
    });

    expect(() => handle.tick()).not.toThrow();
    const errLine = lines.find(
      (l) =>
        l.component === RETENTION_PURGE_LOG_COMPONENT && l.msg === "retention purge pass failed",
    );
    expect(errLine).toBeDefined();
  });

  it("start/stop lifecycle is safe and idempotent", () => {
    const handle = scheduler();
    expect(() => {
      handle.start();
      handle.start(); // idempotent — no second Cron
      handle.stop();
      handle.stop(); // safe after stop
    }).not.toThrow();
    // tick still runs after a start/stop cycle.
    insertOldSample(100);
    handle.tick();
    expect(listPurgeRuns(db, 10)).toHaveLength(1);
  });

  it("exports a sane default cron pattern and log component", () => {
    expect(DEFAULT_RETENTION_PURGE_PATTERN).toBe("0 3 * * *");
    expect(RETENTION_PURGE_LOG_COMPONENT).toBe("retention/purge");
  });
});
