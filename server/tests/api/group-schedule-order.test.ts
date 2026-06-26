/**
 * HTTP tests for the group-schedule drag-to-reorder routes (#270):
 * `GET`/`PUT /api/user-groups/:groupId/schedules/order`, driven through the
 * real app via `app.inject()` with a genuine admin session cookie. Covers the
 * anonymous-401 guard, 404 for an unknown group, the order view's derived
 * `shadows`, an atomic reorder (which flips the shadow), and the 409 a
 * non-permutation reorder produces.
 *
 * The group view intentionally has **no** `effectiveIds` — a group has no single
 * timezone, so "in effect now" is resolved per member, not for the group (#270).
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { groupSchedules, userGroups } from "../../src/policy/schema.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "group-schedule-order-test-secret",
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

describe("GET/PUT /api/user-groups/:groupId/schedules/order", () => {
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

  /** Insert a user group directly and return its id. */
  function createGroup(name: string): number {
    const row = harness.db
      .insert(userGroups)
      .values({ name })
      .returning({ id: userGroups.id })
      .get();
    if (row === undefined) throw new Error("user group insert returned no row");
    return row.id;
  }

  /** Insert an always-on group schedule directly and return its id. */
  function addGroupSchedule(
    userGroupId: number,
    targetKind: "overall" | "activity" | "group",
    targetId: number | null,
    action: "allow" | "deny" | "extend",
    ordinal: number,
  ): number {
    const row = harness.db
      .insert(groupSchedules)
      .values({ userGroupId, targetKind, targetId, action, ordinal })
      .returning({ id: groupSchedules.id })
      .get();
    if (row === undefined) throw new Error("group schedule insert returned no row");
    return row.id;
  }

  it("rejects anonymous access with a 401 envelope", async () => {
    const groupId = createGroup("Kids");
    const res = await harness.app.inject({
      method: "GET",
      url: `/api/user-groups/${groupId}/schedules/order`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("returns 404 for an unknown group (GET and PUT)", async () => {
    const get = await auth({ method: "GET", url: "/api/user-groups/9999/schedules/order" });
    expect(get.statusCode).toBe(404);
    expect(get.json().error.code).toBe("not_found");

    const put = await auth({
      method: "PUT",
      url: "/api/user-groups/9999/schedules/order",
      payload: { orderedIds: [1] },
    });
    expect(put.statusCode).toBe(404);
    expect(put.json().error.code).toBe("not_found");
  });

  it("returns the order view with shadows, and omits effectiveIds", async () => {
    const groupId = createGroup("Kids");
    // Two distinct activity targets; the third rule repeats a target an earlier
    // rule already governs, so it is shadowed (never reachable).
    const act5deny = addGroupSchedule(groupId, "activity", 5, "deny", 0);
    const act6deny = addGroupSchedule(groupId, "activity", 6, "deny", 1);
    const act5allow = addGroupSchedule(groupId, "activity", 5, "allow", 2);

    const res = await auth({ method: "GET", url: `/api/user-groups/${groupId}/schedules/order` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.schedules.map((s: { id: number }) => s.id)).toEqual([
      act5deny,
      act6deny,
      act5allow,
    ]);
    expect(body.schedules.every((s: { userGroupId: number }) => s.userGroupId === groupId)).toBe(
      true,
    );
    // The later activity:5 rule can never win — the earlier one always pre-empts it.
    expect(body.shadows).toEqual([{ shadowedId: act5allow, shadowedById: act5deny }]);
    // No timezone-bound "in effect now" for a group view.
    expect(body).not.toHaveProperty("effectiveIds");
  });

  it("atomically reorders, flipping the shadow", async () => {
    const groupId = createGroup("Kids");
    const overallAllow = addGroupSchedule(groupId, "overall", null, "allow", 0);
    const overallDeny = addGroupSchedule(groupId, "overall", null, "deny", 1);

    const res = await auth({
      method: "PUT",
      url: `/api/user-groups/${groupId}/schedules/order`,
      payload: { orderedIds: [overallDeny, overallAllow] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // New order, dense ordinals.
    expect(body.schedules.map((s: { id: number }) => s.id)).toEqual([overallDeny, overallAllow]);
    expect(body.schedules.map((s: { ordinal: number }) => s.ordinal)).toEqual([0, 1]);
    // The allow is now the shadowed one (the deny above always wins for overall).
    expect(body.shadows).toEqual([{ shadowedId: overallAllow, shadowedById: overallDeny }]);

    // The reorder persisted: a fresh GET agrees.
    const after = await auth({
      method: "GET",
      url: `/api/user-groups/${groupId}/schedules/order`,
    });
    expect(after.json().schedules.map((s: { id: number }) => s.id)).toEqual([
      overallDeny,
      overallAllow,
    ]);
  });

  it("rejects a reorder that is not a permutation of the group's schedules with a 409", async () => {
    const groupId = createGroup("Kids");
    const a = addGroupSchedule(groupId, "overall", null, "allow", 0);
    addGroupSchedule(groupId, "overall", null, "deny", 1);

    const res = await auth({
      method: "PUT",
      url: `/api/user-groups/${groupId}/schedules/order`,
      payload: { orderedIds: [a, 9999] }, // wrong length / unknown id
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
  });

  it("rejects an empty orderedIds list at the schema (400)", async () => {
    const groupId = createGroup("Kids");
    const res = await auth({
      method: "PUT",
      url: `/api/user-groups/${groupId}/schedules/order`,
      payload: { orderedIds: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
