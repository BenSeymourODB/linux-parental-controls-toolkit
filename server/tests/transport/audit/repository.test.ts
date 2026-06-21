/**
 * Unit tests for the audit read repository (#85): ordering, filters, the id
 * cursor, and the limit — against a real in-memory policy DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditOutcome } from "../../../src/policy/enums.js";
import { clients } from "../../../src/policy/schema.js";
import { DrizzleAuditSink } from "../../../src/transport/audit/sink.js";
import { listAuditEntries } from "../../../src/transport/audit/repository.js";
import type { AuditEntry } from "../../../src/transport/audit/recorder.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const TARGET = { host: "client.local", port: 22, username: "pct-agent" };

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    target: TARGET,
    command: ["sudo", "timekpra", "--userinfo", "alice"],
    outcome: "ok",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    errorMessage: null,
    context: {},
    ...overrides,
  };
}

describe("listAuditEntries", () => {
  let db: TestDb;
  let sink: DrizzleAuditSink;

  beforeEach(() => {
    db = testDb();
    sink = new DrizzleAuditSink(db);
    // The audit client_id FK requires real client rows (foreign_keys is ON).
    for (const id of [1, 2]) {
      db.insert(clients)
        .values({ id, hostname: `box${id}`, sshUser: "pct-agent" })
        .run();
    }
  });

  afterEach(() => {
    db.$client.close();
  });

  /** Insert `n` entries (each with an optional override built from its index). */
  function seed(n: number, build: (i: number) => Partial<AuditEntry> = () => ({})): void {
    for (let i = 0; i < n; i += 1) sink.record(entry(build(i)));
  }

  it("returns entries newest-first (id descending)", () => {
    seed(3, (i) => ({ context: { reason: `r${i}` } }));
    const rows = listAuditEntries(db, { limit: 10 });
    expect(rows.map((r) => r.reason)).toEqual(["r2", "r1", "r0"]);
  });

  it("caps the result at the requested limit", () => {
    seed(5);
    expect(listAuditEntries(db, { limit: 2 })).toHaveLength(2);
  });

  it("returns an empty list when the log is empty", () => {
    expect(listAuditEntries(db, { limit: 10 })).toEqual([]);
  });

  it("filters by clientId", () => {
    sink.record(entry({ context: { clientId: 1 } }));
    sink.record(entry({ context: { clientId: 2 } }));
    sink.record(entry({ context: { clientId: 1 } }));
    const rows = listAuditEntries(db, { clientId: 1, limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.clientId === 1)).toBe(true);
  });

  it("filters by outcome", () => {
    const outcomes: AuditOutcome[] = ["ok", "failed", "unreachable", "ok"];
    for (const outcome of outcomes) sink.record(entry({ outcome }));
    const rows = listAuditEntries(db, { outcome: "ok", limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.outcome === "ok")).toBe(true);
  });

  it("returns only entries older than the before cursor", () => {
    seed(5, (i) => ({ context: { reason: `r${i}` } }));
    const all = listAuditEntries(db, { limit: 10 });
    const cursor = all[1]?.id ?? 0; // points at r3 (second-newest)
    const older = listAuditEntries(db, { before: cursor, limit: 10 });
    expect(older.map((r) => r.reason)).toEqual(["r2", "r1", "r0"]);
  });

  it("combines clientId, outcome, and before in one query", () => {
    sink.record(entry({ outcome: "failed", context: { clientId: 1, reason: "a" } })); // 1
    sink.record(entry({ outcome: "ok", context: { clientId: 1, reason: "b" } })); // 2
    sink.record(entry({ outcome: "failed", context: { clientId: 1, reason: "c" } })); // 3
    sink.record(entry({ outcome: "failed", context: { clientId: 2, reason: "d" } })); // 4
    const all = listAuditEntries(db, { limit: 10 }); // [4, 3, 2, 1]
    const cursor = all[1]?.id ?? 0; // entry "c" (id 3)
    const rows = listAuditEntries(db, {
      clientId: 1,
      outcome: "failed",
      before: cursor,
      limit: 10,
    });
    // Older than "c", client 1, failed → only "a" (entry 2 is ok; 3/4 not older).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: 1, outcome: "failed", reason: "a" });
  });
});
