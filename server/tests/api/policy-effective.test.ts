/**
 * HTTP tests for the effective-policy preview route (#143):
 * `GET /api/users/:userId/effective?date=YYYY-MM-DD`, driven through the real
 * app via `app.inject()` with a genuine admin session cookie. Covers the
 * anonymous-401 guard, 404 for an unknown user, malformed/unreal dates (400),
 * the composed happy path, the default-to-today behaviour, and a future-dated
 * preview.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import {
  budgets,
  grants,
  groupSchedules,
  schedules,
  userGroupMemberships,
  userGroups,
} from "../../src/policy/schema.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "effective-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
  });
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie set");
  return match.split(";")[0] ?? "";
}

describe("GET /api/users/:userId/effective", () => {
  let harness: TestApp;
  let cookie: string;

  beforeEach(async () => {
    harness = buildTestApp({ appOptions: { settings: configuredSettings() } });
    await harness.app.ready();
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    cookie = sessionCookie(login);
  });

  afterEach(async () => {
    await harness.close();
  });

  function auth(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie } });
  }

  /** Create a supervised user via the API and return its id. */
  async function createUser(displayName: string, tz?: string): Promise<number> {
    const res = await auth({
      method: "POST",
      url: "/api/users",
      payload: tz === undefined ? { displayName } : { displayName, tz },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as number;
  }

  it("rejects anonymous access with a 401 envelope", async () => {
    const userId = await createUser("Alice");
    const res = await harness.app.inject({ method: "GET", url: `/api/users/${userId}/effective` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("returns 404 for an unknown user", async () => {
    const res = await auth({ method: "GET", url: "/api/users/9999/effective?date=2026-06-20" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("rejects a malformed date with a 400", async () => {
    const userId = await createUser("Alice");
    const res = await auth({
      method: "GET",
      url: `/api/users/${userId}/effective?date=not-a-date`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects a well-formed but unreal date with a 400", async () => {
    const userId = await createUser("Alice");
    const res = await auth({
      method: "GET",
      url: `/api/users/${userId}/effective?date=2026-02-30`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("composes schedules, budgets, and grants into the effective picture", async () => {
    const userId = await createUser("Alice"); // tz null → server default UTC
    // An all-days deny window 08:00–18:00 (480..1080).
    harness.db
      .insert(schedules)
      .values({
        userId,
        targetKind: "overall",
        targetId: null,
        action: "deny",
        recurrenceStartMinute: 480,
        recurrenceEndMinute: 1080,
        ordinal: 0,
      })
      .run();
    // Daily overall budget + a daily per-activity budget.
    harness.db
      .insert(budgets)
      .values([
        { userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 },
        { userId, scope: "activity", targetId: 5, window: "daily", secondsAllowed: 3600 },
      ])
      .run();
    // An active overall grant (+30 min): granted before, and expiring well
    // after, the queried day so it overlaps it deterministically. `grantedAt`
    // is set explicitly rather than defaulting to insertion time, which would
    // make the test a time-bomb — once the wall clock passes the hardcoded
    // 2026-06-20 query date, a now-defaulted grant falls *after* the queried
    // day and `grantOverlapsDay` (correctly) drops it.
    harness.db
      .insert(grants)
      .values({
        userId,
        scope: "overall",
        targetId: null,
        secondsGranted: 1800,
        grantedAt: new Date("2026-06-01T00:00:00Z"),
        expiresAt: new Date("2026-12-31T00:00:00Z"),
        source: "admin",
      })
      .run();

    const res = await auth({
      method: "GET",
      url: `/api/users/${userId}/effective?date=2026-06-20`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      date: "2026-06-20",
      tz: "UTC",
      allowedWindows: [
        { start: 0, end: 480 },
        { start: 1080, end: 1440 },
      ],
      overallSeconds: 9000,
      perActivitySeconds: [{ scope: "activity", targetId: 5, seconds: 3600 }],
      activeRules: [
        {
          id: expect.any(Number),
          targetKind: "overall",
          targetId: null,
          action: "deny",
          startMinute: 480,
          endMinute: 1080,
        },
      ],
    });
  });

  it("resolves a default-grantedAt grant by wall clock, not a fixed date (time-bomb guard, #254)", async () => {
    const userId = await createUser("Alice"); // tz null → server default UTC
    harness.db
      .insert(budgets)
      .values({ userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 })
      .run();
    // A grant that relies on the `grantedAt` DB default (insertion time = now) —
    // exactly the fixture shape that made #254's composing test a time-bomb.
    // This guard asserts the resolver's behaviour against *relative* dates
    // (today / a day well in the past) rather than a hardcoded one, so it pins
    // the wall-clock semantics without ever maturing into a time-bomb itself:
    // the canonical example of the safe pattern for date-windowed fixtures.
    harness.db
      .insert(grants)
      .values({
        userId,
        scope: "overall",
        targetId: null,
        secondsGranted: 1800,
        // grantedAt omitted on purpose → defaults to unixepoch() (now).
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        source: "admin",
      })
      .run();

    const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

    // Today (UTC): the just-inserted grant is live, so it composes (+1800).
    const today = await auth({
      method: "GET",
      url: `/api/users/${userId}/effective?date=${utcDate(new Date())}`,
    });
    expect(today.statusCode).toBe(200);
    expect(today.json().overallSeconds).toBe(9000);

    // A day well in the past: a grant created *now* cannot apply retroactively,
    // so the resolver (correctly) drops it and only the 7200 baseline remains.
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const pastRes = await auth({
      method: "GET",
      url: `/api/users/${userId}/effective?date=${utcDate(past)}`,
    });
    expect(pastRes.statusCode).toBe(200);
    expect(pastRes.json().overallSeconds).toBe(7200);
  });

  it("inherits a group schedule, with the user's own rule taking precedence (#182)", async () => {
    const userId = await createUser("Alice"); // tz null → UTC
    const group = harness.db
      .insert(userGroups)
      .values({ name: "Kids" })
      .returning({ id: userGroups.id })
      .get();
    if (group === undefined) throw new Error("group insert returned no row");
    harness.db.insert(userGroupMemberships).values({ userId, groupId: group.id }).run();

    // Group denies all day; with only the inherited rule, the day is fully denied.
    harness.db
      .insert(groupSchedules)
      .values({ userGroupId: group.id, targetKind: "overall", targetId: null, action: "deny" })
      .run();

    const inheritedOnly = await auth({
      method: "GET",
      url: `/api/users/${userId}/effective?date=2026-06-20`,
    });
    expect(inheritedOnly.json().allowedWindows).toEqual([]);
    expect(inheritedOnly.json().activeRules).toHaveLength(1);

    // The user's own always-on allow wins over the inherited group deny.
    harness.db
      .insert(schedules)
      .values({ userId, targetKind: "overall", targetId: null, action: "allow", ordinal: 0 })
      .run();

    const overridden = await auth({
      method: "GET",
      url: `/api/users/${userId}/effective?date=2026-06-20`,
    });
    expect(overridden.json().allowedWindows).toEqual([{ start: 0, end: 1440 }]);
    // Both rules surface in precedence order: the user's own allow first.
    expect(overridden.json().activeRules.map((r: { action: string }) => r.action)).toEqual([
      "allow",
      "deny",
    ]);
  });

  it("defaults to today in the user's effective timezone when no date is given", async () => {
    const userId = await createUser("Tokyo Kid", "Asia/Tokyo");
    const res = await auth({ method: "GET", url: `/api/users/${userId}/effective` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tz).toBe("Asia/Tokyo");
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // No rules/budgets → unrestricted day, no limit.
    expect(body.allowedWindows).toEqual([{ start: 0, end: 1440 }]);
    expect(body.overallSeconds).toBeNull();
  });

  it("previews a future-dated rule: inactive today, active once effective", async () => {
    const userId = await createUser("Alice");
    // An all-day deny that only takes effect from 2026-07-01.
    harness.db
      .insert(schedules)
      .values({
        userId,
        targetKind: "overall",
        targetId: null,
        action: "deny",
        effectiveFrom: new Date("2026-07-01T00:00:00Z"),
        ordinal: 0,
      })
      .run();

    const before = await auth({
      method: "GET",
      url: `/api/users/${userId}/effective?date=2026-06-20`,
    });
    expect(before.json().allowedWindows).toEqual([{ start: 0, end: 1440 }]);
    expect(before.json().activeRules).toEqual([]);

    const after = await auth({
      method: "GET",
      url: `/api/users/${userId}/effective?date=2026-07-15`,
    });
    expect(after.json().allowedWindows).toEqual([]);
    expect(after.json().activeRules).toHaveLength(1);
  });
});
