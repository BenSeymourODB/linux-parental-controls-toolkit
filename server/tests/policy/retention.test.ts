/**
 * Unit tests for the pure retention model (#136): resolution, the `isExpired`
 * age predicate (including the exact-window boundary and `keepForever`), and
 * the `RetentionPolicy` resolver the purge job (#137/#138) will lean on. No
 * I/O — these lock the rule that lives in `policy/retention.ts`.
 */
import { describe, expect, it } from "vitest";

import type { RetentionCategory } from "../../src/policy/enums.js";
import {
  DEFAULT_RETENTION_DAYS,
  RetentionPolicy,
  RetentionOverrideError,
  isExpired,
  overrideToResolved,
  resolveRetention,
  type ResolvedRetention,
} from "../../src/policy/retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-20T00:00:00.000Z");

/** A timestamp `days` (and optional `ms`) before {@link NOW}. */
function ago(days: number, ms = 0): Date {
  return new Date(NOW.getTime() - days * DAY_MS - ms);
}

describe("overrideToResolved", () => {
  it("maps a keep-forever row to keepForever", () => {
    expect(overrideToResolved({ category: "audit_log", keepForever: true, days: null })).toEqual({
      keepForever: true,
    });
  });

  it("maps a custom-window row to its day count", () => {
    expect(overrideToResolved({ category: "usage_samples", keepForever: false, days: 30 })).toEqual(
      { keepForever: false, days: 30 },
    );
  });

  it("rejects an incoherent row (not keepForever, no positive days)", () => {
    expect(() =>
      overrideToResolved({ category: "grant_ledger", keepForever: false, days: null }),
    ).toThrow(RetentionOverrideError);
    expect(() =>
      overrideToResolved({ category: "grant_ledger", keepForever: false, days: 0 }),
    ).toThrow(RetentionOverrideError);
  });
});

describe("resolveRetention", () => {
  it("inherits the default when no override is present", () => {
    expect(resolveRetention("audit_log", 365, new Map())).toEqual({
      keepForever: false,
      days: 365,
    });
  });

  it("prefers an override over the default", () => {
    const overrides = new Map<RetentionCategory, ResolvedRetention>([
      ["audit_log", { keepForever: true }],
    ]);
    expect(resolveRetention("audit_log", 365, overrides)).toEqual({ keepForever: true });
  });
});

describe("isExpired", () => {
  it("never expires under keepForever", () => {
    expect(isExpired(ago(10_000), { keepForever: true }, NOW)).toBe(false);
  });

  it("treats a record younger than the window as live", () => {
    expect(isExpired(ago(29), { keepForever: false, days: 30 }, NOW)).toBe(false);
  });

  it("retains a record exactly at the window edge (strictly-older purges)", () => {
    expect(isExpired(ago(30), { keepForever: false, days: 30 }, NOW)).toBe(false);
    // One millisecond past the window tips it over.
    expect(isExpired(ago(30, 1), { keepForever: false, days: 30 }, NOW)).toBe(true);
  });

  it("expires a record well past the window", () => {
    expect(isExpired(ago(400), { keepForever: false, days: 365 }, NOW)).toBe(true);
  });
});

describe("RetentionPolicy", () => {
  it("uses the default for categories without an override", () => {
    const policy = RetentionPolicy.fromOverrides(DEFAULT_RETENTION_DAYS, []);
    expect(policy.forCategory("usage_samples")).toEqual({
      keepForever: false,
      days: DEFAULT_RETENTION_DAYS,
    });
    expect(policy.hasOverride("usage_samples")).toBe(false);
  });

  it("applies a per-category override and reports it as overridden", () => {
    const policy = RetentionPolicy.fromOverrides(365, [
      { category: "usage_samples", keepForever: false, days: 30 },
      { category: "audit_log", keepForever: true, days: null },
    ]);
    expect(policy.forCategory("usage_samples")).toEqual({ keepForever: false, days: 30 });
    expect(policy.hasOverride("usage_samples")).toBe(true);
    expect(policy.forCategory("audit_log")).toEqual({ keepForever: true });
    // grant_ledger has no override → inherits default.
    expect(policy.forCategory("grant_ledger")).toEqual({ keepForever: false, days: 365 });
  });

  it("isExpired routes per category", () => {
    const policy = RetentionPolicy.fromOverrides(365, [
      { category: "usage_samples", keepForever: false, days: 30 },
      { category: "audit_log", keepForever: true, days: null },
    ]);
    // usage: 30-day window → 31 days old is expired, 10 days old is not.
    expect(policy.isExpired("usage_samples", ago(31), NOW)).toBe(true);
    expect(policy.isExpired("usage_samples", ago(10), NOW)).toBe(false);
    // audit: keep forever → never expires, even ancient rows.
    expect(policy.isExpired("audit_log", ago(10_000), NOW)).toBe(false);
    // grant_ledger: default 365 → 400 days old expires.
    expect(policy.isExpired("grant_ledger", ago(400), NOW)).toBe(true);
  });

  it("resolveAll covers every category in declaration order", () => {
    const policy = RetentionPolicy.fromOverrides(365, [
      { category: "audit_log", keepForever: true, days: null },
    ]);
    const all = policy.resolveAll();
    expect(all.map((entry) => entry.category)).toEqual([
      "usage_samples",
      "grant_ledger",
      "audit_log",
      "date_overrides",
    ]);
    const audit = all.find((entry) => entry.category === "audit_log");
    expect(audit).toEqual({
      category: "audit_log",
      retention: { keepForever: true },
      isOverride: true,
    });
  });

  it("fromOverrides rejects a corrupt row rather than defaulting to keep-forever", () => {
    expect(() =>
      RetentionPolicy.fromOverrides(365, [
        { category: "usage_samples", keepForever: false, days: null },
      ]),
    ).toThrow(RetentionOverrideError);
  });
});
