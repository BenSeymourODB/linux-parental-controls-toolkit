/**
 * Unit tests for the shared always-on `domain`-deny resolver
 * (`policy/domain-denies.ts`), consumed by both the e2guardian per-UID filter
 * plan (#90) and the AdGuard per-device DNS blocklist (#97).
 */
import { describe, expect, it } from "vitest";

import {
  domainsForDenyRule,
  isAlwaysOnRule,
  resolveAlwaysOnDomainDenies,
} from "../../src/policy/domain-denies.js";
import {
  addActivityToGroup,
  addUserToGroup,
  createActivity,
  createActivityGroup,
  createGroupSchedule,
  createSchedule,
  createUser,
  createUserGroup,
} from "../../src/policy/repository.js";
import type { ScheduleRule } from "../../src/policy/schedule-precedence.js";
import { testDb } from "../helpers/db.js";

/** A minimal always-on deny rule literal for the pure predicate tests. */
function rule(overrides: Partial<ScheduleRule> = {}): ScheduleRule {
  return {
    id: 1,
    ordinal: 0,
    targetKind: "activity",
    targetId: 1,
    action: "deny",
    recurrenceDays: null,
    recurrenceStartMinute: null,
    recurrenceEndMinute: null,
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  };
}

describe("isAlwaysOnRule", () => {
  it("is true only when every recurrence/date field is null", () => {
    expect(isAlwaysOnRule(rule())).toBe(true);
  });

  it("is false when any recurrence or date-scoping field is set", () => {
    expect(isAlwaysOnRule(rule({ recurrenceDays: 0b0111110 }))).toBe(false);
    expect(isAlwaysOnRule(rule({ recurrenceStartMinute: 960 }))).toBe(false);
    expect(isAlwaysOnRule(rule({ recurrenceEndMinute: 1080 }))).toBe(false);
    expect(isAlwaysOnRule(rule({ effectiveFrom: new Date("2026-01-01") }))).toBe(false);
    expect(isAlwaysOnRule(rule({ effectiveTo: new Date("2026-12-31") }))).toBe(false);
  });
});

describe("domainsForDenyRule", () => {
  it("returns [] for a rule with no target", () => {
    const db = testDb();
    expect(domainsForDenyRule(db, rule({ targetId: null }))).toEqual([]);
    db.$client.close();
  });

  it("resolves a domain activity to its matcher and ignores non-domain kinds", () => {
    const db = testDb();
    const yt = createActivity(db, { kind: "domain", matcher: "youtube.com" });
    const app = createActivity(db, { kind: "app", matcher: "steam" });
    expect(domainsForDenyRule(db, rule({ targetKind: "activity", targetId: yt.id }))).toEqual([
      "youtube.com",
    ]);
    expect(domainsForDenyRule(db, rule({ targetKind: "activity", targetId: app.id }))).toEqual([]);
    db.$client.close();
  });

  it("expands a group to its domain members only (apps + domain_group skipped)", () => {
    const db = testDb();
    const group = createActivityGroup(db, { name: "Distractions" });
    const fb = createActivity(db, { kind: "domain", matcher: "facebook.com" });
    const app = createActivity(db, { kind: "app", matcher: "steam" });
    const bundle = createActivity(db, { kind: "domain_group", matcher: "social" });
    addActivityToGroup(db, group.id, fb.id);
    addActivityToGroup(db, group.id, app.id);
    addActivityToGroup(db, group.id, bundle.id);
    expect(domainsForDenyRule(db, rule({ targetKind: "group", targetId: group.id }))).toEqual([
      "facebook.com",
    ]);
    db.$client.close();
  });
});

describe("resolveAlwaysOnDomainDenies", () => {
  it("collects a user's always-on domain denies, deduplicated and sorted", () => {
    const db = testDb();
    const alice = createUser(db, { displayName: "Alice" }).id;
    const yt = createActivity(db, { kind: "domain", matcher: "youtube.com" });
    const fb = createActivity(db, { kind: "domain", matcher: "facebook.com" });
    const fb2 = createActivity(db, { kind: "domain", matcher: "facebook.com" });
    createSchedule(db, { userId: alice, targetKind: "activity", targetId: yt.id, action: "deny" });
    createSchedule(db, { userId: alice, targetKind: "activity", targetId: fb.id, action: "deny" });
    createSchedule(db, { userId: alice, targetKind: "activity", targetId: fb2.id, action: "deny" });

    expect(resolveAlwaysOnDomainDenies(db, alice)).toEqual(["facebook.com", "youtube.com"]);
    db.$client.close();
  });

  it("excludes recurring-window and date-scoped denies, and non-deny actions", () => {
    const db = testDb();
    const alice = createUser(db, { displayName: "Alice" }).id;
    const windowed = createActivity(db, { kind: "domain", matcher: "windowed.com" });
    const dated = createActivity(db, { kind: "domain", matcher: "dated.com" });
    const allowed = createActivity(db, { kind: "domain", matcher: "allowed.com" });
    createSchedule(db, {
      userId: alice,
      targetKind: "activity",
      targetId: windowed.id,
      action: "deny",
      recurrenceStartMinute: 960,
      recurrenceEndMinute: 1080,
    });
    createSchedule(db, {
      userId: alice,
      targetKind: "activity",
      targetId: dated.id,
      action: "deny",
      effectiveFrom: new Date("2026-01-01"),
      effectiveTo: new Date("2026-01-07"),
    });
    createSchedule(db, {
      userId: alice,
      targetKind: "activity",
      targetId: allowed.id,
      action: "allow",
    });

    expect(resolveAlwaysOnDomainDenies(db, alice)).toEqual([]);
    db.$client.close();
  });

  it("includes denies inherited from a user group (#362)", () => {
    const db = testDb();
    const alice = createUser(db, { displayName: "Alice" }).id;
    const group = createUserGroup(db, { name: "Kids" });
    addUserToGroup(db, group.id, alice);
    const yt = createActivity(db, { kind: "domain", matcher: "youtube.com" });
    createGroupSchedule(db, {
      userGroupId: group.id,
      targetKind: "activity",
      targetId: yt.id,
      action: "deny",
    });

    expect(resolveAlwaysOnDomainDenies(db, alice)).toEqual(["youtube.com"]);
    db.$client.close();
  });
});
