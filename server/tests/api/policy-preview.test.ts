/**
 * HTTP tests for the save-and-push preview route (#64):
 * `POST /api/users/:userId/policy-preview`, driven through the real app via
 * `app.inject()` with a genuine admin session cookie. Covers the anonymous-401
 * guard, 404 for an unknown user, body validation (400), the happy-path diff
 * (current persisted policy vs a proposed edit), a no-op (no changes), the
 * own-rules-not-group-rules fidelity guard, and the affected-client annotation
 * (hostname, lastSeen, pending-queue depth).
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import type { ClientRow } from "../../src/policy/repository.js";
import type { ClientProbeResult, ClientReachability } from "../../src/transport/health/index.js";
import type { PolicyPushTransport } from "../../src/transport/policy-push/index.js";
import {
  budgets,
  clients,
  groupBudgets,
  groupSchedules,
  userGroupMemberships,
  userGroups,
  usersOnClients,
} from "../../src/policy/schema.js";
import { enqueue } from "../../src/transport/queue/index.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "preview-test-secret",
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

/** A proposed schedule rule in the `scheduleResponseSchema` wire shape. */
function proposedSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: 1,
    targetKind: "overall",
    targetId: null,
    action: "allow",
    recurrenceDays: null,
    recurrenceStartMinute: null,
    recurrenceEndMinute: null,
    effectiveFrom: null,
    effectiveTo: null,
    ordinal: 0,
    ...overrides,
  };
}

/** A proposed budget in the `budgetResponseSchema` wire shape. */
function proposedBudget(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: 1,
    scope: "overall",
    targetId: null,
    window: "daily",
    secondsAllowed: 7200,
    ...overrides,
  };
}

