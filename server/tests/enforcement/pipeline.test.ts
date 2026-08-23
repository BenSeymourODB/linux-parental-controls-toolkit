/**
 * Unit tests for the enforcement pipeline (#327): the composition of the
 * telemetry pull → #88 usage normaliser → per-activity enforcement sweep.
 *
 * Every I/O seam is faked — a fake SSH transport whose port-forward invokes the
 * consumer against a fake `aw-server`, a fake event hub + audit sink — so a full
 * pass runs in-process with no live SSH or `aw-server`. `runOnce()` is the pass
 * each cron tick runs, exposed so the pull→then→sweep order is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEnforcementPipeline,
  type PipelineSshTransport,
} from "../../src/enforcement/pipeline.js";
import type { ForceCloseEventHub } from "../../src/enforcement/force-close-deps.js";
import type { SshCredentials } from "../../src/transport/ssh/index.js";
import type { AuditSink } from "../../src/transport/audit/index.js";
import type { AwEventSource } from "../../src/enforcement/telemetry-consumer.js";
import type { AwWindowEvent } from "../../src/transport/activitywatch/schemas.js";
import {
  activities,
  budgets,
  clients,
  users,
  usersOnClients,
  usageSamples,
} from "../../src/policy/schema.js";
import { saveTelemetryCursor } from "../../src/policy/telemetry-cursor.js";
import { buildApp } from "../../src/web/app.js";
import { loadSettings } from "../../src/config.js";
import { testDb, type TestDb } from "../helpers/db.js";

const CREDENTIALS: SshCredentials = { privateKey: "fake-key" };
const PASS_END = new Date("2024-02-15T12:00:00.000Z");

/** A fake `aw-server` returning the given window events within the query window. */
function fakeSource(windowEvents: AwWindowEvent[]): AwEventSource {
  return {
    getWindowEvents: (q) =>
      Promise.resolve(
        windowEvents.filter(
          (e) =>
            e.timestamp.getTime() >= q.start.getTime() && e.timestamp.getTime() < q.end.getTime(),
        ),
      ),
    getAfkEvents: () => Promise.resolve([]),
  };
}

/** A fake SSH transport whose port-forward runs the consumer against a stub URL. */
function fakeTransport(): PipelineSshTransport & { disposeAll: ReturnType<typeof vi.fn> } {
  return {
    withPortForward: <T>(
      _target: unknown,
      _remote: unknown,
      fn: (local: { host: string; port: number }) => Promise<T>,
    ): Promise<T> => fn({ host: "127.0.0.1", port: 54321 }),
    exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0, signal: null }),
    disposeAll: vi.fn(),
  };
}

