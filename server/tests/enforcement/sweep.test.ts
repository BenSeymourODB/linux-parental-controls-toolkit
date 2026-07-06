/**
 * Tests for the enforcement sweep (#292): the long-lived driver that, per pass,
 * evaluates each supervised user, threads the per-user cool-down state across
 * passes, and feeds the decisions into one force-close trigger.
 *
 * The decision evaluation is an injected seam, so most scenarios drive it with a
 * spy (cross-pass state threading, per-user isolation, state pruning) without
 * seeding a full policy DB; one end-to-end test uses the real
 * `evaluateUserEnforcement` + the real `loadSupervisedUsers` loader against a
 * seeded `testDb()`. The trigger is a spy for orchestration assertions and the
 * real `ForceCloseTrigger` (with faked deps, no live SSH/WebSocket) for the
 * across-pass de-dup check.
 */
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnforcementDecision, EnforcementOutcome } from "../../src/enforcement/decision.js";
import { ForceCloseTrigger, type ForceCloseDeps } from "../../src/enforcement/force-close.js";
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_SWEEP_PATTERN,
  SWEEP_LOG_COMPONENT,
  loadSupervisedUsers,
  startEnforcementSweep,
  type EnforcementSweepHandle,
  type EnforcementSweepOptions,
  type EnforcementTrigger,
  type EvaluateEnforcement,
  type SupervisedUser,
} from "../../src/enforcement/sweep.js";
import { isValidCronPattern } from "../../src/transport/activitywatch/telemetry.js";
import { loadSettings } from "../../src/config.js";
import { activities, budgets, clients, users, usersOnClients } from "../../src/policy/schema.js";
import { insertUsageSamples } from "../../src/policy/usage.js";
import { buildApp } from "../../src/web/app.js";
import { testDb, type TestDb } from "../helpers/db.js";

const NOW = new Date("2024-02-15T12:00:00.000Z");

function decision(over: Partial<EnforcementDecision> = {}): EnforcementDecision {
  return {
    scope: "activity",
    targetId: 7,
    allowedSeconds: 1800,
    consumedSeconds: 3600,
    overageSeconds: 1800,
    graceSeconds: 60,
    ...over,
  };
}

function outcome(
  decisions: readonly EnforcementDecision[],
  lastFiredAt: ReadonlyMap<string, Date> = new Map(),
): EnforcementOutcome {
  return { decisions, lastFiredAt };
}