describe("POST /api/users/:userId/policy-preview", () => {
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

  /** Insert a client + link it to the user, returning the client id. */
  function linkClient(userId: number, hostname: string, lastSeen?: Date): number {
    const client = harness.db
      .insert(clients)
      .values(
        lastSeen === undefined
          ? { hostname, sshUser: "pct-agent" }
          : { hostname, sshUser: "pct-agent", lastSeen },
      )
      .returning({ id: clients.id })
      .get();
    if (client === undefined) throw new Error("client insert returned no row");
    harness.db
      .insert(usersOnClients)
      .values({ userId, clientId: client.id, osUsername: "alice", osUserRef: `1000-${client.id}` })
      .run();
    return client.id;
  }

  it("rejects anonymous access with a 401 envelope", async () => {
    const userId = await createUser("Alice");
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("returns 404 for an unknown user", async () => {
    const res = await auth({
      method: "POST",
      url: "/api/users/9999/policy-preview",
      payload: { budgets: [], schedules: [] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("rejects a malformed body with a 400", async () => {
    const userId = await createUser("Alice");
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [{ scope: "overall", window: "daily" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("reports no changes when the proposed policy matches the current one", async () => {
    const userId = await createUser("Alice"); // tz null → UTC
    harness.db
      .insert(budgets)
      .values({ userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 })
      .run();

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: {
        budgets: [proposedBudget({ userId, secondsAllowed: 7200 })],
        schedules: [],
        now: "2026-06-17T12:00:00Z",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasChanges).toBe(false);
    expect(res.json().changes).toEqual([]);
  });

  it("diffs the proposed daily overall limit against the current one", async () => {
    const userId = await createUser("Alice");
    harness.db
      .insert(budgets)
      .values({ userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 })
      .run();

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: {
        budgets: [proposedBudget({ userId, secondsAllowed: 9000 })], // 2h → 2h30
        schedules: [],
        now: "2026-06-17T12:00:00Z",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasChanges).toBe(true);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({
      field: "daily-overall",
      kind: "changed",
      weekday: null,
      before: "2h",
      after: "2h 30m",
    });
  });

  it("emits per-weekday diff rows for a proposed weekday-varying overall budget (#141)", async () => {
    const userId = await createUser("Alice");
    // Current baseline: a uniform 2h/day overall budget.
    harness.db
      .insert(budgets)
      .values({ userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 })
      .run();

    // Proposed: weekend-only 4h (Sat + Sun mask). The proposed mask must reach
    // the diff — a weekday-varying proposal previewed as uniform would lie about
    // what the push will enforce (the display-vs-enforce trap #362 closed). So
    // weekdays lose their daily limit (→ whole-day 24h) and weekends become 4h.
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: {
        budgets: [
          proposedBudget({ userId, secondsAllowed: 14400, recurrenceDays: (1 << 5) | (1 << 6) }),
        ],
        schedules: [],
        now: "2026-06-17T12:00:00Z",
      },
    });
    expect(res.statusCode).toBe(200);
    const daily = res.json().changes.filter((c: { field: string }) => c.field === "daily-overall");
    // One row per weekday — all seven differ from the uniform 2h baseline.
    expect(daily).toHaveLength(7);
    const bySaturday = daily.find((c: { weekday: number }) => c.weekday === 6);
    const byMonday = daily.find((c: { weekday: number }) => c.weekday === 1);
    expect(bySaturday).toMatchObject({ after: "4h" });
    expect(byMonday).toMatchObject({ after: "24h" });
  });

  it("includes inherited group schedule windows on both sides of the diff (#362)", async () => {
    const userId = await createUser("Alice"); // tz null → UTC
    // A group "bedtime" the child inherits: deny 22:00–24:00 every day. Since the
    // push now sends inherited group rules (#362), the preview's *current* side
    // must reflect it — allowed windows are 00:00–22:00, not the full day.
    const group = harness.db
      .insert(userGroups)
      .values({ name: "Kids" })
      .returning({ id: userGroups.id })
      .get();
    if (group === undefined) throw new Error("group insert returned no row");
    harness.db.insert(userGroupMemberships).values({ userId, groupId: group.id }).run();
    harness.db
      .insert(groupSchedules)
      .values({
        userGroupId: group.id,
        targetKind: "overall",
        targetId: null,
        action: "deny",
        recurrenceStartMinute: 1320, // 22:00
        recurrenceEndMinute: 1440, // 24:00
      })
      .run();

    // Proposed: the child's own earlier bedtime deny 20:00–24:00 (1200..1440),
    // which composes above the inherited group window (own rules win first).
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: {
        budgets: [],
        schedules: [
          proposedSchedule({
            userId,
            action: "deny",
            recurrenceStartMinute: 1200,
            recurrenceEndMinute: 1440,
          }),
        ],
        now: "2026-06-17T12:00:00Z",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const allowedHoursRows = body.changes.filter(
      (c: { field: string }) => c.field === "allowed-hours",
    );
    expect(allowedHoursRows.length).toBeGreaterThan(0);
    // before reflects the inherited group window (00:00–22:00); after tightens it
    // to 00:00–20:00 via the proposed own rule — proving the group layer is held
    // constant on both sides and only the own-rule change is diffed.
    expect(allowedHoursRows[0]).toMatchObject({
      field: "allowed-hours",
      before: "00:00–22:00",
      after: "00:00–20:00",
    });
  });

  it("uses an inherited group budget as the diff baseline a proposed own budget overrides (#362)", async () => {
    const userId = await createUser("Alice"); // tz null → UTC
    const group = harness.db
      .insert(userGroups)
      .values({ name: "Kids" })
      .returning({ id: userGroups.id })
      .get();
    if (group === undefined) throw new Error("group insert returned no row");
    harness.db.insert(userGroupMemberships).values({ userId, groupId: group.id }).run();
    // The child has no own overall/daily budget — only the inherited group's 2h.
    harness.db
      .insert(groupBudgets)
      .values({
        userGroupId: group.id,
        scope: "overall",
        targetId: null,
        window: "daily",
        secondsAllowed: 7200,
      })
      .run();

    // Proposed: the child's own 1h overall/daily budget fully replaces the slot.
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: {
        budgets: [proposedBudget({ userId, secondsAllowed: 3600 })],
        schedules: [],
        now: "2026-06-17T12:00:00Z",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasChanges).toBe(true);
    // before = inherited group 2h (not "none"), after = own 1h override.
    expect(body.changes).toContainEqual(
      expect.objectContaining({
        field: "daily-overall",
        kind: "changed",
        before: "2h",
        after: "1h",
      }),
    );
  });

  it("lists affected clients with hostname, lastSeen, and pending-queue depth", async () => {
    const userId = await createUser("Alice");
    const clientId = linkClient(userId, "mint-laptop");
    // Two pending queued actions for the client → depth 2.
    enqueue(harness.db, {
      clientId,
      coalesceKey: `policy.push:${userId}`,
      kind: "policy.push",
      payload: { userId, reason: "budget.updated", detail: {} },
    });
    enqueue(harness.db, {
      clientId,
      coalesceKey: `policy.push:${userId}:other`,
      kind: "policy.push",
      payload: { userId, reason: "schedule.updated", detail: {} },
    });

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [], now: "2026-06-17T12:00:00Z" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().affectedClients).toEqual([
      {
        clientId,
        hostname: "mint-laptop",
        lastSeen: null,
        pendingQueueDepth: 2,
        // No probe requested (and none wired) → reachability un-annotated.
        reachability: null,
        probedAt: null,
      },
    ]);
  });

  it("returns an empty affected-clients list for a user with no linked clients", async () => {
    const userId = await createUser("Alice");
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().affectedClients).toEqual([]);
  });

  it("serializes a non-null lastSeen and orders multiple clients by id", async () => {
    const userId = await createUser("Alice");
    const seen = new Date("2026-06-16T08:30:00Z");
    // Link in reverse hostname order to prove the sort is by clientId, not insert order.
    const firstId = linkClient(userId, "desk-pc", seen);
    const secondId = linkClient(userId, "mint-laptop");

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [], now: "2026-06-17T12:00:00Z" },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().affectedClients.map((c: { clientId: number }) => c.clientId);
    expect(ids).toEqual([firstId, secondId].sort((a, b) => a - b));
    const first = res
      .json()
      .affectedClients.find((c: { clientId: number }) => c.clientId === firstId);
    expect(first.lastSeen).toBe(seen.toISOString());
  });

  it("defaults the reference instant to now when `now` is omitted", async () => {
    const userId = await createUser("Alice");
    harness.db
      .insert(budgets)
      .values({ userId, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 })
      .run();

    // No `now` in the body → handler uses new Date(); a 2h→2h30 daily change
    // is date-independent, so the diff is deterministic regardless of clock.
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [proposedBudget({ userId, secondsAllowed: 9000 })], schedules: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changes).toEqual([
      {
        field: "daily-overall",
        kind: "changed",
        weekday: null,
        before: "2h",
        after: "2h 30m",
        summary: "Daily overall limit: 2h → 2h 30m",
      },
    ]);
  });

  it("leaves reachability un-annotated on the default (no-probe) path", async () => {
    const userId = await createUser("Alice");
    linkClient(userId, "mint-laptop");
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [], now: "2026-06-17T12:00:00Z" },
    });
    expect(res.statusCode).toBe(200);
    const [client] = res.json().affectedClients;
    expect(client).toMatchObject({ reachability: null, probedAt: null });
  });

  it("still returns null reachability when `probe:true` but no prober is wired", async () => {
    // The default test app has no live prober (pre-#39); an opt-in probe must
    // degrade to null, never a stand-in verdict.
    const userId = await createUser("Alice");
    linkClient(userId, "mint-laptop");
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [], probe: true, now: "2026-06-17T12:00:00Z" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().affectedClients[0]).toMatchObject({ reachability: null, probedAt: null });
  });

  // --- future-dated preview (`date`, #281) ---

  // A proposed deny 08:00–12:00 daily, scoped to the single ISO week
  // Mon 2027-03-15 … Sun 2027-03-21 (effectiveTo is the exclusive next Monday).
  // Dormant every other week, so the diff it produces depends on the reference
  // date — exactly what the future-dated preview surfaces.
  function dateScopedDenyRule(overrides: Record<string, unknown> = {}) {
    return proposedSchedule({
      action: "deny",
      recurrenceStartMinute: 480, // 08:00
      recurrenceEndMinute: 720, // 12:00
      effectiveFrom: "2027-03-15T00:00:00.000Z",
      effectiveTo: "2027-03-22T00:00:00.000Z",
      ...overrides,
    });
  }

  it("previews a date-scoped rule as a no-op today but active on a date in its window", async () => {
    const userId = await createUser("Alice"); // tz null → UTC

    // Today (well before the window): the proposed rule's date gate is closed,
    // so the resolved push is unchanged from the ruleless baseline — no diff.
    const today = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [dateScopedDenyRule()], now: "2026-06-17T12:00:00Z" },
    });
    expect(today.statusCode).toBe(200);
    expect(today.json().hasChanges).toBe(false);

    // A date inside the window: the rule is live all seven days of that week, so
    // every day's allowed hours tighten from all-day to 00:00–08:00, 12:00–24:00.
    const inWindow = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [dateScopedDenyRule()], date: "2027-03-17" },
    });
    expect(inWindow.statusCode).toBe(200);
    const body = inWindow.json();
    expect(body.hasChanges).toBe(true);
    const allowedHours = body.changes.filter((c: { field: string }) => c.field === "allowed-hours");
    expect(allowedHours).toHaveLength(7);
    expect(allowedHours[0]).toMatchObject({
      field: "allowed-hours",
      kind: "changed",
      before: "00:00–24:00",
      after: "00:00–08:00, 12:00–24:00",
    });
  });

  it("respects the exclusive effective_to: a date in the next week is a no-op again", async () => {
    const userId = await createUser("Alice"); // tz null → UTC
    // 2027-03-22 is the next Monday — the first day the window (exclusive end)
    // no longer covers — so its whole week is outside the rule and the diff empties.
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [dateScopedDenyRule()], date: "2027-03-22" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasChanges).toBe(false);
  });

  it("interprets `date` in the user's timezone (local noon selects the local week)", async () => {
    // Honolulu is UTC-10 with no DST. The rule is scoped to local-midnight
    // boundaries of the same week (10:00Z each day). Previewing date=2027-03-15
    // resolves to local noon = 2027-03-15T22:00Z, which lands inside the window
    // and in the local week Mon 03-15 … Sun 03-21. A naive UTC-midnight reading
    // (2027-03-15T00:00Z = Sun 03-14 14:00 local) would fall in the *previous*
    // local week, before the window, and miss the rule — so a diff here proves
    // the reference is built from the user's timezone, at local noon.
    const userId = await createUser("Kai", "Pacific/Honolulu");
    const rule = dateScopedDenyRule({
      effectiveFrom: "2027-03-15T10:00:00.000Z", // local midnight 03-15
      effectiveTo: "2027-03-22T10:00:00.000Z", // local midnight 03-22 (exclusive)
    });
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [rule], date: "2027-03-15" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasChanges).toBe(true);
    expect(body.changes.some((c: { field: string }) => c.field === "allowed-hours")).toBe(true);
  });

  it("lets `date` take precedence over `now`", async () => {
    const userId = await createUser("Alice"); // tz null → UTC
    // `now` is today (rule dormant); `date` is inside the window (rule live).
    // If `date` wins, the diff reflects the live rule.
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: {
        budgets: [],
        schedules: [dateScopedDenyRule()],
        now: "2026-06-17T12:00:00Z",
        date: "2027-03-17",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasChanges).toBe(true);
    expect(res.json().changes.some((c: { field: string }) => c.field === "allowed-hours")).toBe(
      true,
    );
  });

  it("rejects a malformed `date` (not a real calendar date) with a 400", async () => {
    const userId = await createUser("Alice");
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [], date: "2027-13-40" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects a date-time value in `date` (calendar date only) with a 400", async () => {
    const userId = await createUser("Alice");
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [], date: "2027-03-17T00:00:00Z" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});

