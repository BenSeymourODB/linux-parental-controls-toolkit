/**
 * HTTP tests for the usage-views read API (#62):
 * `GET /api/users/:userId/usage/burndown` and `…/usage/timeline`, driven
 * through the real app via `app.inject()` with a genuine admin session cookie.
 *
 * Covers the anonymous-401 guard, 404 for an unknown user, the validation
 * failures (bad window / inverted range), the composed burndown happy path
 * (overall + per-activity + group consumption against baseline budgets), the
 * default window, the timeline happy path with lane labels, and the
 * effective-timezone window resolution.
 *
 * Fixtures anchor usage samples to **today's UTC midnight** rather than the
 * wall clock, so the assertions are deterministic regardless of the time of
 * day the suite runs and never mature into a time-bomb (#254).
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../../src/auth/session.js";
import { loadSettings } from "../../../src/config.js";
import {
  activities,
  activitiesToGroups,
  activityGroups,
  budgets,
  clients,
  usageSamples,
} from "../../../src/policy/schema.js";
import { buildTestApp, type TestApp } from "../../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "usage-test-secret",
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

/** Today's UTC midnight — the start of the `daily` window for a UTC user. */
function utcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** A Date `offsetMinutes` after today's UTC midnight (always within today). */
function todayAt(offsetMinutes: number): Date {
  return new Date(utcMidnight().getTime() + offsetMinutes * 60_000);
}

