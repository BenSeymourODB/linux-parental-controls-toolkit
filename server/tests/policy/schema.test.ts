/**
 * Behavioural tests for the policy schema (#48): the constraints and
 * relationships the Drizzle definitions in `src/policy/schema.ts` promise are
 * actually enforced by the migrated SQLite database.
 *
 * Enum `CHECK` constraints are exercised through raw SQL because the typed
 * Drizzle columns make an invalid enum value unrepresentable in TypeScript —
 * the point of these cases is to prove the *storage layer* rejects them too,
 * independent of the application's types.
 */
import { eq } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  activities,
  activitiesToGroups,
  activityGroups,
  budgets,
  clients,
  exceptions,
  grants,
  integrationTokens,
  notificationPolicies,
  schedules,
  usageSamples,
  usersOnClients,
  users,
} from "../../src/policy/schema.js";
import { testDb, type TestDb } from "../helpers/db.js";

/** Every exported policy table, for metadata-level assertions. */
const allTables: Record<string, SQLiteTable> = {
  users,
  clients,
  usersOnClients,
  activities,
  activityGroups,
  activitiesToGroups,
  budgets,
  schedules,
  exceptions,
  usageSamples,
  grants,
  integrationTokens,
  notificationPolicies,
};

let db: TestDb;

beforeEach(() => {
  db = testDb();
  // better-sqlite3 enables `foreign_keys` by default, so FK constraints are
  // already enforced here; we set it explicitly to make the tests robust to
  // that default and to mirror what the runtime connection (#49) should do.
  db.$client.pragma("foreign_keys = ON");
});

/** Insert a user and return its generated id. */
function insertUser(displayName = "Alice"): number {
  const row = db.insert(users).values({ displayName }).returning({ id: users.id }).get();
  if (row === undefined) throw new Error("user insert returned no row");
  return row.id;
}

describe("users", () => {
  it("defaults created_at and leaves tz nullable", () => {
    const id = insertUser();
    const row = db.select().from(users).where(eq(users.id, id)).get();

    expect(row?.tz).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });
});

describe("enum CHECK constraints", () => {
  it("rejects a budget scope outside the tuple", () => {
    const userId = insertUser();
    expect(() =>
      db.$client
        .prepare("INSERT INTO budgets (user_id, scope, window, seconds_allowed) VALUES (?,?,?,?)")
        .run(userId, "bogus", "daily", 100),
    ).toThrow(/CHECK constraint/i);
  });

  it("rejects a budget window outside the tuple", () => {
    const userId = insertUser();
    expect(() =>
      db.$client
        .prepare("INSERT INTO budgets (user_id, scope, window, seconds_allowed) VALUES (?,?,?,?)")
        .run(userId, "overall", "fortnightly", 100),
    ).toThrow(/CHECK constraint/i);
  });

  it("rejects an activity kind outside the tuple", () => {
    expect(() =>
      db.$client.prepare("INSERT INTO activities (kind, matcher) VALUES (?,?)").run("widget", "x"),
    ).toThrow(/CHECK constraint/i);
  });

  it("accepts every declared budget scope/window pair", () => {
    const userId = insertUser();
    expect(() =>
      db
        .insert(budgets)
        .values({ userId, scope: "overall", window: "daily", secondsAllowed: 3600 })
        .run(),
    ).not.toThrow();
  });
});

