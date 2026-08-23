/**
 * HTTP tests for the PIN-scoped per-child status read (#110):
 * `GET /api/app/status`.
 *
 * Covers the deny-by-default scoping (anonymous and admin sessions are both
 * refused; a PIN session reaches only its own data), the composed overall +
 * per-activity time-left numbers against today's usage, the no-budget empty
 * state, and the two clock-robust access shapes — unrestricted (`allowedNow`
 * true, no upcoming transition) and an all-day deny (`allowedNow` false). The
 * transition *boundary* logic is exhaustively unit-tested in
 * `tests/policy/next-transition.test.ts`; here we only assert it is wired in.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config.js";
import { PIN_SESSION_COOKIE } from "../../src/auth/pin-session.js";
import { SESSION_COOKIE } from "../../src/auth/session.js";
import {
  activities,
  activityGroups,
  activitiesToGroups,
  budgets,
  clients,
  schedules,
  usageSamples,
} from "../../src/policy/schema.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "app-status-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
  });
}

/** Pull a named cookie's `name=value` pair out of a response's set-cookie header. */
function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no ${name} cookie set`);
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

describe("GET /api/app/status", () => {
  let harness: TestApp;
  let adminCookie: string;

  beforeEach(async () => {
    harness = buildTestApp({ appOptions: { settings: configuredSettings() } });
    await harness.app.ready();
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    adminCookie = cookieFrom(login, SESSION_COOKIE);
  });

  afterEach(async () => {
    await harness.close();
  });

  function asAdmin(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie: adminCookie } });
  }

  async function createUser(displayName: string, tz?: string): Promise<number> {
    const res = await asAdmin({
      method: "POST",
      url: "/api/users",
      payload: tz === undefined ? { displayName } : { displayName, tz },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as number;
  }

  /** Set a PIN via admin, then log the child in and return their session cookie. */
  async function pinLogin(userId: number, pin: string): Promise<string> {
    const set = await asAdmin({ method: "PUT", url: `/api/users/${userId}/pin`, payload: { pin } });
    expect(set.statusCode).toBe(200);
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/app/session",
      payload: { userId, pin },
    });
    expect(login.statusCode).toBe(200);
    return cookieFrom(login, PIN_SESSION_COOKIE);
  }

  function asChild(cookie: string, opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie } });
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

  // --- deny-by-default scoping ----------------------------------------------

  it("refuses an anonymous caller with a 401", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/api/app/status" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("refuses an admin session (PIN scope only)", async () => {
    const res = await asAdmin({ method: "GET", url: "/api/app/status" });
    expect(res.statusCode).toBe(401);
  });

  // --- composed status ------------------------------------------------------

  it("composes overall and per-activity time-left against today's usage", async () => {
    const userId = await createUser("Alice"); // tz null → UTC
    const cookie = await pinLogin(userId, "4242");
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

    harness.db
      .insert(budgets)
      .values([
        { userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 },
        { userId, scope: "activity", targetId: games, window: "daily", secondsAllowed: 3600 },
        { userId, scope: "group", targetId: group.id, window: "daily", secondsAllowed: 5400 },
      ])
      .run();

    // 30 min of Games + 10 min of Social, both squarely within today (UTC).
    harness.db
      .insert(usageSamples)
      .values([
        { userId, clientId, activityId: games, startedAt: todayAt(60), endedAt: todayAt(90) },
        { userId, clientId, activityId: social, startedAt: todayAt(120), endedAt: todayAt(130) },
      ])
      .run();

    const res = await asChild(cookie, { method: "GET", url: "/api/app/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.user).toEqual({ id: userId, displayName: "Alice" });
    expect(body.tz).toBe("UTC");
    expect(typeof body.now).toBe("string");

    // Overall consumed = 30m Games + 10m Social = 2400s; of 7200s ⇒ 4800 left.
    expect(body.overall).toEqual({
      allowedSeconds: 7200,
      consumedSeconds: 2400,
      remainingSeconds: 4800,
    });

    // Per-activity rows are the budgeted set, labelled and with time left.
    const gamesRow = body.activities.find(
      (a: { scope: string; targetId: number }) => a.scope === "activity" && a.targetId === games,
    );
    expect(gamesRow).toEqual({
      scope: "activity",
      targetId: games,
      label: "steam",
      activityKind: "app",
      allowedSeconds: 3600,
      consumedSeconds: 1800,
      remainingSeconds: 1800,
    });

    const groupRow = body.activities.find(
      (a: { scope: string; targetId: number }) => a.scope === "group" && a.targetId === group.id,
    );
    expect(groupRow).toEqual({
      scope: "group",
      targetId: group.id,
      label: "Fun",
      activityKind: null,
      allowedSeconds: 5400,
      consumedSeconds: 1800, // only Games is in the group
      remainingSeconds: 3600,
    });

    // No overall schedule ⇒ unrestricted access, no upcoming transition.
    expect(body.access.allowedNow).toBe(true);
    expect(body.access.nextTransition).toBeNull();
  });

  it("reports no limit and no rows when the user has no budgets", async () => {
    const userId = await createUser("Bob");
    const cookie = await pinLogin(userId, "1357");

    const res = await asChild(cookie, { method: "GET", url: "/api/app/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.overall).toEqual({
      allowedSeconds: null,
      consumedSeconds: 0,
      remainingSeconds: null,
    });
    expect(body.activities).toEqual([]);
  });

  it("clamps remaining to zero when the budget is over-run", async () => {
    const userId = await createUser("Cara");
    const cookie = await pinLogin(userId, "2468");
    const clientId = createClient("mint-02");
    const games = createActivity("minecraft");

    harness.db
      .insert(budgets)
      .values([{ userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 600 }])
      .run();
    // 30 min used against a 10 min budget.
    harness.db
      .insert(usageSamples)
      .values([
        { userId, clientId, activityId: games, startedAt: todayAt(60), endedAt: todayAt(90) },
      ])
      .run();

    const res = await asChild(cookie, { method: "GET", url: "/api/app/status" });
    const body = res.json();
    expect(body.overall).toEqual({
      allowedSeconds: 600,
      consumedSeconds: 1800,
      remainingSeconds: 0,
    });
  });

  it("reports access denied now when an all-day deny is in effect", async () => {
    const userId = await createUser("Dan");
    const cookie = await pinLogin(userId, "9753");

    // An always-on overall deny ⇒ no allowed windows any day.
    harness.db
      .insert(schedules)
      .values([{ userId, targetKind: "overall", targetId: null, action: "deny", ordinal: 0 }])
      .run();

    const res = await asChild(cookie, { method: "GET", url: "/api/app/status" });
    const body = res.json();
    expect(body.access.allowedNow).toBe(false);
    // Denied straight through today and tomorrow ⇒ no upcoming transition.
    expect(body.access.nextTransition).toBeNull();
  });

  it("scopes strictly to the session's own user", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const bobCookie = await pinLogin(bob, "1111");
    // Give Alice a budget; Bob's status must not reflect it.
    harness.db
      .insert(budgets)
      .values([
        { userId: alice, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 },
      ])
      .run();

    const res = await asChild(bobCookie, { method: "GET", url: "/api/app/status" });
    const body = res.json();
    expect(body.user.id).toBe(bob);
    expect(body.overall.allowedSeconds).toBeNull(); // Bob has no budget of his own
  });

  it("resolves the user's effective timezone", async () => {
    const userId = await createUser("Eve", "America/New_York");
    const cookie = await pinLogin(userId, "3141");
    const res = await asChild(cookie, { method: "GET", url: "/api/app/status" });
    expect(res.json().tz).toBe("America/New_York");
  });
});
