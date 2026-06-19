/**
 * Unit tests for usage-sample persistence + budget rollups (#88).
 *
 * Hermetic: a fresh in-memory policy DB (`testDb()`) with FKs on, seeded with
 * the minimal user/client/activity rows the `usage_samples` FKs require. Covers
 * the `docs/testing.md` rollup expectations: clamped window overlap at both
 * edges, effective-timezone boundaries, per-activity grouping, group sum,
 * timeline ordering, and gap-conservatism (no samples → zero, never negative).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  activities,
  activityGroups,
  activitiesToGroups,
  clients,
  users,
} from "../../src/policy/schema.js";
import {
  activitySecondsInWindow,
  activityTimeline,
  groupSecondsInWindow,
  insertUsageSamples,
  usageByActivityInWindow,
  type UsageSampleInsert,
} from "../../src/policy/usage.js";
import { testDb, type TestDb } from "../helpers/db.js";

let db: TestDb;
let userId: number;
let clientId: number;
let firefoxId: number;
let codeId: number;

beforeEach(() => {
  db = testDb();
  userId = db.insert(users).values({ displayName: "Alice" }).returning().get().id;
  clientId = db
    .insert(clients)
    .values({ hostname: "alice-pc", sshUser: "pct-agent" })
    .returning()
    .get().id;
  firefoxId = db
    .insert(activities)
    .values({ kind: "app", matcher: "firefox" })
    .returning()
    .get().id;
  codeId = db.insert(activities).values({ kind: "app", matcher: "code" }).returning().get().id;
});

afterEach(() => {
  db.$client.close();
});

/** Build a sample for the seeded user/client. */
function sample(activityId: number, isoStart: string, isoEnd: string): UsageSampleInsert {
  return { userId, clientId, activityId, startedAt: new Date(isoStart), endedAt: new Date(isoEnd) };
}

describe("insertUsageSamples", () => {
  it("inserts a batch and reports the row count", () => {
    const count = insertUsageSamples(db, [
      sample(firefoxId, "2024-02-15T10:00:00.000Z", "2024-02-15T10:10:00.000Z"),
      sample(codeId, "2024-02-15T10:10:00.000Z", "2024-02-15T10:20:00.000Z"),
    ]);
    expect(count).toBe(2);
    expect(db.select().from(activities).all()).toHaveLength(2); // sanity: seed intact
    const stored = activityTimeline(db, {
      userId,
      from: new Date("2024-02-15T00:00:00.000Z"),
      to: new Date("2024-02-16T00:00:00.000Z"),
    });
    expect(stored).toHaveLength(2);
  });

  it("is a no-op for an empty batch", () => {
    expect(insertUsageSamples(db, [])).toBe(0);
  });
});

describe("activitySecondsInWindow", () => {
  it("credits a sample fully inside the window", () => {
    insertUsageSamples(db, [
      sample(firefoxId, "2024-02-15T10:00:00.000Z", "2024-02-15T10:30:00.000Z"),
    ]);
    const seconds = activitySecondsInWindow(db, {
      userId,
      activityId: firefoxId,
      window: "daily",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "UTC",
    });
    expect(seconds).toBe(1800);
  });

  it("clamps a sample straddling the window's start edge", () => {
    // Daily UTC window for 2024-02-15 is [00:00Z, next 00:00Z). A sample
    // 2024-02-14T23:30Z–2024-02-15T00:30Z contributes only its in-window half.
    insertUsageSamples(db, [
      sample(firefoxId, "2024-02-14T23:30:00.000Z", "2024-02-15T00:30:00.000Z"),
    ]);
    const seconds = activitySecondsInWindow(db, {
      userId,
      activityId: firefoxId,
      window: "daily",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "UTC",
    });
    expect(seconds).toBe(1800);
  });

  it("clamps a sample straddling the window's end edge", () => {
    insertUsageSamples(db, [
      sample(firefoxId, "2024-02-15T23:30:00.000Z", "2024-02-16T00:30:00.000Z"),
    ]);
    const seconds = activitySecondsInWindow(db, {
      userId,
      activityId: firefoxId,
      window: "daily",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "UTC",
    });
    expect(seconds).toBe(1800);
  });

  it("resolves the window boundary in the user's effective timezone", () => {
    // America/New_York is UTC-5 in February, so the local day 2024-02-15 is the
    // window [2024-02-15T05:00Z, 2024-02-16T05:00Z). A sample 04:30Z–05:30Z
    // contributes only the 05:00Z–05:30Z half (1800s); the pre-05:00Z portion
    // belongs to the previous local day.
    insertUsageSamples(db, [
      sample(firefoxId, "2024-02-15T04:30:00.000Z", "2024-02-15T05:30:00.000Z"),
    ]);
    const seconds = activitySecondsInWindow(db, {
      userId,
      activityId: firefoxId,
      window: "daily",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "America/New_York",
    });
    expect(seconds).toBe(1800);
  });

  it("rolls up over a weekly window, summing samples from across the ISO week", () => {
    // ISO week containing Thu 2024-02-15 is Mon 2024-02-12 00:00Z .. Mon
    // 2024-02-19 00:00Z (UTC). Two samples on different days both count.
    insertUsageSamples(db, [
      sample(firefoxId, "2024-02-12T08:00:00.000Z", "2024-02-12T08:30:00.000Z"), // 1800s, Mon
      sample(firefoxId, "2024-02-15T08:00:00.000Z", "2024-02-15T08:15:00.000Z"), // 900s, Thu
      // Sunday of the *next* ISO week → excluded.
      sample(firefoxId, "2024-02-19T08:00:00.000Z", "2024-02-19T08:30:00.000Z"),
    ]);
    const seconds = activitySecondsInWindow(db, {
      userId,
      activityId: firefoxId,
      window: "weekly",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "UTC",
    });
    expect(seconds).toBe(2700);
  });

  it("returns zero when the user has no samples (gap-conservative)", () => {
    const seconds = activitySecondsInWindow(db, {
      userId,
      activityId: firefoxId,
      window: "weekly",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "UTC",
    });
    expect(seconds).toBe(0);
  });
});