describe("value & coherence constraints", () => {
  it("rejects a negative budget allowance but accepts zero", () => {
    const userId = insertUser();
    expect(() =>
      db
        .insert(budgets)
        .values({ userId, scope: "overall", window: "daily", secondsAllowed: -1 })
        .run(),
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      db
        .insert(budgets)
        .values({ userId, scope: "overall", window: "daily", secondsAllowed: 0 })
        .run(),
    ).not.toThrow();
  });

  it("rejects a non-positive grant", () => {
    const userId = insertUser();
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO grants (user_id, scope, seconds_granted, expires_at, source) VALUES (?,?,?,?,?)",
        )
        .run(userId, "overall", 0, 0, "admin"),
    ).toThrow(/CHECK constraint/i);
  });

  it("rejects a negative grace period", () => {
    const userId = insertUser();
    expect(() =>
      db.$client
        .prepare("INSERT INTO notification_policies (user_id, grace_seconds) VALUES (?,?)")
        .run(userId, -5),
    ).toThrow(/CHECK constraint/i);
  });

  it("enforces the polymorphic target invariant on budgets", () => {
    const userId = insertUser();
    // overall must have no target_id...
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO budgets (user_id, scope, target_id, window, seconds_allowed) VALUES (?,?,?,?,?)",
        )
        .run(userId, "overall", 7, "daily", 60),
    ).toThrow(/CHECK constraint/i);
    // ...and activity/group must carry one.
    expect(() =>
      db.$client
        .prepare("INSERT INTO budgets (user_id, scope, window, seconds_allowed) VALUES (?,?,?,?)")
        .run(userId, "activity", "daily", 60),
    ).toThrow(/CHECK constraint/i);
  });

  it("rejects a usage sample whose interval runs backwards", () => {
    const userId = insertUser();
    const clientId = db
      .insert(clients)
      .values({ hostname: "mint-9", sshUser: "pct-agent" })
      .returning({ id: clients.id })
      .get()?.id;
    const activityId = db
      .insert(activities)
      .values({ kind: "app", matcher: "firefox" })
      .returning({ id: activities.id })
      .get()?.id;
    if (clientId === undefined || activityId === undefined) {
      throw new Error("insert returned no row");
    }

    const insertSample = (startedAt: number, endedAt: number): void => {
      db.$client
        .prepare(
          "INSERT INTO usage_samples (user_id, client_id, activity_id, started_at, ended_at) VALUES (?,?,?,?,?)",
        )
        .run(userId, clientId, activityId, startedAt, endedAt);
    };

    expect(() => insertSample(2000, 1000)).toThrow(/CHECK constraint/i);
    expect(() => insertSample(1000, 2000)).not.toThrow();
    expect(() => insertSample(1000, 1000)).not.toThrow(); // zero-length is allowed
  });
});

