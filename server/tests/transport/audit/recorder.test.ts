/**
 * Unit tests for the audit recorder primitives (#85): `redactArgv` and the
 * `DrizzleAuditSink`.
 *
 * The sink is exercised against a real in-memory policy DB (`testDb`) so the
 * `audit_log` migration, the column mapping, and the `system`/null defaults are
 * all confirmed end-to-end; the swallow-on-error contract is checked with a
 * deliberately closed handle.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditLog, clients, users } from "../../../src/policy/schema.js";
import type { AuditEntry } from "../../../src/transport/audit/recorder.js";
import { REDACTED, redactArgv } from "../../../src/transport/audit/recorder.js";
import { DEFAULT_ACTOR, DrizzleAuditSink } from "../../../src/transport/audit/sink.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const TARGET = { host: "client.local", port: 22, username: "pct-agent" };

/** A minimal successful entry, overridable per test. */
function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    target: TARGET,
    command: ["sudo", "timekpra", "--userinfo", "alice"],
    outcome: "ok",
    exitCode: 0,
    signal: null,
    durationMs: 12,
    errorMessage: null,
    context: {},
    ...overrides,
  };
}

describe("redactArgv", () => {
  it("passes through a command with no secret-bearing flags", () => {
    const argv = ["sudo", "timekpra", "--setalloweddays", "alice", "1;2;3;4;5"];
    expect(redactArgv(argv)).toEqual(argv);
  });

  it("masks the value following a sensitive flag (space form)", () => {
    expect(redactArgv(["tool", "--password", "hunter2", "--port", "22"])).toEqual([
      "tool",
      "--password",
      REDACTED,
      "--port",
      "22",
    ]);
  });

  it("masks the value in a --flag=value form, case-insensitively", () => {
    expect(redactArgv(["tool", "--API-KEY=abc123", "next"])).toEqual([
      "tool",
      `--API-KEY=${REDACTED}`,
      "next",
    ]);
  });

  it("masks several sensitive flags and short forms", () => {
    expect(redactArgv(["tool", "--token", "t", "--secret", "s"])).toEqual([
      "tool",
      "--token",
      REDACTED,
      "--secret",
      REDACTED,
    ]);
  });

  it("does not invent a value when a sensitive flag is the final argument", () => {
    expect(redactArgv(["tool", "--password"])).toEqual(["tool", "--password"]);
  });

  it("returns a fresh array, leaving the input untouched", () => {
    const argv = ["a", "b"];
    const out = redactArgv(argv);
    expect(out).not.toBe(argv);
    expect(argv).toEqual(["a", "b"]);
  });
});

describe("DrizzleAuditSink", () => {
  let db: TestDb;

  beforeEach(() => {
    db = testDb();
  });

  afterEach(() => {
    db.$client.close();
  });

  it("persists an entry with every field mapped", () => {
    const sink = new DrizzleAuditSink(db);
    sink.record(
      entry({
        command: ["sudo", "timekpra", "--setlimit", "alice"],
        context: { clientId: null, userId: null, actor: "admin", reason: "manual push" },
      }),
    );

    const rows = db.select().from(auditLog).all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      targetHost: "client.local",
      targetPort: 22,
      targetUser: "pct-agent",
      clientId: null,
      userId: null,
      actor: "admin",
      reason: "manual push",
      command: ["sudo", "timekpra", "--setlimit", "alice"],
      outcome: "ok",
      exitCode: 0,
      signal: null,
      durationMs: 12,
      errorMessage: null,
    });
    expect(row?.at).toBeInstanceOf(Date);
  });

  it("defaults a missing actor to 'system' and null context to null columns", () => {
    const sink = new DrizzleAuditSink(db);
    sink.record(entry());

    const row = db.select().from(auditLog).all()[0];
    expect(row?.actor).toBe(DEFAULT_ACTOR);
    expect(row?.clientId).toBeNull();
    expect(row?.userId).toBeNull();
    expect(row?.reason).toBeNull();
  });

  it("records a failure outcome with exit status, error message, and FK attribution", () => {
    // The client/user FKs require real rows (foreign_keys is ON), so an entry
    // attributed to a client/user references ones that exist.
    db.insert(clients).values({ id: 7, hostname: "box7", sshUser: "pct-agent" }).run();
    db.insert(users).values({ id: 3, displayName: "Alice" }).run();
    const sink = new DrizzleAuditSink(db);
    sink.record(
      entry({
        outcome: "failed",
        exitCode: 2,
        signal: null,
        errorMessage: "Remote command failed (exit code 2)",
        context: { clientId: 7, userId: 3, actor: "system" },
      }),
    );

    const row = db.select().from(auditLog).all()[0];
    expect(row).toMatchObject({
      outcome: "failed",
      exitCode: 2,
      errorMessage: "Remote command failed (exit code 2)",
      clientId: 7,
      userId: 3,
    });
  });

  it("keeps the entry but nulls client_id when the client is deleted (ON DELETE SET NULL)", () => {
    db.insert(clients).values({ id: 7, hostname: "box7", sshUser: "pct-agent" }).run();
    const sink = new DrizzleAuditSink(db);
    sink.record(entry({ context: { clientId: 7 } }));

    db.delete(clients).where(eq(clients.id, 7)).run();

    const row = db.select().from(auditLog).all()[0];
    // The append-only audit history survives the client's removal.
    expect(row).toBeDefined();
    expect(row?.clientId).toBeNull();
    expect(row?.targetHost).toBe("client.local");
  });

  it("swallows a write failure and reports it to the logger (never throws)", () => {
    const logged: { obj: object; msg: string }[] = [];
    const sink = new DrizzleAuditSink(db, {
      error: (obj, msg) => logged.push({ obj, msg }),
    });
    // Close the underlying handle so the insert throws inside record().
    db.$client.close();

    expect(() => sink.record(entry())).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.msg).toMatch(/failed to record/i);
    expect(logged[0]?.obj).toMatchObject({ event: "audit_record_failed" });

    // Re-open a handle so afterEach's close() is a no-op on a fresh db.
    db = testDb();
  });

  it("swallows a write failure with no logger configured", () => {
    const sink = new DrizzleAuditSink(db);
    db.$client.close();
    expect(() => sink.record(entry())).not.toThrow();
    db = testDb();
  });
});
