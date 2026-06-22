/**
 * HTTP tests for the account/device-core CRUD routes (#51), driven through the
 * real app via `app.inject()` with a genuine admin session cookie — per
 * docs/testing.md → "HTTP routes". Covers happy paths, validation failures,
 * the anonymous-401 guard, 404s, and 409 conflicts for each entity.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

/** Settings with a secret and a seeded admin (`ben` / `hunter2`). */
function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "policy-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
  });
}

/** Pull the `pct_session=<signed>` wire cookie out of a login response. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie set");
  return match.split(";")[0] ?? "";
}

describe("policy CRUD routes", () => {
  let harness: TestApp;
  let cookie: string;

  beforeEach(async () => {
    harness = buildTestApp({ appOptions: { settings: configuredSettings() } });
    await harness.app.ready(); // triggers first-admin bootstrap
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

  /** Inject with the admin session cookie attached. */
  function auth(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie } });
  }

  // --- auth guard ----------------------------------------------------------

  it("rejects anonymous access to every collection with a 401 envelope", async () => {
    for (const url of ["/api/users", "/api/clients"]) {
      const res = await harness.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    }
  });

  it("rejects an anonymous write with a 401", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/users",
      payload: { displayName: "Mallory" },
    });
    expect(res.statusCode).toBe(401);
  });

  // --- users ---------------------------------------------------------------

  it("creates a user (201) and reads it back", async () => {
    const created = await auth({
      method: "POST",
      url: "/api/users",
      payload: { displayName: "Alice", tz: "Europe/London" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ displayName: "Alice", tz: "Europe/London" });
    expect(typeof body.id).toBe("number");
    expect(typeof body.createdAt).toBe("string");

    const list = await auth({ method: "GET", url: "/api/users" });
    expect(list.json()).toEqual([body]);

    const one = await auth({ method: "GET", url: `/api/users/${body.id}` });
    expect(one.json()).toEqual(body);
  });

  it("rejects an invalid timezone with a 400 validation envelope", async () => {
    const res = await auth({
      method: "POST",
      url: "/api/users",
      payload: { displayName: "Alice", tz: "Mars/Phobos" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects an empty user body with a 400", async () => {
    const res = await auth({ method: "POST", url: "/api/users", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("patches a user, clearing tz with an explicit null", async () => {
    const created = (
      await auth({
        method: "POST",
        url: "/api/users",
        payload: { displayName: "Alice", tz: "Europe/London" },
      })
    ).json();

    const patched = await auth({
      method: "PATCH",
      url: `/api/users/${created.id}`,
      payload: { tz: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ displayName: "Alice", tz: null });
  });

  it("rejects a no-op (empty) PATCH with a 400", async () => {
    const created = (
      await auth({ method: "POST", url: "/api/users", payload: { displayName: "Alice" } })
    ).json();
    const res = await auth({ method: "PATCH", url: `/api/users/${created.id}`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("deletes a user (204) and 404s afterwards", async () => {
    const created = (
      await auth({ method: "POST", url: "/api/users", payload: { displayName: "Alice" } })
    ).json();
    const del = await auth({ method: "DELETE", url: `/api/users/${created.id}` });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");

    const missing = await auth({ method: "GET", url: `/api/users/${created.id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });

  it("404s on patch/delete of a missing user", async () => {
    const patch = await auth({
      method: "PATCH",
      url: "/api/users/999",
      payload: { displayName: "x" },
    });
    expect(patch.statusCode).toBe(404);
    const del = await auth({ method: "DELETE", url: "/api/users/999" });
    expect(del.statusCode).toBe(404);
  });

  it("rejects a non-numeric id with a 400", async () => {
    const res = await auth({ method: "GET", url: "/api/users/abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  // --- clients -------------------------------------------------------------

  it("creates a client (201), updates it, and lists it", async () => {
    const created = await auth({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "mint-01", sshUser: "pct-agent" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ hostname: "mint-01", sshUser: "pct-agent", lastSeen: null });

    const patched = await auth({
      method: "PATCH",
      url: `/api/clients/${body.id}`,
      payload: { hostname: "mint-renamed" },
    });
    expect(patched.json().hostname).toBe("mint-renamed");

    const one = await auth({ method: "GET", url: `/api/clients/${body.id}` });
    expect(one.json()).toMatchObject({ id: body.id, hostname: "mint-renamed" });

    const list = await auth({ method: "GET", url: "/api/clients" });
    expect(list.json()).toHaveLength(1);
  });

  it("409s on a duplicate hostname", async () => {
    await auth({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "dup", sshUser: "pct-agent" },
    });
    const conflict = await auth({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "dup", sshUser: "pct-agent" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("conflict");
  });

  it("409s when a client PATCH collides with another hostname", async () => {
    await auth({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "taken", sshUser: "pct-agent" },
    });
    const second = (
      await auth({
        method: "POST",
        url: "/api/clients",
        payload: { hostname: "free", sshUser: "pct-agent" },
      })
    ).json();
    const res = await auth({
      method: "PATCH",
      url: `/api/clients/${second.id}`,
      payload: { hostname: "taken" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects an empty hostname with a 400 and 404s a missing client", async () => {
    const bad = await auth({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "", sshUser: "pct-agent" },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await auth({ method: "GET", url: "/api/clients/999" });
    expect(missing.statusCode).toBe(404);
  });

  it("404s on patch/delete of a missing client", async () => {
    const patch = await auth({
      method: "PATCH",
      url: "/api/clients/999",
      payload: { sshUser: "pct-agent" },
    });
    expect(patch.statusCode).toBe(404);
    expect(patch.json().error.code).toBe("not_found");

    const del = await auth({ method: "DELETE", url: "/api/clients/999" });
    expect(del.statusCode).toBe(404);
  });

  it("deletes a client (204)", async () => {
    const created = (
      await auth({
        method: "POST",
        url: "/api/clients",
        payload: { hostname: "to-remove", sshUser: "pct-agent" },
      })
    ).json();
    const del = await auth({ method: "DELETE", url: `/api/clients/${created.id}` });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");
  });

  // --- links ---------------------------------------------------------------

  async function makeUserAndClient(): Promise<{ userId: number; clientId: number }> {
    const userId = (
      await auth({ method: "POST", url: "/api/users", payload: { displayName: "Alice" } })
    ).json().id;
    const clientId = (
      await auth({
        method: "POST",
        url: "/api/clients",
        payload: { hostname: "mint-01", sshUser: "pct-agent" },
      })
    ).json().id;
    return { userId, clientId };
  }

  it("upserts a link and lists it under the user", async () => {
    const { userId, clientId } = await makeUserAndClient();
    const put = await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ userId, clientId, linuxUsername: "alice", linuxUid: 1001 });

    const list = await auth({ method: "GET", url: `/api/users/${userId}/clients` });
    expect(list.json()).toHaveLength(1);

    // Idempotent replace.
    const again = await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice2", linuxUid: 1002 },
    });
    expect(again.json().linuxUid).toBe(1002);
    expect(
      (await auth({ method: "GET", url: `/api/users/${userId}/clients` })).json(),
    ).toHaveLength(1);
  });

  it("404s a link PUT when the user or client is missing", async () => {
    const { userId, clientId } = await makeUserAndClient();
    const noUser = await auth({
      method: "PUT",
      url: `/api/users/999/clients/${clientId}`,
      payload: { linuxUsername: "x", linuxUid: 1001 },
    });
    expect(noUser.statusCode).toBe(404);
    const noClient = await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/999`,
      payload: { linuxUsername: "x", linuxUid: 1001 },
    });
    expect(noClient.statusCode).toBe(404);
  });

  it("404s listing links for a missing user", async () => {
    const res = await auth({ method: "GET", url: "/api/users/999/clients" });
    expect(res.statusCode).toBe(404);
  });

  it("409s when a UID is already mapped to another user on the same client", async () => {
    const { userId, clientId } = await makeUserAndClient();
    const otherUser = (
      await auth({ method: "POST", url: "/api/users", payload: { displayName: "Bob" } })
    ).json().id;
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });
    const conflict = await auth({
      method: "PUT",
      url: `/api/users/${otherUser}/clients/${clientId}`,
      payload: { linuxUsername: "bob", linuxUid: 1001 },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("deletes a link (204) and 404s afterwards", async () => {
    const { userId, clientId } = await makeUserAndClient();
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });
    const del = await auth({ method: "DELETE", url: `/api/users/${userId}/clients/${clientId}` });
    expect(del.statusCode).toBe(204);
    const again = await auth({ method: "DELETE", url: `/api/users/${userId}/clients/${clientId}` });
    expect(again.statusCode).toBe(404);
  });
});

describe("policy CRUD routes — policy model (#148)", () => {
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

  async function makeUser(displayName = "Alice"): Promise<number> {
    return (await auth({ method: "POST", url: "/api/users", payload: { displayName } })).json().id;
  }

  async function makeActivity(matcher = "firefox"): Promise<number> {
    return (
      await auth({ method: "POST", url: "/api/activities", payload: { kind: "app", matcher } })
    ).json().id;
  }

  // --- auth guard ----------------------------------------------------------

  it("rejects anonymous access to the new collections with a 401", async () => {
    for (const url of [
      "/api/activities",
      "/api/activity-groups",
      "/api/budgets",
      "/api/schedules",
      "/api/exceptions",
    ]) {
      const res = await harness.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    }
  });

  // --- activities ----------------------------------------------------------

  it("CRUDs an activity", async () => {
    const created = await auth({
      method: "POST",
      url: "/api/activities",
      payload: { kind: "domain", matcher: "youtube.com" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    // match_type defaults to the v1 'exact' when the client omits it (ADR 0006).
    expect(body).toMatchObject({ kind: "domain", matcher: "youtube.com", matchType: "exact" });

    const patched = await auth({
      method: "PATCH",
      url: `/api/activities/${body.id}`,
      payload: { matcher: "m.youtube.com" },
    });
    expect(patched.json().matcher).toBe("m.youtube.com");

    expect((await auth({ method: "GET", url: "/api/activities" })).json()).toHaveLength(1);

    const del = await auth({ method: "DELETE", url: `/api/activities/${body.id}` });
    expect(del.statusCode).toBe(204);
    expect((await auth({ method: "GET", url: `/api/activities/${body.id}` })).statusCode).toBe(404);
  });

  it("rejects an invalid activity kind (400) and an empty PATCH (400)", async () => {
    const bad = await auth({
      method: "POST",
      url: "/api/activities",
      payload: { kind: "nonsense", matcher: "x" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("validation_error");

    const id = await makeActivity();
    const empty = await auth({ method: "PATCH", url: `/api/activities/${id}`, payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it("round-trips an explicit match_type and validates regex patterns (#178, ADR 0006)", async () => {
    // Create with an explicit non-default match_type.
    const created = await auth({
      method: "POST",
      url: "/api/activities",
      payload: { kind: "app", matcher: "(chrome|chromium)", matchType: "regex" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ matcher: "(chrome|chromium)", matchType: "regex" });

    // GET echoes the stored match_type.
    expect(
      (await auth({ method: "GET", url: `/api/activities/${body.id}` })).json().matchType,
    ).toBe("regex");

    // PATCH the match_type alone.
    const patched = await auth({
      method: "PATCH",
      url: `/api/activities/${body.id}`,
      payload: { matchType: "substring" },
    });
    expect(patched.json().matchType).toBe("substring");

    // An invalid match_type enum value is a 400.
    const badType = await auth({
      method: "POST",
      url: "/api/activities",
      payload: { kind: "app", matcher: "x", matchType: "fuzzy" },
    });
    expect(badType.statusCode).toBe(400);

    // An uncompilable regex is rejected at create time (DTO-level).
    const badCreate = await auth({
      method: "POST",
      url: "/api/activities",
      payload: { kind: "app", matcher: "([unterminated", matchType: "regex" },
    });
    expect(badCreate.statusCode).toBe(400);
    expect(badCreate.json().error.code).toBe("validation_error");

    // And on PATCH, the effective (merged) pair is validated: flipping an
    // existing literal matcher to match_type=regex when it isn't a valid
    // pattern is a 400 even though the matcher field is unchanged.
    const literal = await makeActivity("([not-a-regex");
    const badPatch = await auth({
      method: "PATCH",
      url: `/api/activities/${literal}`,
      payload: { matchType: "regex" },
    });
    expect(badPatch.statusCode).toBe(400);
    expect(badPatch.json().error.code).toBe("validation_error");
  });

  // --- activity groups + membership ----------------------------------------

  it("CRUDs a group and manages its membership", async () => {
    const group = (
      await auth({ method: "POST", url: "/api/activity-groups", payload: { name: "Social" } })
    ).json();
    expect(group.name).toBe("Social");

    const dup = await auth({
      method: "POST",
      url: "/api/activity-groups",
      payload: { name: "Social" },
    });
    expect(dup.statusCode).toBe(409);

    const fb = await makeActivity("facebook.com");
    const put = await auth({
      method: "PUT",
      url: `/api/activity-groups/${group.id}/activities/${fb}`,
    });
    expect(put.statusCode).toBe(204);
    // Idempotent re-add.
    expect(
      (await auth({ method: "PUT", url: `/api/activity-groups/${group.id}/activities/${fb}` }))
        .statusCode,
    ).toBe(204);

    const members = await auth({
      method: "GET",
      url: `/api/activity-groups/${group.id}/activities`,
    });
    expect(members.json()).toHaveLength(1);
    expect(members.json()[0].id).toBe(fb);

    const del = await auth({
      method: "DELETE",
      url: `/api/activity-groups/${group.id}/activities/${fb}`,
    });
    expect(del.statusCode).toBe(204);
    // Removing a non-membership 404s.
    expect(
      (await auth({ method: "DELETE", url: `/api/activity-groups/${group.id}/activities/${fb}` }))
        .statusCode,
    ).toBe(404);
  });

  it("404s membership ops against a missing group or activity", async () => {
    const group = (
      await auth({ method: "POST", url: "/api/activity-groups", payload: { name: "G" } })
    ).json();
    const activity = await makeActivity();
    expect(
      (await auth({ method: "GET", url: `/api/activity-groups/999/activities` })).statusCode,
    ).toBe(404);
    expect(
      (await auth({ method: "PUT", url: `/api/activity-groups/999/activities/${activity}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await auth({ method: "PUT", url: `/api/activity-groups/${group.id}/activities/999` }))
        .statusCode,
    ).toBe(404);
  });

  // --- budgets -------------------------------------------------------------

  it("creates an overall budget and reads it back, filtered by user", async () => {
    const userId = await makeUser();
    const created = await auth({
      method: "POST",
      url: "/api/budgets",
      payload: { userId, scope: "overall", window: "daily", secondsAllowed: 7200 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ scope: "overall", targetId: null, secondsAllowed: 7200 });

    const filtered = await auth({ method: "GET", url: `/api/budgets?userId=${userId}` });
    expect(filtered.json()).toHaveLength(1);
    expect((await auth({ method: "GET", url: `/api/budgets?userId=999` })).json()).toEqual([]);

    const patched = await auth({
      method: "PATCH",
      url: `/api/budgets/${body.id}`,
      payload: { secondsAllowed: 3600 },
    });
    expect(patched.json().secondsAllowed).toBe(3600);

    expect((await auth({ method: "DELETE", url: `/api/budgets/${body.id}` })).statusCode).toBe(204);
  });

  it("creates an activity-scoped budget against an existing target", async () => {
    const userId = await makeUser();
    const activityId = await makeActivity("steam");
    const res = await auth({
      method: "POST",
      url: "/api/budgets",
      payload: {
        userId,
        scope: "activity",
        targetId: activityId,
        window: "weekly",
        secondsAllowed: 3600,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ scope: "activity", targetId: activityId });
  });

  it("enforces budget target coherence and referent existence (400)", async () => {
    const userId = await makeUser();
    const overallWithTarget = await auth({
      method: "POST",
      url: "/api/budgets",
      payload: { userId, scope: "overall", targetId: 1, window: "daily", secondsAllowed: 1 },
    });
    expect(overallWithTarget.statusCode).toBe(400);

    const activityNoTarget = await auth({
      method: "POST",
      url: "/api/budgets",
      payload: { userId, scope: "activity", window: "daily", secondsAllowed: 1 },
    });
    expect(activityNoTarget.statusCode).toBe(400);

    const danglingTarget = await auth({
      method: "POST",
      url: "/api/budgets",
      payload: { userId, scope: "activity", targetId: 999, window: "daily", secondsAllowed: 1 },
    });
    expect(danglingTarget.statusCode).toBe(400);
  });

  it("404s a budget for a missing user and 400s a negative allowance", async () => {
    const missingUser = await auth({
      method: "POST",
      url: "/api/budgets",
      payload: { userId: 999, scope: "overall", window: "daily", secondsAllowed: 1 },
    });
    expect(missingUser.statusCode).toBe(404);

    const userId = await makeUser();
    const negative = await auth({
      method: "POST",
      url: "/api/budgets",
      payload: { userId, scope: "overall", window: "daily", secondsAllowed: -1 },
    });
    expect(negative.statusCode).toBe(400);
  });

  it("re-checks budget coherence on PATCH against the merged row (400)", async () => {
    const userId = await makeUser();
    const activityId = await makeActivity("steam");
    const budget = (
      await auth({
        method: "POST",
        url: "/api/budgets",
        payload: {
          userId,
          scope: "activity",
          targetId: activityId,
          window: "daily",
          secondsAllowed: 60,
        },
      })
    ).json();
    const bad = await auth({
      method: "PATCH",
      url: `/api/budgets/${budget.id}`,
      payload: { scope: "overall" },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await auth({
      method: "PATCH",
      url: `/api/budgets/${budget.id}`,
      payload: { scope: "overall", targetId: null },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ scope: "overall", targetId: null });
  });

  it("404s budget GET/PATCH/DELETE for a missing id", async () => {
    expect((await auth({ method: "GET", url: "/api/budgets/999" })).statusCode).toBe(404);
    expect(
      (await auth({ method: "PATCH", url: "/api/budgets/999", payload: { secondsAllowed: 1 } }))
        .statusCode,
    ).toBe(404);
    expect((await auth({ method: "DELETE", url: "/api/budgets/999" })).statusCode).toBe(404);
  });

  // --- schedules -----------------------------------------------------------

  it("creates an always-on schedule and a recurring window", async () => {
    const userId = await makeUser();
    const alwaysOn = await auth({
      method: "POST",
      url: "/api/schedules",
      payload: { userId, targetKind: "overall", action: "deny" },
    });
    expect(alwaysOn.statusCode).toBe(201);
    expect(alwaysOn.json()).toMatchObject({
      targetKind: "overall",
      action: "deny",
      recurrenceDays: null,
      effectiveFrom: null,
      ordinal: 0,
    });

    const window = await auth({
      method: "POST",
      url: "/api/schedules",
      payload: {
        userId,
        targetKind: "overall",
        action: "allow",
        recurrenceDays: 31,
        recurrenceStartMinute: 540,
        recurrenceEndMinute: 1020,
        effectiveFrom: "2026-09-01T00:00:00.000Z",
      },
    });
    expect(window.statusCode).toBe(201);
    expect(window.json()).toMatchObject({
      recurrenceStartMinute: 540,
      recurrenceEndMinute: 1020,
      effectiveFrom: "2026-09-01T00:00:00.000Z",
    });

    expect(
      (await auth({ method: "GET", url: `/api/schedules?userId=${userId}` })).json(),
    ).toHaveLength(2);
  });

  it("rejects a half-open recurrence pair on create (400)", async () => {
    const userId = await makeUser();
    const res = await auth({
      method: "POST",
      url: "/api/schedules",
      payload: { userId, targetKind: "overall", action: "allow", recurrenceStartMinute: 540 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("enforces schedule coherence and a missing user", async () => {
    const userId = await makeUser();
    const incoherent = await auth({
      method: "POST",
      url: "/api/schedules",
      payload: { userId, targetKind: "activity", action: "allow" },
    });
    expect(incoherent.statusCode).toBe(400);

    const missingUser = await auth({
      method: "POST",
      url: "/api/schedules",
      payload: { userId: 999, targetKind: "overall", action: "allow" },
    });
    expect(missingUser.statusCode).toBe(404);
  });

  it("PATCHes a schedule and backstops a merged-row recurrence break (400)", async () => {
    const userId = await makeUser();
    const schedule = (
      await auth({
        method: "POST",
        url: "/api/schedules",
        payload: { userId, targetKind: "overall", action: "deny" },
      })
    ).json();

    const ok = await auth({
      method: "PATCH",
      url: `/api/schedules/${schedule.id}`,
      payload: { action: "allow", ordinal: 3 },
    });
    expect(ok.json()).toMatchObject({ action: "allow", ordinal: 3 });

    const halfOpen = await auth({
      method: "PATCH",
      url: `/api/schedules/${schedule.id}`,
      payload: { recurrenceStartMinute: 540 },
    });
    expect(halfOpen.statusCode).toBe(400);

    expect(
      (await auth({ method: "DELETE", url: `/api/schedules/${schedule.id}` })).statusCode,
    ).toBe(204);
    expect((await auth({ method: "GET", url: `/api/schedules/${schedule.id}` })).statusCode).toBe(
      404,
    );
  });

  // --- exceptions ----------------------------------------------------------

  it("creates an exception, reads it, and filters by user", async () => {
    const userId = await makeUser();
    const created = await auth({
      method: "POST",
      url: "/api/exceptions",
      payload: {
        userId,
        targetKind: "overall",
        action: "allow",
        reason: "Birthday",
        expiresAt: "2026-07-01T21:00:00.000Z",
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({
      reason: "Birthday",
      expiresAt: "2026-07-01T21:00:00.000Z",
      effectiveFrom: null,
    });
    expect(typeof body.createdAt).toBe("string");

    expect(
      (await auth({ method: "GET", url: `/api/exceptions?userId=${userId}` })).json(),
    ).toHaveLength(1);
    expect((await auth({ method: "GET", url: `/api/exceptions/${body.id}` })).statusCode).toBe(200);
  });

  it("rejects an exception whose window is empty (400) and a missing user (404)", async () => {
    const userId = await makeUser();
    const emptyWindow = await auth({
      method: "POST",
      url: "/api/exceptions",
      payload: {
        userId,
        targetKind: "overall",
        action: "allow",
        effectiveFrom: "2026-07-02T00:00:00.000Z",
        expiresAt: "2026-07-01T00:00:00.000Z",
      },
    });
    expect(emptyWindow.statusCode).toBe(400);

    const missingUser = await auth({
      method: "POST",
      url: "/api/exceptions",
      payload: {
        userId: 999,
        targetKind: "overall",
        action: "allow",
        expiresAt: "2026-07-01T00:00:00.000Z",
      },
    });
    expect(missingUser.statusCode).toBe(404);
  });

  it("PATCHes an exception and backstops a merged-row window break (400)", async () => {
    const userId = await makeUser();
    const exception = (
      await auth({
        method: "POST",
        url: "/api/exceptions",
        payload: {
          userId,
          targetKind: "overall",
          action: "allow",
          expiresAt: "2026-07-10T00:00:00.000Z",
        },
      })
    ).json();

    const ok = await auth({
      method: "PATCH",
      url: `/api/exceptions/${exception.id}`,
      payload: { reason: "Updated" },
    });
    expect(ok.json().reason).toBe("Updated");

    const bad = await auth({
      method: "PATCH",
      url: `/api/exceptions/${exception.id}`,
      payload: { effectiveFrom: "2026-07-20T00:00:00.000Z" },
    });
    expect(bad.statusCode).toBe(400);

    expect(
      (await auth({ method: "DELETE", url: `/api/exceptions/${exception.id}` })).statusCode,
    ).toBe(204);
    expect((await auth({ method: "GET", url: `/api/exceptions/${exception.id}` })).statusCode).toBe(
      404,
    );
  });
});

describe("policy CRUD routes — user groups (#124)", () => {
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

  async function makeUser(displayName = "Alice"): Promise<number> {
    return (await auth({ method: "POST", url: "/api/users", payload: { displayName } })).json().id;
  }

  async function makeGroup(name = "Kids"): Promise<number> {
    return (await auth({ method: "POST", url: "/api/user-groups", payload: { name } })).json().id;
  }

  it("rejects anonymous access with a 401", async () => {
    for (const url of ["/api/user-groups", "/api/user-groups/1/members"]) {
      const res = await harness.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    }
  });

  it("CRUDs a user group and rejects a duplicate name with 409", async () => {
    const created = await auth({
      method: "POST",
      url: "/api/user-groups",
      payload: { name: "Kids" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ name: "Kids" });
    expect(typeof body.createdAt).toBe("string");

    const dup = await auth({ method: "POST", url: "/api/user-groups", payload: { name: "Kids" } });
    expect(dup.statusCode).toBe(409);

    const patched = await auth({
      method: "PATCH",
      url: `/api/user-groups/${body.id}`,
      payload: { name: "Children" },
    });
    expect(patched.json().name).toBe("Children");

    expect((await auth({ method: "GET", url: "/api/user-groups" })).json()).toHaveLength(1);
    expect((await auth({ method: "GET", url: `/api/user-groups/${body.id}` })).json().name).toBe(
      "Children",
    );

    const del = await auth({ method: "DELETE", url: `/api/user-groups/${body.id}` });
    expect(del.statusCode).toBe(204);
    expect((await auth({ method: "GET", url: `/api/user-groups/${body.id}` })).statusCode).toBe(
      404,
    );
  });

  it("rejects an empty name (400) and an empty PATCH (400)", async () => {
    const bad = await auth({ method: "POST", url: "/api/user-groups", payload: { name: "  " } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("validation_error");

    const id = await makeGroup();
    const empty = await auth({ method: "PATCH", url: `/api/user-groups/${id}`, payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it("404s a PATCH/DELETE against a missing group", async () => {
    expect(
      (await auth({ method: "PATCH", url: "/api/user-groups/999", payload: { name: "x" } }))
        .statusCode,
    ).toBe(404);
    expect((await auth({ method: "DELETE", url: "/api/user-groups/999" })).statusCode).toBe(404);
  });

  it("manages multi-group membership from both directions, idempotently", async () => {
    const kids = await makeGroup("Kids");
    const teens = await makeGroup("Teens");
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");

    expect(
      (await auth({ method: "PUT", url: `/api/user-groups/${kids}/members/${alice}` })).statusCode,
    ).toBe(204);
    // Idempotent re-add.
    expect(
      (await auth({ method: "PUT", url: `/api/user-groups/${kids}/members/${alice}` })).statusCode,
    ).toBe(204);
    await auth({ method: "PUT", url: `/api/user-groups/${kids}/members/${bob}` });
    // A user belongs to ≥0 groups: Alice joins Teens too.
    await auth({ method: "PUT", url: `/api/user-groups/${teens}/members/${alice}` });

    const members = await auth({ method: "GET", url: `/api/user-groups/${kids}/members` });
    expect(members.json().map((u: { id: number }) => u.id)).toEqual([alice, bob]);

    const aliceGroups = await auth({ method: "GET", url: `/api/users/${alice}/groups` });
    expect(aliceGroups.json().map((g: { id: number }) => g.id)).toEqual([kids, teens]);

    const del = await auth({ method: "DELETE", url: `/api/user-groups/${kids}/members/${alice}` });
    expect(del.statusCode).toBe(204);
    // Removing a non-membership 404s.
    expect(
      (await auth({ method: "DELETE", url: `/api/user-groups/${kids}/members/${alice}` }))
        .statusCode,
    ).toBe(404);
    expect((await auth({ method: "GET", url: `/api/users/${alice}/groups` })).json()).toHaveLength(
      1,
    );
  });

  it("404s membership ops against a missing group or user", async () => {
    const group = await makeGroup();
    const user = await makeUser();
    expect((await auth({ method: "GET", url: "/api/user-groups/999/members" })).statusCode).toBe(
      404,
    );
    expect((await auth({ method: "GET", url: "/api/users/999/groups" })).statusCode).toBe(404);
    expect(
      (await auth({ method: "PUT", url: `/api/user-groups/999/members/${user}` })).statusCode,
    ).toBe(404);
    expect(
      (await auth({ method: "PUT", url: `/api/user-groups/${group}/members/999` })).statusCode,
    ).toBe(404);
  });
});

describe("policy CRUD routes — group schedules & exceptions (#182)", () => {
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

  async function makeGroup(name = "Kids"): Promise<number> {
    return (await auth({ method: "POST", url: "/api/user-groups", payload: { name } })).json().id;
  }

  async function makeActivity(matcher = "firefox"): Promise<number> {
    return (
      await auth({ method: "POST", url: "/api/activities", payload: { kind: "app", matcher } })
    ).json().id;
  }

  it("rejects anonymous access to the group collections with a 401", async () => {
    for (const url of ["/api/user-groups/1/schedules", "/api/user-groups/1/exceptions"]) {
      const res = await harness.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    }
  });

  it("creates, lists, reads, patches, and deletes a group schedule", async () => {
    const groupId = await makeGroup();
    const created = await auth({
      method: "POST",
      url: `/api/user-groups/${groupId}/schedules`,
      payload: {
        targetKind: "overall",
        action: "deny",
        recurrenceDays: 0b0011111,
        recurrenceStartMinute: 16 * 60,
        recurrenceEndMinute: 18 * 60,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({
      userGroupId: groupId,
      targetKind: "overall",
      action: "deny",
      recurrenceDays: 0b0011111,
      ordinal: 0,
    });

    const list = await auth({ method: "GET", url: `/api/user-groups/${groupId}/schedules` });
    expect(list.json().map((r: { id: number }) => r.id)).toEqual([body.id]);

    expect((await auth({ method: "GET", url: `/api/group-schedules/${body.id}` })).json().id).toBe(
      body.id,
    );

    const patched = await auth({
      method: "PATCH",
      url: `/api/group-schedules/${body.id}`,
      payload: { action: "allow" },
    });
    expect(patched.json().action).toBe("allow");

    expect(
      (await auth({ method: "DELETE", url: `/api/group-schedules/${body.id}` })).statusCode,
    ).toBe(204);
    expect((await auth({ method: "GET", url: `/api/group-schedules/${body.id}` })).statusCode).toBe(
      404,
    );
  });

  it("resolves an activity target and 400s a dangling one on a group schedule", async () => {
    const groupId = await makeGroup();
    const activityId = await makeActivity();
    const ok = await auth({
      method: "POST",
      url: `/api/user-groups/${groupId}/schedules`,
      payload: { targetKind: "activity", targetId: activityId, action: "deny" },
    });
    expect(ok.statusCode).toBe(201);

    const dangling = await auth({
      method: "POST",
      url: `/api/user-groups/${groupId}/schedules`,
      payload: { targetKind: "activity", targetId: 9999, action: "deny" },
    });
    expect(dangling.statusCode).toBe(400);
    expect(dangling.json().error.code).toBe("validation_error");
  });

  it("400s an invalid recurrence window and 404s a missing group on create", async () => {
    const groupId = await makeGroup();
    const bad = await auth({
      method: "POST",
      url: `/api/user-groups/${groupId}/schedules`,
      payload: { targetKind: "overall", action: "allow", recurrenceStartMinute: 600 }, // half a pair
    });
    expect(bad.statusCode).toBe(400);

    const missing = await auth({
      method: "POST",
      url: "/api/user-groups/9999/schedules",
      payload: { targetKind: "overall", action: "deny" },
    });
    expect(missing.statusCode).toBe(404);

    expect((await auth({ method: "GET", url: "/api/user-groups/9999/schedules" })).statusCode).toBe(
      404,
    );
  });

  it("creates, lists, patches, and deletes a group exception", async () => {
    const groupId = await makeGroup();
    const created = await auth({
      method: "POST",
      url: `/api/user-groups/${groupId}/exceptions`,
      payload: {
        targetKind: "overall",
        action: "allow",
        reason: "movie night",
        expiresAt: "2026-07-02T00:00:00.000Z",
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ userGroupId: groupId, action: "allow", reason: "movie night" });

    expect(
      (await auth({ method: "GET", url: `/api/user-groups/${groupId}/exceptions` })).json(),
    ).toHaveLength(1);

    const patched = await auth({
      method: "PATCH",
      url: `/api/group-exceptions/${body.id}`,
      payload: { reason: "trip" },
    });
    expect(patched.json().reason).toBe("trip");

    expect(
      (await auth({ method: "DELETE", url: `/api/group-exceptions/${body.id}` })).statusCode,
    ).toBe(204);
    expect(
      (await auth({ method: "GET", url: `/api/group-exceptions/${body.id}` })).statusCode,
    ).toBe(404);
  });

  it("400s a group exception whose effectiveFrom is not before expiry", async () => {
    const groupId = await makeGroup();
    const bad = await auth({
      method: "POST",
      url: `/api/user-groups/${groupId}/exceptions`,
      payload: {
        targetKind: "overall",
        action: "allow",
        effectiveFrom: "2026-07-02T00:00:00.000Z",
        expiresAt: "2026-07-01T00:00:00.000Z",
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("validation_error");
  });

  it("404s item reads/patches/deletes against missing group rules", async () => {
    for (const base of ["group-schedules", "group-exceptions"]) {
      expect((await auth({ method: "GET", url: `/api/${base}/9999` })).statusCode).toBe(404);
      expect(
        (await auth({ method: "PATCH", url: `/api/${base}/9999`, payload: { action: "deny" } }))
          .statusCode,
      ).toBe(404);
      expect((await auth({ method: "DELETE", url: `/api/${base}/9999` })).statusCode).toBe(404);
    }
  });

  it("re-validates the target on a group-schedule PATCH", async () => {
    const groupId = await makeGroup();
    const activityId = await makeActivity();
    const created = await auth({
      method: "POST",
      url: `/api/user-groups/${groupId}/schedules`,
      payload: { targetKind: "overall", action: "deny" },
    });
    const id = created.json().id;

    // Re-target to a real activity: ok.
    const ok = await auth({
      method: "PATCH",
      url: `/api/group-schedules/${id}`,
      payload: { targetKind: "activity", targetId: activityId },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ targetKind: "activity", targetId: activityId });

    // Re-target to a dangling activity: 400.
    const bad = await auth({
      method: "PATCH",
      url: `/api/group-schedules/${id}`,
      payload: { targetKind: "activity", targetId: 9999 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("pushes a group-rule change to every member's clients (stub)", async () => {
    const groupId = await makeGroup();
    // Two members; one has a client linked, the other does not.
    const alice = (
      await auth({ method: "POST", url: "/api/users", payload: { displayName: "Alice" } })
    ).json().id;
    const bob = (
      await auth({ method: "POST", url: "/api/users", payload: { displayName: "Bob" } })
    ).json().id;
    await auth({ method: "PUT", url: `/api/user-groups/${groupId}/members/${alice}` });
    await auth({ method: "PUT", url: `/api/user-groups/${groupId}/members/${bob}` });
    const client = (
      await auth({
        method: "POST",
        url: "/api/clients",
        payload: { hostname: "mint-1", sshUser: "pct-agent" },
      })
    ).json().id;
    await auth({
      method: "PUT",
      url: `/api/users/${alice}/clients/${client}`,
      payload: { linuxUsername: "alice", linuxUid: 1000 },
    });

    // The mutation must succeed (the stub logs the fan-out); no client → no-op
    // for Bob, one command for Alice. Asserting the request path is reachable
    // and returns 201 covers the fan-out wiring without coupling to log output.
    const created = await auth({
      method: "POST",
      url: `/api/user-groups/${groupId}/schedules`,
      payload: { targetKind: "overall", action: "deny" },
    });
    expect(created.statusCode).toBe(201);
  });
});
