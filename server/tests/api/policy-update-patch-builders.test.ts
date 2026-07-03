/**
 * Unit coverage for the shared PATCH update-payload builders extracted from
 * `registerPolicyRoutes` (#225): `buildScheduleUpdatePatch` /
 * `buildExceptionUpdatePatch`. They centralise the conditional-field-inclusion +
 * timestamp normalization the Schedule/GroupSchedule and Exception/GroupException
 * PATCH handlers previously duplicated inline. The route-level behaviour stays
 * covered by the HTTP suites; these lock the pure mapping directly.
 */
import { describe, expect, it } from "vitest";

import type { UpdateExceptionRequest, UpdateScheduleRequest } from "../../src/api/policy/dtos.js";
import {
  buildExceptionUpdatePatch,
  buildScheduleUpdatePatch,
  nullableDate,
} from "../../src/api/policy/routes/shared.js";

describe("nullableDate", () => {
  it("passes null through unchanged", () => {
    expect(nullableDate(null)).toBeNull();
  });

  it("parses an ISO-8601 string into a Date", () => {
    const d = nullableDate("2026-07-03T12:00:00.000Z");
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe("2026-07-03T12:00:00.000Z");
  });
});

describe("buildScheduleUpdatePatch", () => {
  it("includes only the fields the body carries (an omitted field stays absent)", () => {
    const body: UpdateScheduleRequest = { action: "deny" };
    const patch = buildScheduleUpdatePatch(body);
    expect(patch).toEqual({ action: "deny" });
    // Omitted fields are absent, not present-and-undefined — so the repository
    // update leaves them unchanged rather than nulling them.
    expect(Object.keys(patch)).toEqual(["action"]);
  });

  it("returns an empty patch for an empty body", () => {
    expect(buildScheduleUpdatePatch({})).toEqual({});
  });

  it("normalises the recurrence bounds and both effective timestamps", () => {
    const body: UpdateScheduleRequest = {
      targetKind: "activity",
      targetId: 7,
      action: "allow",
      recurrenceDays: 0b0111110,
      recurrenceStartMinute: 960,
      recurrenceEndMinute: 1080,
      effectiveFrom: "2026-07-01T00:00:00.000Z",
      effectiveTo: "2026-07-31T00:00:00.000Z",
      ordinal: 3,
    };
    const patch = buildScheduleUpdatePatch(body);
    expect(patch).toEqual({
      targetKind: "activity",
      targetId: 7,
      action: "allow",
      recurrenceDays: 0b0111110,
      recurrenceStartMinute: 960,
      recurrenceEndMinute: 1080,
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
      effectiveTo: new Date("2026-07-31T00:00:00.000Z"),
      ordinal: 3,
    });
  });

  it("passes an explicit null through for targetId and the effective bounds (clearing them)", () => {
    const body: UpdateScheduleRequest = {
      targetKind: "overall",
      targetId: null,
      recurrenceDays: null,
      recurrenceStartMinute: null,
      recurrenceEndMinute: null,
      effectiveFrom: null,
      effectiveTo: null,
    };
    const patch = buildScheduleUpdatePatch(body);
    expect(patch).toEqual({
      targetKind: "overall",
      targetId: null,
      recurrenceDays: null,
      recurrenceStartMinute: null,
      recurrenceEndMinute: null,
      effectiveFrom: null,
      effectiveTo: null,
    });
  });
});

describe("buildExceptionUpdatePatch", () => {
  it("includes only the fields the body carries", () => {
    const body: UpdateExceptionRequest = { reason: "sick day" };
    const patch = buildExceptionUpdatePatch(body);
    expect(patch).toEqual({ reason: "sick day" });
    expect(Object.keys(patch)).toEqual(["reason"]);
  });

  it("returns an empty patch for an empty body", () => {
    expect(buildExceptionUpdatePatch({})).toEqual({});
  });

  it("normalises effectiveFrom (nullable) and expiresAt (required-once-present)", () => {
    const body: UpdateExceptionRequest = {
      targetKind: "activity",
      targetId: 4,
      action: "allow",
      reason: null,
      effectiveFrom: "2026-07-03T08:00:00.000Z",
      expiresAt: "2026-07-03T20:00:00.000Z",
    };
    const patch = buildExceptionUpdatePatch(body);
    expect(patch).toEqual({
      targetKind: "activity",
      targetId: 4,
      action: "allow",
      reason: null,
      effectiveFrom: new Date("2026-07-03T08:00:00.000Z"),
      expiresAt: new Date("2026-07-03T20:00:00.000Z"),
    });
  });

  it("passes an explicit null effectiveFrom through (open-start window)", () => {
    const patch = buildExceptionUpdatePatch({ effectiveFrom: null });
    expect(patch).toEqual({ effectiveFrom: null });
  });
});
