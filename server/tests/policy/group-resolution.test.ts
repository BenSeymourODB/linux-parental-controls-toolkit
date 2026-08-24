/**
 * Unit tests for user-over-group schedule resolution (#182, ADR 0007) against a
 * hermetic in-memory policy DB. Pins the precedence contract from
 * `policy/group-resolution.ts`: own rules first, then each group's rules
 * (groups ascending by id), re-sequenced to dense ordinals so the merge order
 * is authoritative and the result drops into `resolveEffectiveRule`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  gatherUserBudgets,
  gatherUserExceptions,
  gatherUserScheduleRules,
  mergeScheduleRulesWithGroups,
} from "../../src/policy/group-resolution.js";
import * as repo from "../../src/policy/repository.js";
import { resolveEffectiveRule, type ScheduleRule } from "../../src/policy/schedule-precedence.js";
import { testDb, type TestDb } from "../helpers/db.js";

describe("gatherUserScheduleRules (#182)", () => {
  let db: TestDb;
  let userId: number;
  beforeEach(() => {
    db = testDb();
    userId = repo.createUser(db, { displayName: "Alice" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("returns only the user's own rules when they belong to no group", () => {
    const a = repo.createSchedule(db, {
      userId,
      targetKind: "overall",
      action: "deny",
      ordinal: 1,
    });
    const b = repo.createSchedule(db, {
      userId,
      targetKind: "overall",
      action: "allow",
      ordinal: 0,
    });

    const gathered = gatherUserScheduleRules(db, userId);
    // Sorted by (ordinal, id): b (ordinal 0) then a (ordinal 1), re-sequenced 0,1.
    expect(gathered.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(gathered.map((r) => r.ordinal)).toEqual([0, 1]);
    expect(gathered.every((r) => r.source.kind === "user")).toBe(true);
  });

  it("returns an empty list for a user with no rules and no groups", () => {
    expect(gatherUserScheduleRules(db, userId)).toEqual([]);
  });

  it("places the user's own rules before inherited group rules", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);

    const groupRule = repo.createGroupSchedule(db, {
      userGroupId: group.id,
      targetKind: "overall",
      action: "deny",
      ordinal: 0,
    });
    const ownRule = repo.createSchedule(db, {
      userId,
      targetKind: "overall",
      action: "allow",
      ordinal: 0,
    });

    const gathered = gatherUserScheduleRules(db, userId);
    // Own rule wins the first slot even though both carry ordinal 0.
    expect(gathered.map((r) => r.id)).toEqual([ownRule.id, groupRule.id]);
    expect(gathered.map((r) => r.ordinal)).toEqual([0, 1]);
    expect(gathered.map((r) => r.source)).toEqual([
      { kind: "user" },
      { kind: "group", groupId: group.id },
    ]);
  });

  it("orders multiple groups' rules by ascending group id, after the user's own", () => {
    const kids = repo.createUserGroup(db, { name: "Kids" });
    const teens = repo.createUserGroup(db, { name: "Teens" });
    repo.addUserToGroup(db, teens.id, userId);
    repo.addUserToGroup(db, kids.id, userId);

    const teensRule = repo.createGroupSchedule(db, {
      userGroupId: teens.id,
      targetKind: "overall",
      action: "deny",
    });
    const kidsRule = repo.createGroupSchedule(db, {
      userGroupId: kids.id,
      targetKind: "overall",
      action: "deny",
    });
    const ownRule = repo.createSchedule(db, { userId, targetKind: "overall", action: "allow" });

    const gathered = gatherUserScheduleRules(db, userId);
    // own, then kids (lower group id), then teens — regardless of membership add
    // order or the group rows' own ids.
    expect(gathered.map((r) => r.source)).toEqual([
      { kind: "user" },
      { kind: "group", groupId: kids.id },
      { kind: "group", groupId: teens.id },
    ]);
    expect(gathered.map((r) => r.id)).toEqual([ownRule.id, kidsRule.id, teensRule.id]);
    expect(gathered.map((r) => r.ordinal)).toEqual([0, 1, 2]);
  });

  it("produces a list resolveEffectiveRule consumes with own-rule precedence", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);
    // Group denies overall always-on; the user's own always-on allow overrides.
    repo.createGroupSchedule(db, { userGroupId: group.id, targetKind: "overall", action: "deny" });
    repo.createSchedule(db, { userId, targetKind: "overall", action: "allow" });

    const winner = resolveEffectiveRule(gatherUserScheduleRules(db, userId), () => true);
    expect(winner?.action).toBe("allow");
    expect(winner?.source).toEqual({ kind: "user" });
  });

  it("resolves passed-in own rules by ordinal, not array order (preview fidelity, #362)", () => {
    // The save-and-push preview passes proposed own rules straight from the
    // request body, which need not arrive in ordinal order. The merge must sort
    // them by (ordinal, id) so precedence matches what the save + reload yields.
    const base = {
      targetKind: "overall" as const,
      targetId: null,
      recurrenceDays: null,
      recurrenceStartMinute: null,
      recurrenceEndMinute: null,
      effectiveFrom: null,
      effectiveTo: null,
    };
    const outOfOrder: ScheduleRule[] = [
      { id: 2, ordinal: 1, action: "deny", ...base },
      { id: 1, ordinal: 0, action: "allow", ...base },
    ];

    const merged = mergeScheduleRulesWithGroups(db, userId, outOfOrder);

    // ordinal 0 (allow, id 1) wins the first slot despite being passed second.
    expect(merged.map((r) => r.id)).toEqual([1, 2]);
    expect(merged.map((r) => r.ordinal)).toEqual([0, 1]);
    expect(merged.map((r) => r.action)).toEqual(["allow", "deny"]);
    expect(resolveEffectiveRule(merged, () => true)?.action).toBe("allow");
  });

  it("falls back to the inherited group rule when the user has none", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);
    repo.createGroupSchedule(db, { userGroupId: group.id, targetKind: "overall", action: "deny" });

    const winner = resolveEffectiveRule(gatherUserScheduleRules(db, userId), () => true);
    expect(winner?.action).toBe("deny");
    expect(winner?.source).toEqual({ kind: "group", groupId: group.id });
  });
});

describe("gatherUserBudgets (#134)", () => {
  let db: TestDb;
  let userId: number;
  beforeEach(() => {
    db = testDb();
    userId = repo.createUser(db, { displayName: "Alice" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("returns an empty list for a user with no budgets and no groups", () => {
    expect(gatherUserBudgets(db, userId)).toEqual([]);
  });

  it("returns only the user's own budgets when they belong to no group", () => {
    repo.createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 3600 });
    const gathered = gatherUserBudgets(db, userId);
    expect(gathered).toHaveLength(1);
    expect(gathered[0]?.secondsAllowed).toBe(3600);
    expect(gathered[0]?.source).toEqual({ kind: "user" });
  });

  it("carries the weekday-recurrence mask through the merge, own and inherited (#141)", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);
    // Group per-activity weekday budget (a slot the user does not override).
    repo.createGroupBudget(db, {
      userGroupId: group.id,
      scope: "activity",
      targetId: 2,
      window: "daily",
      secondsAllowed: 3600,
      recurrenceDays: 31, // Mon..Fri
    });
    // The user's own overall weekend budget for a different slot.
    repo.createBudget(db, {
      userId,
      scope: "overall",
      window: "daily",
      secondsAllowed: 7200,
      recurrenceDays: (1 << 5) | (1 << 6), // Sat + Sun
    });

    const gathered = gatherUserBudgets(db, userId);
    const own = gathered.find((b) => b.source.kind === "user");
    const inherited = gathered.find((b) => b.source.kind === "group");
    expect(own?.recurrenceDays).toBe((1 << 5) | (1 << 6));
    expect(inherited?.recurrenceDays).toBe(31);
  });

  it("leaves recurrenceDays null for a uniform budget row (#141)", () => {
    repo.createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 3600 });
    expect(gatherUserBudgets(db, userId)[0]?.recurrenceDays).toBeNull();
  });

  it("inherits the group baseline for a slot the user has not defined", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);
    repo.createGroupBudget(db, {
      userGroupId: group.id,
      scope: "overall",
      window: "daily",
      secondsAllowed: 7200,
    });

    const gathered = gatherUserBudgets(db, userId);
    expect(gathered).toHaveLength(1);
    expect(gathered[0]?.secondsAllowed).toBe(7200);
    expect(gathered[0]?.source).toEqual({ kind: "group", groupId: group.id });
  });

  it("fully replaces the inherited group budget with the user's own for the same slot", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);
    repo.createGroupBudget(db, {
      userGroupId: group.id,
      scope: "overall",
      window: "daily",
      secondsAllowed: 7200,
    });
    repo.createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 1800 });

    const gathered = gatherUserBudgets(db, userId);
    // The user's own 1800 fully replaces the group's 7200 for overall/daily —
    // no sum, exactly one source for the slot.
    expect(gathered).toHaveLength(1);
    expect(gathered[0]?.secondsAllowed).toBe(1800);
    expect(gathered[0]?.source).toEqual({ kind: "user" });
  });

  it("overrides per slot — a user override of one window still inherits the other", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);
    repo.createGroupBudget(db, {
      userGroupId: group.id,
      scope: "overall",
      window: "daily",
      secondsAllowed: 7200,
    });
    repo.createGroupBudget(db, {
      userGroupId: group.id,
      scope: "overall",
      window: "weekly",
      secondsAllowed: 36000,
    });
    // The user overrides only the daily slot.
    repo.createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 1800 });

    const gathered = gatherUserBudgets(db, userId);
    const daily = gathered.find((b) => b.window === "daily");
    const weekly = gathered.find((b) => b.window === "weekly");
    expect(daily?.secondsAllowed).toBe(1800);
    expect(daily?.source).toEqual({ kind: "user" });
    expect(weekly?.secondsAllowed).toBe(36000);
    expect(weekly?.source).toEqual({ kind: "group", groupId: group.id });
  });

  it("keys a slot on the target so an activity override does not shadow overall", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);
    const activity = repo.createActivity(db, { kind: "app", matcher: "steam" });
    repo.createGroupBudget(db, {
      userGroupId: group.id,
      scope: "overall",
      window: "daily",
      secondsAllowed: 7200,
    });
    repo.createGroupBudget(db, {
      userGroupId: group.id,
      scope: "activity",
      targetId: activity.id,
      window: "daily",
      secondsAllowed: 3600,
    });
    // User overrides only the activity slot.
    repo.createBudget(db, {
      userId,
      scope: "activity",
      targetId: activity.id,
      window: "daily",
      secondsAllowed: 600,
    });

    const gathered = gatherUserBudgets(db, userId);
    const overall = gathered.find((b) => b.scope === "overall");
    const act = gathered.find((b) => b.scope === "activity");
    expect(overall?.secondsAllowed).toBe(7200);
    expect(overall?.source).toEqual({ kind: "group", groupId: group.id });
    expect(act?.secondsAllowed).toBe(600);
    expect(act?.source).toEqual({ kind: "user" });
  });

  it("breaks a multi-group tie on the same slot by lowest group id", () => {
    const kids = repo.createUserGroup(db, { name: "Kids" });
    const teens = repo.createUserGroup(db, { name: "Teens" });
    // Add in reverse id order to prove the tiebreak is by id, not membership order.
    repo.addUserToGroup(db, teens.id, userId);
    repo.addUserToGroup(db, kids.id, userId);
    repo.createGroupBudget(db, {
      userGroupId: teens.id,
      scope: "overall",
      window: "daily",
      secondsAllowed: 9000,
    });
    repo.createGroupBudget(db, {
      userGroupId: kids.id,
      scope: "overall",
      window: "daily",
      secondsAllowed: 3600,
    });

    const gathered = gatherUserBudgets(db, userId);
    expect(gathered).toHaveLength(1);
    expect(gathered[0]?.secondsAllowed).toBe(3600);
    expect(gathered[0]?.source).toEqual({ kind: "group", groupId: kids.id });
  });

  it("sums duplicate same-slot budgets within a single source", () => {
    repo.createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 1200 });
    repo.createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 600 });

    const gathered = gatherUserBudgets(db, userId);
    // Both own rows are emitted (the resolver sums them, preserving existing
    // single-source behaviour); only cross-source slots are deduped.
    expect(gathered).toHaveLength(2);
    expect(gathered.every((b) => b.source.kind === "user")).toBe(true);
    expect(gathered.reduce((sum, b) => sum + b.secondsAllowed, 0)).toBe(1800);
  });

  it("sums duplicate same-slot budgets within a single inherited group", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);
    repo.createGroupBudget(db, {
      userGroupId: group.id,
      scope: "overall",
      window: "daily",
      secondsAllowed: 1200,
    });
    repo.createGroupBudget(db, {
      userGroupId: group.id,
      scope: "overall",
      window: "daily",
      secondsAllowed: 600,
    });

    const gathered = gatherUserBudgets(db, userId);
    // Two same-slot rows *within one group* are both emitted — the gatherer
    // folds a group's slots into `covered` only after the whole group, so the
    // resolver sums them exactly as it does the user's own duplicates. This is
    // the branch that distinguishes `covered.has(key)` from per-group dedup.
    expect(gathered).toHaveLength(2);
    expect(gathered.every((b) => b.source.kind === "group")).toBe(true);
    expect(gathered.reduce((sum, b) => sum + b.secondsAllowed, 0)).toBe(1800);
  });
});

describe("gatherUserExceptions (#142, ADR 0012)", () => {
  let db: TestDb;
  let userId: number;
  const expiresAt = new Date("2030-01-01T00:00:00Z");
  beforeEach(() => {
    db = testDb();
    userId = repo.createUser(db, { displayName: "Alice" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("returns an empty list for a user with no exceptions and no groups", () => {
    expect(gatherUserExceptions(db, userId)).toEqual([]);
  });

  it("returns only the user's own exceptions, newest-first, when in no group", () => {
    const first = repo.createException(db, {
      userId,
      targetKind: "overall",
      action: "deny",
      expiresAt,
    });
    const second = repo.createException(db, {
      userId,
      targetKind: "overall",
      action: "allow",
      expiresAt,
    });
    // Newest-first: same-second createdAt ties break on descending id.
    expect(gatherUserExceptions(db, userId).map((e) => e.id)).toEqual([second.id, first.id]);
  });

  it("places the user's own exceptions before inherited group exceptions", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);
    const groupExc = repo.createGroupException(db, {
      userGroupId: group.id,
      targetKind: "overall",
      action: "deny",
      expiresAt,
    });
    const ownExc = repo.createException(db, {
      userId,
      targetKind: "overall",
      action: "allow",
      expiresAt,
    });

    const gathered = gatherUserExceptions(db, userId);
    // Own first (highest precedence), then the inherited group override.
    expect(gathered.map((e) => e.id)).toEqual([ownExc.id, groupExc.id]);
    expect(gathered.map((e) => e.action)).toEqual(["allow", "deny"]);
  });

  it("orders inherited exceptions by ascending group id, then newest-first within a group", () => {
    const groupA = repo.createUserGroup(db, { name: "A" });
    const groupB = repo.createUserGroup(db, { name: "B" });
    repo.addUserToGroup(db, groupA.id, userId);
    repo.addUserToGroup(db, groupB.id, userId);
    const bExc = repo.createGroupException(db, {
      userGroupId: groupB.id,
      targetKind: "overall",
      action: "deny",
      expiresAt,
    });
    const aExc1 = repo.createGroupException(db, {
      userGroupId: groupA.id,
      targetKind: "overall",
      action: "deny",
      expiresAt,
    });
    const aExc2 = repo.createGroupException(db, {
      userGroupId: groupA.id,
      targetKind: "overall",
      action: "allow",
      expiresAt,
    });

    // groupA (lower id) first — newest-first within it — then groupB.
    expect(gatherUserExceptions(db, userId).map((e) => e.id)).toEqual([
      aExc2.id,
      aExc1.id,
      bExc.id,
    ]);
  });

  it("preserves each exception's active-window fields for the resolver", () => {
    const effectiveFrom = new Date("2029-06-01T00:00:00Z");
    repo.createException(db, {
      userId,
      targetKind: "activity",
      targetId: 5,
      action: "extend",
      effectiveFrom,
      expiresAt,
    });
    const [gathered] = gatherUserExceptions(db, userId);
    expect(gathered).toMatchObject({
      targetKind: "activity",
      targetId: 5,
      action: "extend",
      effectiveFrom,
      expiresAt,
    });
    expect(gathered?.createdAt).toBeInstanceOf(Date);
  });
});