describe("createEnforcementPipeline", () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;
  let eventHub: ForceCloseEventHub & { publishToClient: ReturnType<typeof vi.fn> };
  let sink: AuditSink & { record: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = testDb();
    app = buildApp({
      settings: loadSettings({ PCT_SECRET_KEY: "test-secret-key" }),
      db,
    });
    eventHub = { publishToClient: vi.fn(() => 1) };
    sink = { record: vi.fn() };
  });

  afterEach(async () => {
    await app.close();
    db.$client.close();
    vi.useRealTimers();
  });

  function baseOptions(overrides: Record<string, unknown> = {}) {
    return {
      db,
      eventHub,
      sink,
      log: app.log,
      defaultTz: "UTC",
      credentials: CREDENTIALS,
      pullCron: "*/5 * * * *",
      pullConcurrency: 4,
      cooldownSeconds: 300,
      initialLookbackSeconds: 3600,
      now: () => PASS_END,
      transport: fakeTransport(),
      loadClients: () => [{ id: 1, hostname: "alice-pc", sshUser: "pct-agent", sshTarget: null }],
      createSource: () => fakeSource([]),
      ...overrides,
    };
  }

  it("returns null when the SSH key is absent (no reachable client)", () => {
    expect(createEnforcementPipeline({ ...baseOptions(), credentials: null })).toBeNull();
  });

  it("runOnce pulls telemetry, then sweeps enforcement over the usage it wrote (#327)", async () => {
    // Fake timers so the force-close's grace setTimeout never fires (and leaks)
    // during the test; we assert the decision, not the delayed dispatch.
    vi.useFakeTimers();

    const clientId = db
      .insert(clients)
      .values({ hostname: "alice-pc", sshUser: "pct-agent" })
      .returning()
      .get().id;
    const userId = db.insert(users).values({ displayName: "Alice" }).returning().get().id;
    db.insert(usersOnClients)
      .values({ userId, clientId, osUsername: "alice", osUserRef: "1001" })
      .run();
    const firefoxId = db
      .insert(activities)
      .values({ kind: "app", matcher: "firefox" })
      .returning()
      .get().id;
    db.insert(budgets)
      .values({
        userId,
        scope: "activity",
        targetId: firefoxId,
        window: "daily",
        secondsAllowed: 1800,
      })
      .run();

    const pipeline = createEnforcementPipeline(
      baseOptions({
        loadClients: () => [
          { id: clientId, hostname: "alice-pc", sshUser: "pct-agent", sshTarget: null },
        ],
        // A full hour of firefox in this pass's window → 3600s > the 1800s budget.
        createSource: () =>
          fakeSource([
            {
              bucketId: "b",
              timestamp: new Date("2024-02-15T11:00:00.000Z"),
              durationSeconds: 3600,
              app: "firefox",
              title: "",
            },
          ]),
      }),
    );
    if (pipeline === null) throw new Error("expected a pipeline with credentials present");

    const result = await pipeline.runOnce();

    // The pull ran the consumer, which wrote the sample …
    expect(result.pull.succeeded).toBe(1);
    const rows = db.select().from(usageSamples).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, clientId, activityId: firefoxId });
    // … and the sweep, driven right after, saw that fresh usage exhaust the budget.
    expect(result.sweep.evaluated).toBe(1);
    expect(result.sweep.decisions).toBe(1);

    pipeline.stop();
  });

  it("seeds the in-memory cursor from the durable column so a restart resumes there (#382)", async () => {
    const clientId = db
      .insert(clients)
      .values({ hostname: "alice-pc", sshUser: "pct-agent" })
      .returning()
      .get().id;
    const userId = db.insert(users).values({ displayName: "Alice" }).returning().get().id;
    db.insert(usersOnClients)
      .values({ userId, clientId, osUsername: "alice", osUserRef: "1001" })
      .run();
    db.insert(activities).values({ kind: "app", matcher: "firefox" }).run();

    // A durable cursor persisted by an earlier process lifetime, 2 min before
    // this pass's end and well inside the 3600s initialLookback window — so the
    // observed query start distinguishes "seeded from the column" (11:58) from
    // "cold-start fallback" (11:00).
    const persisted = new Date("2024-02-15T11:58:00.000Z");
    saveTelemetryCursor(db, clientId, persisted);

    let observedStart: Date | null = null;
    const pipeline = createEnforcementPipeline(
      baseOptions({
        loadClients: () => [
          { id: clientId, hostname: "alice-pc", sshUser: "pct-agent", sshTarget: null },
        ],
        createSource: (): AwEventSource => ({
          getWindowEvents: (q) => {
            observedStart = q.start;
            return Promise.resolve([]);
          },
          getAfkEvents: () => Promise.resolve([]),
        }),
      }),
    );
    if (pipeline === null) throw new Error("expected a pipeline with credentials present");

    await pipeline.runOnce();

    // Resumed at the persisted cursor, not `passEnd − initialLookback`.
    expect(observedStart).toEqual(persisted);
    pipeline.stop();
  });

  it("skips enforcement cleanly on an empty fleet and disposes an owned transport on stop", () => {
    // No injected transport → the pipeline owns a real (unused) SshTransport and
    // must dispose it on stop without throwing. `transport: undefined` selects
    // that owned-transport default while keeping the object's other fields.
    const pipeline = createEnforcementPipeline(
      baseOptions({ loadClients: () => [], transport: undefined }),
    );
    if (pipeline === null) throw new Error("expected a pipeline with credentials present");
    pipeline.start();
    pipeline.start(); // idempotent — no throw, no second cron
    expect(() => pipeline.stop()).not.toThrow();
  });

  it("does not dispose an injected (caller-owned) transport on stop", () => {
    const transport = fakeTransport();
    const pipeline = createEnforcementPipeline(baseOptions({ loadClients: () => [], transport }));
    if (pipeline === null) throw new Error("expected a pipeline with credentials present");
    pipeline.start();
    pipeline.stop();
    // The caller owns an injected transport's lifecycle; stop() must not tear it
    // down (mirrors buildApp's db/policyPush ownership discipline).
    expect(transport.disposeAll).not.toHaveBeenCalled();
  });
});
