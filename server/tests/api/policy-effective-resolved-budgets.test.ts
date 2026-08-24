/**
 * HTTP tests for the inherited-vs-local budget projection (#363):
 * `GET /api/users/:userId/budgets/resolved`. Driven through the real app via
 * `app.inject()` with a genuine admin session cookie. Covers the anonymous-401
 * guard, 404 for an unknown user, own budgets tagged `user`, inherited group
 * budgets tagged `group`, and the own-wins precedence (an own budget suppresses
 * the inherited slot). The endpoint is a display-only projection of
 * `gatherUserBudgets`; resolution semantics themselves are covered by the
 * group-resolution unit tests.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import {
  budgets,
  groupBudgets,
  userGroupMemberships,
  userGroups,
} from "../../src/policy/schema.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "resolved-budgets-test-secret",
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

describe("GET /api/users/:userId/budgets/resolved", () => {
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

  async function createUser(displayName: string): Promise<number> {
    const res = await auth({ method: "POST", url: "/api/users", payload: { displayName } });
    expect(res.statusCode).toBe(201);
    return res.json().id as number;
  }

  function makeGroup(name: string, userId: number): number {
    const group = harness.db
      .insert(userGroups)
      .values({ name })
      .returning({ id: userGroups.id })
      .get();
    if (group === undefined) throw new Error("group insert returned no row");
    harness.db.insert(userGroupMemberships).values({ userId, groupId: group.id }).run();
    return group.id;
  }

  it("rejects anonymous access with a 401 envelope", async () => {
    const userId = await createUser("Alice");
    const res = await harness.app.inject({
      method: "GET",
      url: `/api/users/${userId}/budgets/resolved`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("returns 404 for an unknown user", async () => {
    const res = await auth({ method: "GET", url: "/api/users/9999/budgets/resolved" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("tags a user's own budgets with source user", async () => {
    const userId = await createUser("Alice");
    harness.db
      .insert(budgets)
      .values({ userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 })
      .run();

    const res = await auth({ method: "GET", url: `/api/users/${userId}/budgets/resolved` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        scope: "overall",
        targetId: null,
        window: "daily",
        secondsAllowed: 7200,
        recurrenceDays: null,
        source: { kind: "user" },
      },
    ]);
  });

  it("tags an inherited group budget with source group and the group id", async () => {
    const userId = await createUser("Alice");
    const groupId = makeGroup("Kids", userId);
    harness.db
      .insert(groupBudgets)
      .values({
        userGroupId: groupId,
        scope: "overall",
        targetId: null,
        window: "daily",
        secondsAllowed: 7200,
      })
      .run();

    const res = await auth({ method: "GET", url: `/api/users/${userId}/budgets/resolved` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        scope: "overall",
        targetId: null,
        window: "daily",
        secondsAllowed: 7200,
        recurrenceDays: null,
        source: { kind: "group", groupId },
      },
    ]);
  });

  it("an own budget suppresses the inherited slot (own-wins precedence)", async () => {
    const userId = await createUser("Alice");
    const groupId = makeGroup("Kids", userId);
    // Group and user both set a daily overall budget for the same slot.
    harness.db
      .insert(groupBudgets)
      .values({
        userGroupId: groupId,
        scope: "overall",
        targetId: null,
        window: "daily",
        secondsAllowed: 7200,
      })
      .run();
    harness.db
      .insert(budgets)
      .values({ userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 1800 })
      .run();

    const res = await auth({ method: "GET", url: `/api/users/${userId}/budgets/resolved` });
    expect(res.statusCode).toBe(200);
    // Only the own budget remains for the overall/daily slot — the group slot is
    // suppressed, not summed.
    expect(res.json()).toEqual([
      {
        scope: "overall",
        targetId: null,
        window: "daily",
        secondsAllowed: 1800,
        recurrenceDays: null,
        source: { kind: "user" },
      },
    ]);
  });
});