describe("usage views API", () => {
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

  async function createUser(displayName: string, tz?: string): Promise<number> {
    const res = await auth({
      method: "POST",
      url: "/api/users",
      payload: tz === undefined ? { displayName } : { displayName, tz },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as number;
  }

  function createClient(hostname: string): number {
    const row = harness.db
      .insert(clients)
      .values({ hostname, sshUser: "pct-agent" })
      .returning({ id: clients.id })
      .get();
    if (row === undefined) throw new Error("client insert returned no row");
    return row.id;
  }

  function createActivity(matcher: string): number {
    const row = harness.db
      .insert(activities)
      .values({ kind: "app", matcher })
      .returning({ id: activities.id })
      .get();
    if (row === undefined) throw new Error("activity insert returned no row");
    return row.id;
  }

  describe("GET /api/users/:userId/usage/burndown", () => {
    it("rejects anonymous access with a 401 envelope", async () => {
      const userId = await createUser("Alice");
      const res = await harness.app.inject({
        method: "GET",
        url: `/api/users/${userId}/usage/burndown`,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    });

    it("returns 404 for an unknown user", async () => {
      const res = await auth({ method: "GET", url: "/api/users/9999/usage/burndown" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    });

    it("rejects an unknown window with a 400", async () => {
      const userId = await createUser("Alice");
      const res = await auth({
        method: "GET",
        url: `/api/users/${userId}/usage/burndown?window=yearly`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    });

    it("composes overall, per-activity, and group consumption against the budgets", async () => {
      const userId = await createUser("Alice"); // tz null → UTC
      const clientId = createClient("mint-01");
      const games = createActivity("steam");
      const social = createActivity("discord");

      // Group "Fun" containing only the Games activity.
      const group = harness.db
        .insert(activityGroups)
        .values({ name: "Fun" })
        .returning({ id: activityGroups.id })
        .get();
      if (group === undefined) throw new Error("group insert returned no row");
      harness.db.insert(activitiesToGroups).values({ activityId: games, groupId: group.id }).run();

      // Daily budgets: overall, the Games activity, and the Fun group.
      harness.db
        .insert(budgets)
        .values([
          { userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 },
          { userId, scope: "activity", targetId: games, window: "daily", secondsAllowed: 3600 },
          { userId, scope: "group", targetId: group.id, window: "daily", secondsAllowed: 5400 },
          // A weekly budget that must NOT leak into the daily view.
          { userId, scope: "overall", targetId: null, window: "weekly", secondsAllowed: 36000 },
        ])
        .run();

      // 30 min of Games + 10 min of Social, both squarely within today.
      harness.db
        .insert(usageSamples)
        .values([
          { userId, clientId, activityId: games, startedAt: todayAt(60), endedAt: todayAt(90) },
          { userId, clientId, activityId: social, startedAt: todayAt(120), endedAt: todayAt(130) },
        ])
        .run();

      const res = await auth({
        method: "GET",
        url: `/api/users/${userId}/usage/burndown?window=daily`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.window).toBe("daily");
      expect(body.tz).toBe("UTC");

      interface BurndownRow {
        scope: string;
        targetId: number | null;
        allowedSeconds: number;
        consumedSeconds: number;
      }
      const byKey = new Map<string, BurndownRow>(
        (body.budgets as BurndownRow[]).map((b) => [`${b.scope}:${b.targetId ?? "null"}`, b]),
      );
      // Only the three daily budgets; the weekly one is filtered out.
      expect(body.budgets).toHaveLength(3);
      expect(byKey.get("overall:null")).toMatchObject({
        allowedSeconds: 7200,
        consumedSeconds: 2400, // 1800 Games + 600 Social
      });
      expect(byKey.get(`activity:${games}`)).toMatchObject({
        allowedSeconds: 3600,
        consumedSeconds: 1800,
      });
      expect(byKey.get(`group:${group.id}`)).toMatchObject({
        allowedSeconds: 5400,
        consumedSeconds: 1800, // only Games is in the group
      });
    });

    it("defaults to the daily window when none is given", async () => {
      const userId = await createUser("Alice");
      const res = await auth({ method: "GET", url: `/api/users/${userId}/usage/burndown` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.window).toBe("daily");
      // No budgets defined → no rows, but the window bounds are still returned.
      expect(body.budgets).toEqual([]);
      expect(body.windowStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.windowEnd).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("resolves the window in the user's effective timezone", async () => {
      const userId = await createUser("Tokyo Kid", "Asia/Tokyo");
      const res = await auth({ method: "GET", url: `/api/users/${userId}/usage/burndown` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tz).toBe("Asia/Tokyo");
      // A Tokyo daily window opens at 15:00 UTC the prior day (UTC+9 midnight).
      expect(body.windowStart.slice(11, 16)).toBe("15:00");
    });
  });

  describe("GET /api/users/:userId/usage/timeline", () => {
    it("rejects anonymous access with a 401 envelope", async () => {
      const userId = await createUser("Alice");
      const res = await harness.app.inject({
        method: "GET",
        url: `/api/users/${userId}/usage/timeline`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for an unknown user", async () => {
      const res = await auth({ method: "GET", url: "/api/users/9999/usage/timeline" });
      expect(res.statusCode).toBe(404);
    });

    it("rejects an inverted range with a 400", async () => {
      const userId = await createUser("Alice");
      const res = await auth({
        method: "GET",
        url: `/api/users/${userId}/usage/timeline?from=2026-06-20T10:00:00.000Z&to=2026-06-20T09:00:00.000Z`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    });

    it("returns the intervals overlapping the range plus their activity labels", async () => {
      const userId = await createUser("Alice");
      const clientId = createClient("mint-02");
      const games = createActivity("steam");

      const from = "2026-06-20T00:00:00.000Z";
      const to = "2026-06-20T23:59:59.000Z";
      harness.db
        .insert(usageSamples)
        .values({
          userId,
          clientId,
          activityId: games,
          startedAt: new Date("2026-06-20T08:00:00.000Z"),
          endedAt: new Date("2026-06-20T08:30:00.000Z"),
        })
        .run();

      const res = await auth({
        method: "GET",
        url: `/api/users/${userId}/usage/timeline?from=${from}&to=${to}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.from).toBe(from);
      expect(body.to).toBe(to);
      expect(body.activities).toEqual([{ id: games, kind: "app", matcher: "steam" }]);
      expect(body.samples).toEqual([
        {
          activityId: games,
          startedAt: "2026-06-20T08:00:00.000Z",
          endedAt: "2026-06-20T08:30:00.000Z",
        },
      ]);
    });

    it("defaults the range to the user's daily window", async () => {
      const userId = await createUser("Alice");
      const res = await auth({ method: "GET", url: `/api/users/${userId}/usage/timeline` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.from).toBe(utcMidnight().toISOString());
      expect(body.samples).toEqual([]);
      expect(body.activities).toEqual([]);
    });
  });
});