describe("usageByActivityInWindow", () => {
  it("sums per activity and omits activities with no usage in the window", () => {
    insertUsageSamples(db, [
      sample(firefoxId, "2024-02-15T09:00:00.000Z", "2024-02-15T09:20:00.000Z"), // 1200s
      sample(firefoxId, "2024-02-15T10:00:00.000Z", "2024-02-15T10:10:00.000Z"), // 600s
      sample(codeId, "2024-02-15T11:00:00.000Z", "2024-02-15T11:05:00.000Z"), // 300s
      // Outside the day: ignored.
      sample(codeId, "2024-02-16T11:00:00.000Z", "2024-02-16T11:30:00.000Z"),
    ]);
    const byActivity = usageByActivityInWindow(db, {
      userId,
      window: "daily",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "UTC",
    });
    expect(byActivity.get(firefoxId)).toBe(1800);
    expect(byActivity.get(codeId)).toBe(300);
    expect(byActivity.size).toBe(2);
  });

  it("is an empty map when there is no usage", () => {
    const byActivity = usageByActivityInWindow(db, {
      userId,
      window: "daily",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "UTC",
    });
    expect(byActivity.size).toBe(0);
  });
});

describe("groupSecondsInWindow", () => {
  it("sums consumption across every activity in the group", () => {
    const groupId = db
      .insert(activityGroups)
      .values({ name: "browsers-and-editors" })
      .returning()
      .get().id;
    db.insert(activitiesToGroups)
      .values([
        { activityId: firefoxId, groupId },
        { activityId: codeId, groupId },
      ])
      .run();
    insertUsageSamples(db, [
      sample(firefoxId, "2024-02-15T09:00:00.000Z", "2024-02-15T09:10:00.000Z"), // 600s
      sample(codeId, "2024-02-15T10:00:00.000Z", "2024-02-15T10:05:00.000Z"), // 300s
    ]);
    const seconds = groupSecondsInWindow(db, {
      userId,
      groupId,
      window: "daily",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "UTC",
    });
    expect(seconds).toBe(900);
  });

  it("excludes activities that are not members of the group", () => {
    const groupId = db.insert(activityGroups).values({ name: "browsers" }).returning().get().id;
    db.insert(activitiesToGroups)
      .values([{ activityId: firefoxId, groupId }])
      .run();
    insertUsageSamples(db, [
      sample(firefoxId, "2024-02-15T09:00:00.000Z", "2024-02-15T09:10:00.000Z"), // 600s, in group
      sample(codeId, "2024-02-15T10:00:00.000Z", "2024-02-15T10:30:00.000Z"), // not in group
    ]);
    const seconds = groupSecondsInWindow(db, {
      userId,
      groupId,
      window: "daily",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "UTC",
    });
    expect(seconds).toBe(600);
  });

  it("credits zero for an empty group", () => {
    const groupId = db.insert(activityGroups).values({ name: "empty" }).returning().get().id;
    insertUsageSamples(db, [
      sample(firefoxId, "2024-02-15T09:00:00.000Z", "2024-02-15T09:10:00.000Z"),
    ]);
    const seconds = groupSecondsInWindow(db, {
      userId,
      groupId,
      window: "daily",
      now: new Date("2024-02-15T12:00:00.000Z"),
      tz: "UTC",
    });
    expect(seconds).toBe(0);
  });
});

describe("activityTimeline", () => {
  it("returns raw overlapping samples ordered by start, excluding those outside the range", () => {
    insertUsageSamples(db, [
      sample(codeId, "2024-02-15T11:00:00.000Z", "2024-02-15T11:30:00.000Z"),
      sample(firefoxId, "2024-02-15T09:00:00.000Z", "2024-02-15T09:30:00.000Z"),
      // Ends before the range starts → excluded.
      sample(firefoxId, "2024-02-15T07:00:00.000Z", "2024-02-15T07:30:00.000Z"),
    ]);
    const timeline = activityTimeline(db, {
      userId,
      from: new Date("2024-02-15T08:00:00.000Z"),
      to: new Date("2024-02-15T12:00:00.000Z"),
    });
    expect(timeline.map((row) => row.activityId)).toEqual([firefoxId, codeId]);
    expect(timeline[0]?.startedAt).toEqual(new Date("2024-02-15T09:00:00.000Z"));
  });

  it("includes a sample that overlaps the range boundary", () => {
    insertUsageSamples(db, [
      sample(firefoxId, "2024-02-15T07:30:00.000Z", "2024-02-15T08:30:00.000Z"),
    ]);
    const timeline = activityTimeline(db, {
      userId,
      from: new Date("2024-02-15T08:00:00.000Z"),
      to: new Date("2024-02-15T12:00:00.000Z"),
    });
    expect(timeline).toHaveLength(1);
  });
});
