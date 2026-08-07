/**
 * Unit tests for the durable telemetry pull cursor (#382): the
 * `loadTelemetryCursors` / `saveTelemetryCursor` DB access on
 * `clients.last_telemetry_pull_at`. Runs against a migrated in-memory DB.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { clients } from "../../src/policy/schema.js";
import { loadTelemetryCursors, saveTelemetryCursor } from "../../src/policy/telemetry-cursor.js";
import { testDb, type TestDb } from "../helpers/db.js";

describe("telemetry cursor persistence", () => {
  let db: TestDb;

  beforeEach(() => {
    db = testDb();
  });

  /** Insert a client, return its id. */
  function seedClient(hostname: string): number {
    return db.insert(clients).values({ hostname, sshUser: "pct-agent" }).returning().get().id;
  }

  /** Read the persisted cursor column for one client. */
  function persistedCursor(clientId: number): Date | null {
    const row = db
      .select({ lastTelemetryPullAt: clients.lastTelemetryPullAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    if (row === undefined) throw new Error(`no client ${clientId}`);
    return row.lastTelemetryPullAt;
  }

  it("returns an empty map when no client has a cursor", () => {
    seedClient("fresh-pc");
    expect(loadTelemetryCursors(db).size).toBe(0);
  });

  it("saveTelemetryCursor writes the window end to the client row", () => {
    const clientId = seedClient("alice-pc");
    const end = new Date("2024-02-15T12:00:00.000Z");

    saveTelemetryCursor(db, clientId, end);

    expect(persistedCursor(clientId)).toEqual(end);
  });

  it("loadTelemetryCursors returns only clients with a persisted cursor, keyed by id", () => {
    const withCursor = seedClient("alice-pc");
    const withoutCursor = seedClient("bob-pc");
    const end = new Date("2024-02-15T12:00:00.000Z");
    saveTelemetryCursor(db, withCursor, end);

    const cursors = loadTelemetryCursors(db);

    expect(cursors.size).toBe(1);
    expect(cursors.get(withCursor)).toEqual(end);
    expect(cursors.has(withoutCursor)).toBe(false);
  });

  it("saveTelemetryCursor overwrites an earlier value (a later pass advances it)", () => {
    const clientId = seedClient("alice-pc");
    const earlier = new Date("2024-02-15T12:00:00.000Z");
    const later = new Date("2024-02-15T12:05:00.000Z");

    saveTelemetryCursor(db, clientId, earlier);
    saveTelemetryCursor(db, clientId, later);

    expect(persistedCursor(clientId)).toEqual(later);
    expect(loadTelemetryCursors(db).get(clientId)).toEqual(later);
  });

  it("keeps cursors independent per client", () => {
    const alice = seedClient("alice-pc");
    const bob = seedClient("bob-pc");
    const aliceEnd = new Date("2024-02-15T12:00:00.000Z");
    const bobEnd = new Date("2024-02-15T13:30:00.000Z");

    saveTelemetryCursor(db, alice, aliceEnd);
    saveTelemetryCursor(db, bob, bobEnd);

    const cursors = loadTelemetryCursors(db);
    expect(cursors.get(alice)).toEqual(aliceEnd);
    expect(cursors.get(bob)).toEqual(bobEnd);
  });
});