/**
 * The opt-in live-reachability probe (#281): with a live prober injected, a
 * `probe: true` request annotates each affected client with online/offline and
 * bumps `last_seen` on a client that answers.
 */
describe("POST /api/users/:userId/policy-preview — live reachability probe", () => {
  let harness: TestApp;
  let cookie: string;
  const probeAt = new Date("2026-06-17T12:00:05Z");
  /** hostname → reachability the fake prober reports. */
  let verdicts: Map<string, ClientReachability>;
  let probedHosts: string[];

  /** A fake PolicyPushTransport whose prober reports per-host canned verdicts. */
  function fakeTransport(): PolicyPushTransport {
    return {
      dispatcher: { push: () => undefined },
      prober: {
        probe: (client: Pick<ClientRow, "hostname" | "sshUser">): Promise<ClientProbeResult> => {
          probedHosts.push(client.hostname);
          const reachability = verdicts.get(client.hostname) ?? "offline";
          return Promise.resolve({
            reachability,
            at: probeAt,
            components: [],
            reachabilityReason: null,
          });
        },
      },
      dispose: () => undefined,
    };
  }

  beforeEach(async () => {
    verdicts = new Map();
    probedHosts = [];
    harness = buildTestApp({
      appOptions: { settings: configuredSettings(), policyPush: fakeTransport() },
    });
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

  function linkClient(userId: number, hostname: string): number {
    const client = harness.db
      .insert(clients)
      .values({ hostname, sshUser: "pct-agent" })
      .returning({ id: clients.id })
      .get();
    if (client === undefined) throw new Error("client insert returned no row");
    harness.db
      .insert(usersOnClients)
      .values({ userId, clientId: client.id, osUsername: "alice", osUserRef: `1000-${client.id}` })
      .run();
    return client.id;
  }

  it("annotates online (bumping last_seen) and offline when probe is requested", async () => {
    const userId = await createUser("Alice");
    const onlineId = linkClient(userId, "mint-online");
    const offlineId = linkClient(userId, "mint-offline");
    verdicts.set("mint-online", "online");
    verdicts.set("mint-offline", "offline");

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [], probe: true, now: "2026-06-17T12:00:00Z" },
    });
    expect(res.statusCode).toBe(200);
    expect(probedHosts.sort()).toEqual(["mint-offline", "mint-online"]);

    const byId = new Map(
      res.json().affectedClients.map((c: { clientId: number }) => [c.clientId, c]),
    );
    expect(byId.get(onlineId)).toMatchObject({
      reachability: "online",
      probedAt: probeAt.toISOString(),
      lastSeen: probeAt.toISOString(), // bumped by the successful probe
    });
    expect(byId.get(offlineId)).toMatchObject({
      reachability: "offline",
      probedAt: probeAt.toISOString(),
      lastSeen: null, // an offline probe never bumps last_seen
    });
  });

  it("does not probe when `probe` is omitted, even with a prober wired", async () => {
    const userId = await createUser("Alice");
    linkClient(userId, "mint-online");
    verdicts.set("mint-online", "online");

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-preview`,
      payload: { budgets: [], schedules: [], now: "2026-06-17T12:00:00Z" },
    });
    expect(res.statusCode).toBe(200);
    expect(probedHosts).toEqual([]);
    expect(res.json().affectedClients[0]).toMatchObject({ reachability: null, probedAt: null });
  });
});
