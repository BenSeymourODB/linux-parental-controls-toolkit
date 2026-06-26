/**
 * Unit tests for the queued same-day-adjustment model (#274): the payload the
 * executor reads, the unique non-coalescing key, and the resolve-up-front-vs-
 * deferred split between `=` and `+`/`-`.
 */
import { describe, expect, it } from "vitest";

import {
  TIME_TODAY_KIND,
  formatCalendarDate,
  queuedActionForOfflineAdjustment,
  timeTodayPayloadSchema,
  type OfflineAdjustment,
} from "../../../src/transport/time-today/queued.js";

function adjustment(overrides: Partial<OfflineAdjustment> = {}): OfflineAdjustment {
  return {
    clientId: 1,
    userId: 7,
    osUsername: "alice",
    targetDate: "2026-06-23",
    operation: "+",
    seconds: 1800,
    ...overrides,
  };
}

describe("formatCalendarDate", () => {
  it("zero-pads to YYYY-MM-DD", () => {
    expect(formatCalendarDate({ year: 2026, month: 6, day: 3 })).toBe("2026-06-03");
  });
});

describe("queuedActionForOfflineAdjustment", () => {
  it("defers the absolute target for a delta (null until reconnect)", () => {
    const action = queuedActionForOfflineAdjustment(adjustment({ operation: "+", seconds: 1800 }));
    expect(action.kind).toBe(TIME_TODAY_KIND);
    const payload = timeTodayPayloadSchema.parse(action.payload);
    expect(payload.resolvedTargetSeconds).toBeNull();
    expect(payload.operation).toBe("+");
    expect(payload.seconds).toBe(1800);
  });

  it("resolves the absolute target up front for a set (`=`)", () => {
    const action = queuedActionForOfflineAdjustment(adjustment({ operation: "=", seconds: 3600 }));
    const payload = timeTodayPayloadSchema.parse(action.payload);
    expect(payload.resolvedTargetSeconds).toBe(3600);
  });

  it("gives each request a unique coalesce key so distinct nudges never coalesce", () => {
    const a = queuedActionForOfflineAdjustment(adjustment());
    const b = queuedActionForOfflineAdjustment(adjustment());
    expect(a.coalesceKey).not.toBe(b.coalesceKey);
    expect(a.coalesceKey.startsWith("time-today:7:")).toBe(true);
  });
});
