/**
 * HTTP tests for the schedule drag-to-reorder routes (#63):
 * `GET`/`PUT /api/users/:userId/schedules/order`, driven through the real app
 * via `app.inject()` with a genuine admin session cookie. Covers the
 * anonymous-401 guard, 404 for an unknown user, the order view's derived
 * `shadows` + `effectiveIds`, an atomic reorder (which flips both), and the
 * 409 a non-permutation reorder produces.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { schedules } from "../../src/policy/schema.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "schedule-order-test-secret",
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

describe("GET/PUT /api/users/:userId/schedules/order", () => {
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

  /** Insert an always-on schedule directly and return its id. */
  function addSchedule(
    userId: number,
    targetKind: "overall" | "activity" | "group",
    targetId: number | null,
    action: "allow" | "deny" | "extend",
    ordinal: number,
  ): number {
    const row = harness.db
      .insert(schedules)
      .values({ userId, targetKind, targetId, action, ordinal })
      .returning({ id: schedules.id })
      .get();
    if (row === undefined) throw new Error("schedule insert returned no row");
    return row.id;
  }

  it("rejects anonymous access with a 401 envelope", async () => {
    const userId = await createUser("Alice");
    const res = await harness.app.inject({
      method: "GET",
      url: `/api/users/${userId}/schedules/order`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("returns 404 for an unknown user (GET and PUT)", async () => {
    const get = await auth({ method: "GET", url: "/api/users/9999/schedules/order" });
    expect(get.statusCode).toBe(404);
    expect(get.json().error.code).toBe("not_found");

    const put = await auth({
      method: "PUT",
      url: "/api/users/9999/schedules/order",
      payload: { orderedIds: [1] },
    });
    expect(put.statusCode).toBe(404);
    expect(put.json().error.code).toBe("not_found");
  });

  it("returns the order view with shadows and the rules in effect now", async () => {
    const userId = await createUser("Alice"); // tz null → UTC
    // Two distinct activity targets; the third rule repeats a target an earlier
    // rule already governs, so it is shadowed (never reachable).
    const act5deny = addSchedule(userId, "activity", 5, "deny", 0);
    const act6deny = addSchedule(userId, "activity", 6, "deny", 1);
    const act5allow = addSchedule(userId, "activity", 5, "allow", 2);

    const res = await auth({ method: "GET", url: `/api/users/${userId}/schedules/order` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.schedules.map((s: { id: number }) => s.id)).toEqual([
      act5deny,
      act6deny,
      act5allow,
    ]);
    // The later activity:5 rule can never win — the earlier one always pre-empts it.
    expect(body.shadows).toEqual([{ shadowedId: act5allow, shadowedById: act5deny }]);
    // The first rule per target is in effect now (all rules are always-on); the
    // shadowed allow is never effective.
    expect([...body.effectiveIds].sort((a: number, b: number) => a - b)).toEqual(
      [act5deny, act6deny].sort((a, b) => a - b),
    );
  });

  it("atomically reorders, flipping the shadow and the in-effect rule", async () => {
    const userId = await createUser("Alice");
    const overallAllow = addSchedule(userId, "overall", null, "allow", 0);
    const overallDeny = addSchedule(userId, "overall", null, "deny", 1);

    const res = await auth({
      method: "PUT",
      url: `/api/users/${userId}/schedules/order`,
      payload: { orderedIds: [overallDeny, overallAllow] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // New order, dense ordinals.
    expect(body.schedules.map((s: { id: number }) => s.id)).toEqual([overallDeny, overallAllow]);
    expect(body.schedules.map((s: { ordinal: number }) => s.ordinal)).toEqual([0, 1]);
    // The deny now wins; the allow is now the shadowed one.
    expect(body.effectiveIds).toEqual([overallDeny]);
    expect(body.shadows).toEqual([{ shadowedId: overallAllow, shadowedById: overallDeny }]);

    // The reorder persisted: a fresh GET agrees.
    const after = await auth({ method: "GET", url: `/api/users/${userId}/schedules/order` });
    expect(after.json().schedules.map((s: { id: number }) => s.id)).toEqual([
      overallDeny,
      overallAllow,
    ]);
  });

  it("rejects a reorder that is not a permutation of the user's schedules with a 409", async () => {
    const userId = await createUser("Alice");
    const a = addSchedule(userId, "overall", null, "allow", 0);
    addSchedule(userId, "overall", null, "deny", 1);

    const res = await auth({
      method: "PUT",
      url: `/api/users/${userId}/schedules/order`,
      payload: { orderedIds: [a, 9999] }, // wrong length / unknown id
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
  });

  it("rejects an empty orderedIds list at the schema (400)", async () => {
    const userId = await createUser("Alice");
    const res = await auth({
      method: "PUT",
      url: `/api/users/${userId}/schedules/order`,
      payload: { orderedIds: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
