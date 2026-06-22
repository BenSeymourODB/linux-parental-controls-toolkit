/**
 * Unit tests for user-over-group schedule resolution (#182, ADR 0007) against a
 * hermetic in-memory policy DB. Pins the precedence contract from
 * `policy/group-resolution.ts`: own rules first, then each group's rules
 * (groups ascending by id), re-sequenced to dense ordinals so the merge order
 * is authoritative and the result drops into `resolveEffectiveRule`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gatherUserScheduleRules } from "../../src/policy/group-resolution.js";
import * as repo from "../../src/policy/repository.js";
import { resolveEffectiveRule } from "../../src/policy/schedule-precedence.js";
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

  it("falls back to the inherited group rule when the user has none", () => {
    const group = repo.createUserGroup(db, { name: "Kids" });
    repo.addUserToGroup(db, group.id, userId);
    repo.createGroupSchedule(db, { userGroupId: group.id, targetKind: "overall", action: "deny" });

    const winner = resolveEffectiveRule(gatherUserScheduleRules(db, userId), () => true);
    expect(winner?.action).toBe("deny");
    expect(winner?.source).toEqual({ kind: "group", groupId: group.id });
  });
});
