/**
 * Unit tests for the date-specific override enforcement push scheduler (#399).
 *
 * Drives the real reconcile logic over an in-memory policy store with an
 * injected clock and a recording executor: an active override is pushed, an
 * unchanged one is not re-pushed, a lapsed one reverts exactly once, a restart
 * reconciles a stale override, the fan-out reaches every linked client, group
 * overrides are included, and an offline push is queued for the drainer.
 */
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings } from "../../../src/config.js";
import {
  addUserToGroup,
  createClient,
  createException,
  createGroupException,
  createUser,
  createUserGroup,
  upsertLink,
} from "../../../src/policy/repository.js";
import { buildApp } from "../../../src/web/app.js";
import {
  DEFAULT_EXCEPTION_PUSH_PATTERN,
  EXCEPTION_PUSH_KIND,
  EXCEPTION_PUSH_REASON,
  startDateOverridePush,
  type DateOverridePushHandle,
} from "../../../src/transport/exception-push/index.js";
import { listPendingForClient } from "../../../src/transport/queue/index.js";
import type { ActionExecutor, QueuedAction } from "../../../src/transport/queue/types.js";
import { SshCommandError, SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const target = { host: "mint-01", port: 22, username: "pct-agent" } as const;

/** Wed 2026-06-17 12:00 UTC — reference week Mon 2026-06-15 … Sun 2026-06-21. */
const WED = new Date("2026-06-17T12:00:00Z");
/** The Monday of the *following* week — the override's week has rolled past. */
const NEXT_MON = new Date("2026-06-22T12:00:00Z");

/** An `overall` deny override covering Wednesday 2026-06-17 only. */
const WED_WINDOW = {
  effectiveFrom: new Date("2026-06-17T00:00:00Z"),
  expiresAt: new Date("2026-06-18T00:00:00Z"),
} as const;

/** A recording executor that resolves — `pushOrEnqueue` reports "pushed". */
function recordingExecutor(): { executor: ActionExecutor; actions: QueuedAction[] } {
  const actions: QueuedAction[] = [];
  return {
    actions,
    executor: (action) => {
      actions.push(action);
      return Promise.resolve();
    },
  };
}

describe("startDateOverridePush", () => {
  let app: ReturnType<typeof buildApp>;
  let db: TestDb;
  let log: FastifyBaseLogger;
  let handle: DateOverridePushHandle | undefined;

  beforeEach(() => {
    db = testDb();
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "silent", PCT_SECRET_KEY: "test-secret-key" }),
      db,
    });
    log = app.log;
  });
  afterEach(async () => {
    handle?.stop();
    handle = undefined;
    await app.close();
    db.$client.close();
  });

  /** Start a scheduler with a fixed (or mutable) clock; tracked for teardown. */
  function start(executor: ActionExecutor, now: () => Date): DateOverridePushHandle {
    handle = startDateOverridePush({
      db,
      executor,
      defaultTz: "UTC",
      log,
      now,
      // A pattern that will not fire during the test; we drive `tick()` directly.
      pattern: "0 0 31 2 *",
    });
    return handle;
  }

  function linkedUser(hostname = "mint-01"): { userId: number; clientId: number } {
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const clientId = createClient(db, { hostname, sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
    return { userId, clientId };
  }

  it("pushes an override action to the user's client when an override is active", async () => {
    const { userId, clientId } = linkedUser();
    createException(db, { userId, targetKind: "overall", action: "deny", ...WED_WINDOW });

    const { executor, actions } = recordingExecutor();
    await start(executor, () => WED).tick();

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      clientId,
      coalesceKey: `user:${userId}`,
      kind: EXCEPTION_PUSH_KIND,
      payload: { userId, reason: EXCEPTION_PUSH_REASON },
    });
  });

  it("does not push for a user with no exceptions", async () => {
    linkedUser();

    const { executor, actions } = recordingExecutor();
    await start(executor, () => WED).tick();

    expect(actions).toHaveLength(0);
  });

  it("re-asserts an active override on every tick (self-heals an out-of-band clobber)", async () => {
    // A standing policy push can overwrite the device's allowed-hours grid with
    // the exception-free version (it shares this push's coalesce key) — and the
    // scheduler can't observe that. So while an override is materially active it
    // must re-push every tick, not just on change, or a `deny` override would be
    // silently and permanently lost. Two active ticks → two pushes.
    const { userId } = linkedUser();
    createException(db, { userId, targetKind: "overall", action: "deny", ...WED_WINDOW });

    const { executor, actions } = recordingExecutor();
    const h = start(executor, () => WED);
    await h.tick();
    await h.tick();

    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.kind === EXCEPTION_PUSH_KIND)).toBe(true);
  });

  it("reverts exactly once after the override's week rolls past, then stays quiet", async () => {
    const { userId } = linkedUser();
    createException(db, { userId, targetKind: "overall", action: "deny", ...WED_WINDOW });

    let clock = WED;
    const { executor, actions } = recordingExecutor();
    const h = start(executor, () => clock);

    await h.tick(); // active → push override
    clock = NEXT_MON;
    await h.tick(); // override's week has passed → desired == standing → revert push
    await h.tick(); // already reverted → no further push

    expect(actions).toHaveLength(2);
    expect(actions[0]?.kind).toBe(EXCEPTION_PUSH_KIND);
    expect(actions[1]?.kind).toBe(EXCEPTION_PUSH_KIND);
  });

  it("reconciles a stale override on the first pass after a restart (revert)", async () => {
    const { userId } = linkedUser();
    // The override expired last week; a fresh scheduler has no memory of having
    // pushed it, but the device may still hold the stale grid — first pass reverts.
    createException(db, { userId, targetKind: "overall", action: "deny", ...WED_WINDOW });

    const { executor, actions } = recordingExecutor();
    await start(executor, () => NEXT_MON).tick();

    // Exactly one (revert) push — proving restart reconciliation.
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe(EXCEPTION_PUSH_KIND);
  });

  it("reverts an override that expired beyond the lookback on the first pass (long outage)", async () => {
    const { userId } = linkedUser();
    // Expired ~15 days before `now` — outside the 8-day steady-state lookback, so
    // only the first-pass "any exception row" sweep reconciles the stale device slot.
    createException(db, {
      userId,
      targetKind: "overall",
      action: "deny",
      effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      expiresAt: new Date("2026-06-02T00:00:00Z"),
    });

    const { executor, actions } = recordingExecutor();
    const h = start(executor, () => WED);
    await h.tick(); // first pass: revert the long-stale override
    await h.tick(); // steady state: out of lookback, untracked → quiet

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe(EXCEPTION_PUSH_KIND);
  });

  it("fans the override push out to every client the user is on", async () => {
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const clientA = createClient(db, { hostname: "mint-a", sshUser: "pct-agent" }).id;
    const clientB = createClient(db, { hostname: "mint-b", sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientA, { osUsername: "alice", osUserRef: "1001" });
    upsertLink(db, userId, clientB, { osUsername: "alice", osUserRef: "1001" });
    createException(db, { userId, targetKind: "overall", action: "deny", ...WED_WINDOW });

    const { executor, actions } = recordingExecutor();
    await start(executor, () => WED).tick();

    expect(actions.map((a) => a.clientId).sort((x, y) => x - y)).toEqual(
      [clientA, clientB].sort((x, y) => x - y),
    );
  });

  it("includes an inherited group override (gatherUserExceptions)", async () => {
    const { userId, clientId } = linkedUser();
    const group = createUserGroup(db, { name: "Kids" });
    addUserToGroup(db, group.id, userId);
    createGroupException(db, {
      userGroupId: group.id,
      targetKind: "overall",
      action: "deny",
      ...WED_WINDOW,
    });

    const { executor, actions } = recordingExecutor();
    await start(executor, () => WED).tick();

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ clientId, kind: EXCEPTION_PUSH_KIND });
  });

  it("ignores an activity-scoped override in steady state (a no-op for the grid)", async () => {
    const { userId } = linkedUser();
    // An activity-scoped exception composes but does not change the overall
    // allowed-hours grid (ADR 0012) — so after the first-pass reconcile it never
    // triggers another push.
    createException(db, {
      userId,
      targetKind: "activity",
      targetId: 5,
      action: "deny",
      ...WED_WINDOW,
    });

    const { executor, actions } = recordingExecutor();
    const h = start(executor, () => WED);
    await h.tick(); // first pass reconciles the candidate once (standing grid)
    await h.tick(); // steady state: desired == standing, nothing to revert → no push

    expect(actions).toHaveLength(1);
  });

  it("queues the push for an offline client instead of throwing", async () => {
    const { userId, clientId } = linkedUser();
    createException(db, { userId, targetKind: "overall", action: "deny", ...WED_WINDOW });

    // The executor rejects with a retriable (unreachable) error, so pushOrEnqueue
    // durably queues the action for the drainer rather than surfacing a failure.
    const executor: ActionExecutor = () => Promise.reject(new SshUnreachableError(target));
    await expect(start(executor, () => WED).tick()).resolves.toBeUndefined();

    const pending = listPendingForClient(db, clientId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe(EXCEPTION_PUSH_KIND);
  });

  it("isolates a non-retriable push failure and keeps reconciling", async () => {
    const { userId } = linkedUser();
    createException(db, { userId, targetKind: "overall", action: "deny", ...WED_WINDOW });

    // A non-retriable command error is rethrown by pushOrEnqueue; the scheduler
    // must swallow it (logged) so the pass completes without throwing.
    const executor: ActionExecutor = () =>
      Promise.reject(
        new SshCommandError(target, ["timekpra"], {
          stdout: "",
          stderr: "boom",
          code: 1,
          signal: null,
        }),
      );
    await expect(start(executor, () => WED).tick()).resolves.toBeUndefined();
  });

  it("exposes a stop()-able handle and a default cron pattern", () => {
    const { executor } = recordingExecutor();
    const h = start(executor, () => WED);
    expect(() => h.stop()).not.toThrow();
    handle = undefined; // already stopped
    expect(DEFAULT_EXCEPTION_PUSH_PATTERN).toBe("*/15 * * * *");
  });
});
