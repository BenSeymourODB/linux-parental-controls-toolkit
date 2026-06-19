/**
 * Tests for the enforcement DB seam (#98) against a hermetic in-memory policy
 * DB (`testDb()`, FKs on). Exercises the full path: effective per-activity /
 * per-group quota (incl. the active-grant overlay) vs. the daily usage rollup,
 * the grace period read from `notification_policies` (and its default), the
 * "no daily budget ⇒ unlimited" case, and cool-down threading.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluateUserEnforcement } from "../../src/enforcement/evaluate.js";
import {
  activities,
  activitiesToGroups,
  activityGroups,
  budgets,
  clients,
  grants,
  notificationPolicies,
  users,
} from "../../src/policy/schema.js";
import { insertUsageSamples } from "../../src/policy/usage.js";
import { testDb, type TestDb } from "../helpers/db.js";

// A fixed reference day; the daily UTC window is [2024-02-15T00:00Z, +1d).
const NOW = new Date("2024-02-15T12:00:00.000Z");
const DAY_START = new Date("2024-02-15T00:00:00.000Z");
const DAY_END = new Date("2024-02-16T00:00:00.000Z");

let db: TestDb;
let userId: number;
let clientId: number;
let firefoxId: number;

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
});

afterEach(() => {
  db.$client.close();
});

/** Insert one firefox usage sample in the reference window. */
function seedFirefoxUsage(isoStart: string, isoEnd: string): void {
  insertUsageSamples(db, [
    {
      userId,
      clientId,
      activityId: firefoxId,
      startedAt: new Date(isoStart),
      endedAt: new Date(isoEnd),
    },
  ]);
}

describe("evaluateUserEnforcement", () => {
  it("fires when an activity's daily usage crosses its budget, with default grace", () => {
    db.insert(budgets)
      .values({
        userId,
        scope: "activity",
        targetId: firefoxId,
        window: "daily",
        secondsAllowed: 1800,
      })
      .run();
    seedFirefoxUsage("2024-02-15T10:00:00.000Z", "2024-02-15T11:00:00.000Z"); // 3600s

    const out = evaluateUserEnforcement(
      db,
      { userId, now: NOW, tz: "UTC", cooldownSeconds: 300 },
      new Map(),
    );

    expect(out.decisions).toEqual([
      {
        scope: "activity",
        targetId: firefoxId,
        allowedSeconds: 1800,
        consumedSeconds: 3600,
        overageSeconds: 1800,
        graceSeconds: 60, // schema default — no notification_policies row
      },
    ]);
    expect(out.lastFiredAt.get(`activity:${firefoxId}`)).toEqual(NOW);
  });

  it("does not fire while usage is under the budget", () => {
    db.insert(budgets)
      .values({
        userId,
        scope: "activity",
        targetId: firefoxId,
        window: "daily",
        secondsAllowed: 7200,
      })
      .run();
    seedFirefoxUsage("2024-02-15T10:00:00.000Z", "2024-02-15T11:00:00.000Z"); // 3600s < 7200

    const out = evaluateUserEnforcement(
      db,
      { userId, now: NOW, tz: "UTC", cooldownSeconds: 300 },
      new Map(),
    );
    expect(out.decisions).toHaveLength(0);
  });

  it("rolls group usage up across the group's members for a group budget", () => {
    const groupId = db.insert(activityGroups).values({ name: "social" }).returning().get().id;
    db.insert(activitiesToGroups).values({ groupId, activityId: firefoxId }).run();
    db.insert(budgets)
      .values({ userId, scope: "group", targetId: groupId, window: "daily", secondsAllowed: 1800 })
      .run();
    seedFirefoxUsage("2024-02-15T10:00:00.000Z", "2024-02-15T11:00:00.000Z"); // 3600s via the group

    const out = evaluateUserEnforcement(
      db,
      { userId, now: NOW, tz: "UTC", cooldownSeconds: 300 },
      new Map(),
    );

    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.scope).toBe("group");
    expect(out.decisions[0]?.targetId).toBe(groupId);
    expect(out.decisions[0]?.consumedSeconds).toBe(3600);
  });

  it("does not fire when an active grant lifts the effective quota above usage", () => {
    db.insert(budgets)
      .values({
        userId,
        scope: "activity",
        targetId: firefoxId,
        window: "daily",
        secondsAllowed: 1800,
      })
      .run();
    db.insert(grants)
      .values({
        userId,
        scope: "activity",
        targetId: firefoxId,
        secondsGranted: 3600, // 1800 + 3600 = 5400 effective
        source: "admin",
        grantedAt: DAY_START,
        expiresAt: DAY_END,
      })
      .run();
    seedFirefoxUsage("2024-02-15T09:00:00.000Z", "2024-02-15T10:00:00.000Z"); // 3600s < 5400

    const out = evaluateUserEnforcement(
      db,
      { userId, now: NOW, tz: "UTC", cooldownSeconds: 300 },
      new Map(),
    );
    expect(out.decisions).toHaveLength(0);
  });

  it("uses the grace period from the user's notification policy when present", () => {
    db.insert(notificationPolicies).values({ userId, graceSeconds: 120 }).run();
    db.insert(budgets)
      .values({
        userId,
        scope: "activity",
        targetId: firefoxId,
        window: "daily",
        secondsAllowed: 600,
      })
      .run();
    seedFirefoxUsage("2024-02-15T10:00:00.000Z", "2024-02-15T10:30:00.000Z"); // 1800s > 600

    const out = evaluateUserEnforcement(
      db,
      { userId, now: NOW, tz: "UTC", cooldownSeconds: 300 },
      new Map(),
    );
    expect(out.decisions[0]?.graceSeconds).toBe(120);
  });

  it("treats a budgeted activity with no usage as zero-consumed (no decision)", () => {
    db.insert(budgets)
      .values({
        userId,
        scope: "activity",
        targetId: firefoxId,
        window: "daily",
        secondsAllowed: 600,
      })
      .run();
    // No usage samples seeded — the activity is absent from the rollup map, so
    // the seam credits 0 consumed (the `?? 0` fallback) and nothing fires.
    const out = evaluateUserEnforcement(
      db,
      { userId, now: NOW, tz: "UTC", cooldownSeconds: 300 },
      new Map(),
    );
    expect(out.decisions).toHaveLength(0);
  });

  it("treats an activity with usage but no daily budget as unlimited (no decision)", () => {
    seedFirefoxUsage("2024-02-15T10:00:00.000Z", "2024-02-15T14:00:00.000Z"); // lots of usage, no budget
    const out = evaluateUserEnforcement(
      db,
      { userId, now: NOW, tz: "UTC", cooldownSeconds: 300 },
      new Map(),
    );
    expect(out.decisions).toHaveLength(0);
  });

  it("threads cool-down state through so a recent fire is suppressed", () => {
    db.insert(budgets)
      .values({
        userId,
        scope: "activity",
        targetId: firefoxId,
        window: "daily",
        secondsAllowed: 600,
      })
      .run();
    seedFirefoxUsage("2024-02-15T10:00:00.000Z", "2024-02-15T11:00:00.000Z"); // over budget

    const recent = new Date(NOW.getTime() - 100_000); // within the 300s cool-down
    const out = evaluateUserEnforcement(
      db,
      { userId, now: NOW, tz: "UTC", cooldownSeconds: 300 },
      new Map([[`activity:${firefoxId}`, recent]]),
    );
    expect(out.decisions).toHaveLength(0);
    expect(out.lastFiredAt.get(`activity:${firefoxId}`)).toEqual(recent);
  });
});