describe("enforcement sweep", () => {
  let db: TestDb;
  let lines: Record<string, unknown>[];
  let app: ReturnType<typeof buildApp>;
  let log: FastifyBaseLogger;
  let handles: EnforcementSweepHandle[];

  beforeEach(() => {
    db = testDb();
    lines = [];
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "debug", PCT_SECRET_KEY: "test-secret-key" }),
      loggerStream: {
        write: (msg) => {
          lines.push(JSON.parse(msg) as Record<string, unknown>);
        },
      },
      db,
    });
    log = app.log;
    handles = [];
  });

  afterEach(async () => {
    for (const handle of handles) handle.stop();
    await app.close();
    db.$client.close();
  });

  /** Start a sweep with sensible defaults; track the handle for teardown. */
  function start(overrides: Partial<EnforcementSweepOptions> = {}): EnforcementSweepHandle {
    const handle = startEnforcementSweep({
      db,
      loadSupervisedUsers: () => [],
      trigger: { enforce: vi.fn() },
      log,
      defaultTz: "UTC",
      now: () => NOW,
      ...overrides,
    });
    handles.push(handle);
    return handle;
  }

  describe("loadSupervisedUsers", () => {
    it("returns the distinct users that hold a client link, carrying tz", () => {
      const alice = db
        .insert(users)
        .values({ displayName: "Alice", tz: "America/New_York" })
        .returning()
        .get();
      const bob = db.insert(users).values({ displayName: "Bob" }).returning().get();
      // Carol has no client link and must not appear.
      db.insert(users).values({ displayName: "Carol" }).run();

      const pc1 = db
        .insert(clients)
        .values({ hostname: "pc-1", sshUser: "pct-agent" })
        .returning()
        .get();
      const pc2 = db
        .insert(clients)
        .values({ hostname: "pc-2", sshUser: "pct-agent" })
        .returning()
        .get();

      // Alice is on two clients — she must still appear exactly once.
      db.insert(usersOnClients)
        .values({ userId: alice.id, clientId: pc1.id, osUsername: "alice", osUserRef: "1001" })
        .run();
      db.insert(usersOnClients)
        .values({ userId: alice.id, clientId: pc2.id, osUsername: "alice", osUserRef: "1001" })
        .run();
      db.insert(usersOnClients)
        .values({ userId: bob.id, clientId: pc1.id, osUsername: "bob", osUserRef: "1002" })
        .run();

      const supervised = loadSupervisedUsers(db);

      expect(supervised).toHaveLength(2);
      expect(supervised).toContainEqual({ id: alice.id, tz: "America/New_York" });
      expect(supervised).toContainEqual({ id: bob.id, tz: null });
    });
  });

  describe("tick", () => {
    it("evaluates each supervised user and feeds decisions to the trigger", () => {
      const enforce = vi.fn();
      const supervised: SupervisedUser[] = [
        { id: 1, tz: null },
        { id: 2, tz: "America/New_York" },
      ];
      const evaluate = vi.fn<EvaluateEnforcement>((_db, input) =>
        input.userId === 1 ? outcome([decision()]) : outcome([]),
      );

      const result = start({
        loadSupervisedUsers: () => supervised,
        trigger: { enforce },
        evaluate,
      }).tick();

      expect(result).toEqual({ evaluated: 2, enforced: 1, decisions: 1, failed: 0 });
      expect(enforce).toHaveBeenCalledTimes(1);
      expect(enforce).toHaveBeenCalledWith(1, [decision()]);
      // tz resolution: User.tz wins, else the server default.
      expect(evaluate.mock.calls[0]?.[1].tz).toBe("UTC");
      expect(evaluate.mock.calls[1]?.[1].tz).toBe("America/New_York");
      // Default cool-down is threaded through.
      expect(evaluate.mock.calls[0]?.[1].cooldownSeconds).toBe(DEFAULT_COOLDOWN_SECONDS);
    });

    it("threads each user's returned cool-down state into the next pass", () => {
      const fired = new Map([["activity:7", NOW]]);
      const seen: ReadonlyMap<string, Date>[] = [];
      let call = 0;
      const evaluate = vi.fn<EvaluateEnforcement>((_db, _input, lastFiredAt) => {
        seen.push(lastFiredAt);
        // First pass fires (and reports the cool-down stamp); second is suppressed.
        return call++ === 0 ? outcome([decision()], fired) : outcome([], fired);
      });
      const enforce = vi.fn();

      const handle = start({
        loadSupervisedUsers: () => [{ id: 1, tz: null }],
        trigger: { enforce },
        evaluate,
      });
      handle.tick();
      handle.tick();

      // Pass 1 starts empty; pass 2 receives pass 1's returned cool-down map.
      expect(seen[0]?.size).toBe(0);
      expect(seen[1]?.get("activity:7")).toEqual(NOW);
      expect(enforce).toHaveBeenCalledTimes(1);
    });

    it("isolates a user whose evaluation throws and still evaluates the rest", () => {
      const enforce = vi.fn();
      const evaluate = vi.fn<EvaluateEnforcement>((_db, input) => {
        if (input.userId === 1) throw new Error("boom");
        return outcome([decision()]);
      });

      const result = start({
        loadSupervisedUsers: () => [
          { id: 1, tz: null },
          { id: 2, tz: null },
        ],
        trigger: { enforce },
        evaluate,
      }).tick();

      expect(result).toEqual({ evaluated: 1, enforced: 1, decisions: 1, failed: 1 });
      expect(enforce).toHaveBeenCalledWith(2, [decision()]);
      expect(
        lines.some((l) => l.component === SWEEP_LOG_COMPONENT && l.userId === 1 && l.level === 50),
      ).toBe(true);
    });

    it("prunes cool-down state for a user who is no longer supervised", () => {
      const fired = new Map([["activity:7", NOW]]);
      const seen: { userId: number; size: number }[] = [];
      const evaluate = vi.fn<EvaluateEnforcement>((_db, input, lastFiredAt) => {
        seen.push({ userId: input.userId, size: lastFiredAt.size });
        return outcome([], fired);
      });
      let roster: SupervisedUser[] = [
        { id: 1, tz: null },
        { id: 2, tz: null },
      ];
      const handle = start({
        loadSupervisedUsers: () => roster,
        evaluate,
      });

      handle.tick(); // pass 1: both seen with empty state
      roster = [{ id: 2, tz: null }]; // user 1 departs
      handle.tick(); // pass 2: only user 2
      roster = [
        { id: 1, tz: null },
        { id: 2, tz: null },
      ];
      handle.tick(); // pass 3: user 1 back

      const pass3 = seen.slice(-2);
      // User 1's state was pruned while away → empty again; user 2 retained.
      expect(pass3.find((s) => s.userId === 1)?.size).toBe(0);
      expect(pass3.find((s) => s.userId === 2)?.size).toBe(1);
    });

    it("de-dups across passes against one long-lived trigger (one schedule per pending target)", () => {
      const schedule = vi.fn(); // never fires → the target stays pending
      const deps: ForceCloseDeps = {
        publishToClient: vi.fn(() => 1),
        clientsForUser: () => [],
        resolveActivities: () => [],
        forceCloseOverSsh: vi.fn(async () => undefined),
        recordEventAudit: vi.fn(),
        schedule,
        logger: { warn: vi.fn(), error: vi.fn() },
      };
      const trigger: EnforcementTrigger = new ForceCloseTrigger(deps);
      const evaluate = vi.fn<EvaluateEnforcement>(() => outcome([decision()]));

      const handle = start({
        loadSupervisedUsers: () => [{ id: 1, tz: null }],
        trigger,
        evaluate,
      });
      handle.tick();
      handle.tick();

      // Same (user, target) decided twice, but one grace timer is in flight.
      expect(schedule).toHaveBeenCalledTimes(1);
    });

    it("drives the real evaluator + loader: an exhausted daily budget reaches the trigger", () => {
      const userId = db.insert(users).values({ displayName: "Alice" }).returning().get().id;
      const clientId = db
        .insert(clients)
        .values({ hostname: "alice-pc", sshUser: "pct-agent" })
        .returning()
        .get().id;
      db.insert(usersOnClients)
        .values({ userId, clientId, osUsername: "alice", osUserRef: "1001" })
        .run();
      const firefoxId = db
        .insert(activities)
        .values({ kind: "app", matcher: "firefox" })
        .returning()
        .get().id;
      db.insert(budgets)
        .values({
          userId,
          scope: "activity",
          targetId: firefoxId,
          window: "daily",
          secondsAllowed: 1800,
        })
        .run();
      insertUsageSamples(db, [
        {
          userId,
          clientId,
          activityId: firefoxId,
          startedAt: new Date("2024-02-15T10:00:00.000Z"),
          endedAt: new Date("2024-02-15T11:00:00.000Z"), // 3600s > 1800s
        },
      ]);

      const enforce = vi.fn();
      start({
        loadSupervisedUsers: () => loadSupervisedUsers(db),
        trigger: { enforce },
      }).tick();

      expect(enforce).toHaveBeenCalledTimes(1);
      expect(enforce).toHaveBeenCalledWith(userId, [
        {
          scope: "activity",
          targetId: firefoxId,
          allowedSeconds: 1800,
          consumedSeconds: 3600,
          overageSeconds: 1800,
          graceSeconds: 15, // documented default (no notification_policies row)
        },
      ]);
    });

    it("turns a failing supervised-user loader into a logged no-op", () => {
      let fail = false;
      const handle = start({
        loadSupervisedUsers: () => {
          if (fail) throw new Error("db gone");
          return [{ id: 1, tz: null }];
        },
        evaluate: vi.fn<EvaluateEnforcement>(() => outcome([])),
      });

      expect(handle.tick()).toEqual({ evaluated: 1, enforced: 0, decisions: 0, failed: 0 });
      fail = true;
      // A throwing loader is caught at the pass level — never escapes the cron.
      expect(handle.tick()).toEqual({ evaluated: 0, enforced: 0, decisions: 0, failed: 0 });
      expect(
        lines.some(
          (l) => l.component === SWEEP_LOG_COMPONENT && l.msg === "enforcement sweep pass failed",
        ),
      ).toBe(true);
    });
  });

  describe("lifecycle", () => {
    it("exposes a stoppable handle and a valid default pattern", () => {
      expect(isValidCronPattern(DEFAULT_SWEEP_PATTERN)).toBe(true);
      const handle = start();
      expect(() => handle.stop()).not.toThrow();
      // A pass with no supervised users is a clean no-op.
      expect(handle.tick()).toEqual({ evaluated: 0, enforced: 0, decisions: 0, failed: 0 });
    });

    it("accepts an explicit cron pattern and timezone", () => {
      const handle = start({ pattern: "0 * * * *", timezone: "America/New_York" });
      expect(() => handle.stop()).not.toThrow();
    });

    it("runs caller-driven with no internal cron when pattern is null (#327)", () => {
      const load = vi.fn((): SupervisedUser[] => []);
      // `null` is not a valid cron pattern — if it reached croner, construction
      // would throw. Constructing without throwing proves the null branch built
      // no schedule, so nothing runs until the caller drives `tick()`.
      const handle = start({ pattern: null, loadSupervisedUsers: load });
      expect(load).not.toHaveBeenCalled();
      // `stop()` is a no-op (no schedule to cancel) and safe to call.
      expect(() => handle.stop()).not.toThrow();
      // `tick()` still performs a pass — this is the seam the boot wiring calls
      // right after each telemetry rollup.
      expect(handle.tick()).toEqual({ evaluated: 0, enforced: 0, decisions: 0, failed: 0 });
      expect(load).toHaveBeenCalledTimes(1);
    });
  });
});