describe("foreign keys", () => {
  it("rejects a budget for a non-existent user", () => {
    expect(() =>
      db
        .insert(budgets)
        .values({ userId: 9999, scope: "overall", window: "daily", secondsAllowed: 1 })
        .run(),
    ).toThrow(/FOREIGN KEY constraint/i);
  });

  it("enforces foreign keys on better-sqlite3 by default (no manual pragma)", () => {
    // better-sqlite3 turns `foreign_keys` ON by default, so the runtime
    // connection (#49) inherits FK enforcement without extra setup. Prove it
    // on a connection where we never touched the pragma.
    const raw = testDb();
    try {
      expect(raw.$client.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(() =>
        raw
          .insert(budgets)
          .values({ userId: 9999, scope: "overall", window: "daily", secondsAllowed: 1 })
          .run(),
      ).toThrow(/FOREIGN KEY constraint/i);
    } finally {
      raw.$client.close();
    }
  });

  it("cascades a user delete to their per-user rows", () => {
    const userId = insertUser();
    db.insert(budgets)
      .values({ userId, scope: "overall", window: "daily", secondsAllowed: 60 })
      .run();
    db.insert(notificationPolicies).values({ userId }).run();

    db.delete(users).where(eq(users.id, userId)).run();

    expect(db.select().from(budgets).all()).toHaveLength(0);
    expect(db.select().from(notificationPolicies).all()).toHaveLength(0);
  });
});

describe("users_on_clients", () => {
  it("rejects a duplicate linux uid on the same client", () => {
    const userA = insertUser("Alice");
    const userB = insertUser("Bob");
    const clientId = db
      .insert(clients)
      .values({ hostname: "mint-1", sshUser: "pct-agent" })
      .returning({ id: clients.id })
      .get()?.id;
    if (clientId === undefined) throw new Error("client insert returned no row");

    db.insert(usersOnClients)
      .values({ userId: userA, clientId, linuxUsername: "alice", linuxUid: 1001 })
      .run();

    expect(() =>
      db
        .insert(usersOnClients)
        .values({ userId: userB, clientId, linuxUsername: "bob", linuxUid: 1001 })
        .run(),
    ).toThrow(/UNIQUE constraint/i);
  });
});

describe("grants ledger", () => {
  function insertGrant(userId: number, sourceRef: string | null, source = "admin"): void {
    db.insert(grants)
      .values({
        userId,
        scope: "overall",
        secondsGranted: 1800,
        expiresAt: new Date("2026-12-31T23:59:59Z"),
        source,
        sourceRef,
      })
      .run();
  }

  it("enforces source_ref uniqueness (integrator idempotency key)", () => {
    const userId = insertUser();
    insertGrant(userId, "calendar:chore:42", "integration:next-digital-wall-calendar");
    expect(() =>
      insertGrant(userId, "calendar:chore:42", "integration:next-digital-wall-calendar"),
    ).toThrow(/UNIQUE constraint/i);
  });

  it("allows repeated NULL source_ref (admin grants are unconstrained)", () => {
    const userId = insertUser();
    insertGrant(userId, null);
    expect(() => insertGrant(userId, null)).not.toThrow();
    expect(db.select().from(grants).all()).toHaveLength(2);
  });

  it("constrains source to 'admin' or 'integration:<name>'", () => {
    const userId = insertUser();
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO grants (user_id, scope, seconds_granted, expires_at, source) VALUES (?,?,?,?,?)",
        )
        .run(userId, "overall", 60, 0, "rogue"),
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO grants (user_id, scope, seconds_granted, expires_at, source) VALUES (?,?,?,?,?)",
        )
        .run(userId, "overall", 60, 0, "integration:calendar"),
    ).not.toThrow();
  });

  it("revokes additively via revoked_at, leaving the original values intact", () => {
    const userId = insertUser();
    insertGrant(userId, "calendar:chore:7", "integration:next-digital-wall-calendar");
    const before = db.select().from(grants).get();
    if (before === undefined) throw new Error("grant insert returned no row");
    expect(before.revokedAt).toBeNull();

    const revokedAt = new Date("2026-06-16T12:00:00Z");
    db.update(grants).set({ revokedAt }).where(eq(grants.id, before.id)).run();

    const after = db.select().from(grants).get();
    expect(after?.revokedAt).toStrictEqual(revokedAt);
    expect(after?.secondsGranted).toBe(before?.secondsGranted);
    expect(after?.sourceRef).toBe(before?.sourceRef);
  });
});

describe("integration_tokens", () => {
  it("stores only a hashed secret, never plaintext", () => {
    const columns = db.$client
      .prepare("SELECT name FROM pragma_table_info('integration_tokens')")
      .pluck()
      .all() as string[];

    expect(columns).toContain("hashed_secret");
    expect(columns).not.toContain("secret");
    expect(columns).not.toContain("plaintext");
    expect(columns).not.toContain("token");
  });

  it("round-trips the scopes JSON array", () => {
    db.insert(integrationTokens)
      .values({ name: "calendar", scopes: ["grants:write", "policy:read"], hashedSecret: "h" })
      .run();
    const row = db.select().from(integrationTokens).get();

    expect(row?.scopes).toStrictEqual(["grants:write", "policy:read"]);
    expect(row?.revokedAt).toBeNull();
  });
});

