/**
 * Unit tests for the pinned per-budget warning-cadence grammar (#302) in
 * `policy/notification.ts` — the single source the storage `$type` and the
 * `/api` DTOs both read. Covers the key grammar, the value bounds + dedup/sort
 * normalisation, the count caps, and the `budgetCadenceKey` helper. The
 * end-to-end validation over the HTTP boundary lives in
 * `tests/api/policy-notification.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  budgetCadenceKey,
  budgetCadenceKeySchema,
  budgetCadenceOverrideSchema,
  cadenceOverridesSchema,
  CADENCE_OVERRIDE_KEYS_MAX,
  WARNING_MINUTE_MAX,
  WARNING_MINUTES_MAX_COUNT,
} from "../../src/policy/notification.js";

describe("budgetCadenceKey", () => {
  it("renders 'overall' with no target id, '<scope>:<id>' otherwise", () => {
    expect(budgetCadenceKey("overall", null)).toBe("overall");
    expect(budgetCadenceKey("activity", 7)).toBe("activity:7");
    expect(budgetCadenceKey("group", 3)).toBe("group:3");
  });

  it("round-trips through the key schema", () => {
    for (const key of ["overall", "activity:7", "group:3"]) {
      expect(budgetCadenceKeySchema.safeParse(key).success).toBe(true);
    }
  });
});

describe("budgetCadenceKeySchema", () => {
  it("accepts the three legal shapes", () => {
    for (const key of ["overall", "activity:1", "group:42"]) {
      expect(budgetCadenceKeySchema.safeParse(key).success).toBe(true);
    }
  });

  it("rejects unknown scopes, missing/zero/negative ids, and stray text", () => {
    for (const key of [
      "homework",
      "activity",
      "activity:",
      "activity:0",
      "activity:-1",
      "activity:1.5",
      "overall:1",
      "user:1",
      "activity:1 ",
    ]) {
      expect(budgetCadenceKeySchema.safeParse(key).success).toBe(false);
    }
  });
});

describe("budgetCadenceOverrideSchema", () => {
  it("de-duplicates and sorts warn-at marks descending", () => {
    const parsed = budgetCadenceOverrideSchema.parse({ warningMinutes: [5, 15, 10, 10, 5] });
    expect(parsed.warningMinutes).toEqual([15, 10, 5]);
  });

  it("accepts an empty list (warn only at 0:00)", () => {
    expect(budgetCadenceOverrideSchema.parse({ warningMinutes: [] }).warningMinutes).toEqual([]);
  });

  it("enforces the per-mark bounds", () => {
    expect(budgetCadenceOverrideSchema.safeParse({ warningMinutes: [0] }).success).toBe(false);
    expect(budgetCadenceOverrideSchema.safeParse({ warningMinutes: [1.5] }).success).toBe(false);
    expect(
      budgetCadenceOverrideSchema.safeParse({ warningMinutes: [WARNING_MINUTE_MAX + 1] }).success,
    ).toBe(false);
    expect(
      budgetCadenceOverrideSchema.safeParse({ warningMinutes: [WARNING_MINUTE_MAX] }).success,
    ).toBe(true);
  });

  it("rejects too many marks and unknown fields", () => {
    const tooMany = Array.from({ length: WARNING_MINUTES_MAX_COUNT + 1 }, (_, i) => i + 1);
    expect(budgetCadenceOverrideSchema.safeParse({ warningMinutes: tooMany }).success).toBe(false);
    expect(
      budgetCadenceOverrideSchema.safeParse({ warningMinutes: [5], extra: true }).success,
    ).toBe(false);
  });
});

describe("cadenceOverridesSchema", () => {
  it("validates a map keyed by legal budget keys", () => {
    const parsed = cadenceOverridesSchema.parse({
      overall: { warningMinutes: [15, 10] },
      "activity:1": { warningMinutes: [5, 5, 3] },
    });
    expect(parsed).toEqual({
      overall: { warningMinutes: [15, 10] },
      "activity:1": { warningMinutes: [5, 3] },
    });
  });

  it("rejects an illegal key", () => {
    expect(cadenceOverridesSchema.safeParse({ homework: { warningMinutes: [5] } }).success).toBe(
      false,
    );
  });

  it("caps the number of overridden budgets", () => {
    const map: Record<string, { warningMinutes: number[] }> = {};
    for (let i = 1; i <= CADENCE_OVERRIDE_KEYS_MAX + 1; i++) {
      map[`activity:${String(i)}`] = { warningMinutes: [5] };
    }
    expect(cadenceOverridesSchema.safeParse(map).success).toBe(false);
  });
});
