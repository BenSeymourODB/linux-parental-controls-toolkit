import { describe, expect, it } from "vitest";

import type { TimelineSample } from "../../src/lib/api/contract.js";
import { consumedSeconds, idealRemaining, remainingSeries } from "../../src/lib/charts/burndown.js";
import { laneSegments } from "../../src/lib/charts/timeline.js";
import { formatDuration } from "../../src/lib/format/duration.js";

const WINDOW_START = "2026-06-20T00:00:00.000Z";
const WINDOW_END = "2026-06-21T00:00:00.000Z";

function sample(activityId: number, startedAt: string, endedAt: string): TimelineSample {
  return { activityId, startedAt, endedAt };
}

describe("formatDuration", () => {
  it("renders hours and minutes", () => {
    expect(formatDuration(5400)).toBe("1h 30m");
  });
  it("drops a zero hours component", () => {
    expect(formatDuration(1800)).toBe("30m");
  });
  it("drops a zero minutes component", () => {
    expect(formatDuration(7200)).toBe("2h");
  });
  it("carries a 60-minute rounding artefact into the hours", () => {
    expect(formatDuration(3599)).toBe("1h");
  });
  it("clamps a negative value to zero", () => {
    expect(formatDuration(-10)).toBe("0m");
  });
});

describe("burndown geometry", () => {
  it("sums the clamped overlap of every sample in the window", () => {
    const samples = [
      sample(1, "2026-06-20T01:00:00.000Z", "2026-06-20T01:30:00.000Z"), // 1800
      // Straddles the window end → only the in-window half counts.
      sample(2, "2026-06-20T23:30:00.000Z", "2026-06-21T00:30:00.000Z"), // 1800
      // Entirely outside → ignored.
      sample(3, "2026-06-22T00:00:00.000Z", "2026-06-22T01:00:00.000Z"),
    ];
    expect(consumedSeconds(samples, WINDOW_START, WINDOW_END)).toBe(3600);
  });

  it("steps the remaining series down by each sample's consumption", () => {
    const samples = [
      sample(1, "2026-06-20T02:00:00.000Z", "2026-06-20T02:30:00.000Z"), // 1800
      sample(1, "2026-06-20T01:00:00.000Z", "2026-06-20T01:10:00.000Z"), // 600
    ];
    const series = remainingSeries(7200, samples, WINDOW_START, WINDOW_END);
    // Sorted chronologically: start, then the 01:00 sample, then the 02:00 one.
    expect(series.map((p) => p.remaining)).toEqual([7200, 6600, 4800]);
  });

  it("floors remaining at zero for an over-budget day", () => {
    const samples = [sample(1, "2026-06-20T01:00:00.000Z", "2026-06-20T03:00:00.000Z")]; // 7200
    const series = remainingSeries(3600, samples, WINDOW_START, WINDOW_END);
    expect(series.at(-1)?.remaining).toBe(0);
  });

  it("computes ideal pace linearly, clamped to the window", () => {
    expect(idealRemaining(7200, WINDOW_START, WINDOW_END, WINDOW_START)).toBe(7200);
    expect(idealRemaining(7200, WINDOW_START, WINDOW_END, WINDOW_END)).toBe(0);
    expect(idealRemaining(7200, WINDOW_START, WINDOW_END, "2026-06-20T12:00:00.000Z")).toBe(3600);
    // Before / after the window clamp to the endpoints.
    expect(idealRemaining(7200, WINDOW_START, WINDOW_END, "2026-06-19T00:00:00.000Z")).toBe(7200);
  });
});

describe("timeline geometry", () => {
  it("projects each sample onto the window as a percentage segment", () => {
    const samples = [sample(1, "2026-06-20T06:00:00.000Z", "2026-06-20T12:00:00.000Z")];
    const [seg] = laneSegments(samples, WINDOW_START, WINDOW_END);
    expect(seg).toEqual({ activityId: 1, leftPct: 25, widthPct: 25 });
  });

  it("clamps a sample that straddles the window edges", () => {
    const samples = [sample(1, "2026-06-19T18:00:00.000Z", "2026-06-20T06:00:00.000Z")];
    const [seg] = laneSegments(samples, WINDOW_START, WINDOW_END);
    expect(seg).toEqual({ activityId: 1, leftPct: 0, widthPct: 25 });
  });

  it("drops samples with no in-window overlap", () => {
    const samples = [sample(1, "2026-06-22T00:00:00.000Z", "2026-06-22T01:00:00.000Z")];
    expect(laneSegments(samples, WINDOW_START, WINDOW_END)).toEqual([]);
  });

  it("returns no segments for a non-positive window", () => {
    const samples = [sample(1, WINDOW_START, WINDOW_END)];
    expect(laneSegments(samples, WINDOW_END, WINDOW_START)).toEqual([]);
  });
});