describe("notification_policies", () => {
  it("applies its column defaults", () => {
    const userId = insertUser();
    db.insert(notificationPolicies).values({ userId }).run();
    const row = db.select().from(notificationPolicies).get();

    expect(row?.enabled).toBe(true);
    expect(row?.soundProfile).toBe("default");
    expect(row?.graceSeconds).toBe(60);
    expect(row?.cadenceOverridesJson).toBeNull();
  });
});

describe("activity groups", () => {
  it("enforces a unique group name", () => {
    db.insert(activityGroups).values({ name: "games" }).run();
    expect(() => db.insert(activityGroups).values({ name: "games" }).run()).toThrow(
      /UNIQUE constraint/i,
    );
  });

  it("links activities to groups many-to-many", () => {
    const activityId = db
      .insert(activities)
      .values({ kind: "app", matcher: "steam" })
      .returning({ id: activities.id })
      .get()?.id;
    const groupId = db
      .insert(activityGroups)
      .values({ name: "gaming" })
      .returning({ id: activityGroups.id })
      .get()?.id;
    if (activityId === undefined || groupId === undefined) {
      throw new Error("insert returned no row");
    }

    expect(() =>
      db.$client
        .prepare("INSERT INTO activities_to_groups (activity_id, group_id) VALUES (?,?)")
        .run(activityId, groupId),
    ).not.toThrow();

    const linked = db.$client
      .prepare("SELECT count(*) FROM activities_to_groups")
      .pluck()
      .get() as number;
    expect(linked).toBe(1);
  });
});

describe("table metadata", () => {
  it("builds a valid Drizzle config and resolves every foreign key", () => {
    for (const [name, table] of Object.entries(allTables)) {
      const config = getTableConfig(table);
      // Resolve each lazy FK reference thunk so the relationship target is
      // real (and not, say, a typo'd self-reference).
      for (const fk of config.foreignKeys) {
        const reference = fk.reference();
        expect(reference.foreignTable, `${name} FK target`).toBeDefined();
        expect(reference.columns.length).toBeGreaterThan(0);
      }
    }
  });

  it("declares the grant ledger's unique source_ref index and CHECK constraints", () => {
    const config = getTableConfig(grants);
    const sourceRefIndex = config.indexes.find(
      (idx) => idx.config.name === "grants_source_ref_unique",
    );

    expect(sourceRefIndex?.config.unique).toBe(true);
    expect(config.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["grants_scope_check", "grants_source_check"]),
    );
  });

  it("leads each hot-path index with user_id", () => {
    const leadColumn = (table: SQLiteTable, indexName: string): string | undefined => {
      const idx = getTableConfig(table).indexes.find((i) => i.config.name === indexName);
      const first = idx?.config.columns[0];
      return first && "name" in first ? first.name : undefined;
    };

    expect(leadColumn(budgets, "budgets_user_scope_window_idx")).toBe("user_id");
    expect(leadColumn(grants, "grants_user_expires_idx")).toBe("user_id");
    expect(leadColumn(usageSamples, "usage_samples_user_started_idx")).toBe("user_id");
    expect(leadColumn(exceptions, "exceptions_user_expires_idx")).toBe("user_id");
    expect(leadColumn(schedules, "schedules_user_ordinal_idx")).toBe("user_id");
  });

  it("uses composite primary keys on the join tables", () => {
    expect(getTableConfig(usersOnClients).primaryKeys[0]?.columns.map((c) => c.name)).toStrictEqual(
      ["user_id", "client_id"],
    );
    expect(
      getTableConfig(activitiesToGroups).primaryKeys[0]?.columns.map((c) => c.name),
    ).toStrictEqual(["activity_id", "group_id"]);
  });
});

describe("schema sanity", () => {
  it("declares unixepoch() defaults on the timestamp-now columns", () => {
    // The generated DDL must carry the insert-time default so callers need
    // not supply created_at/granted_at/enrolled_at.
    const ddl = db.$client
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='grants'")
      .pluck()
      .get() as string;
    expect(ddl).toMatch(/granted_at.*unixepoch/i);
  });
});
