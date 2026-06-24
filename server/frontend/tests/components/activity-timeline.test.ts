/**
 * Component smoke test for the per-activity timeline (#62).
 *
 * Renders `ActivityTimeline` against a mocked `$lib/api/usage` (no live backend)
 * and asserts the lane labels render per activity, the empty state, and the
 * inline error surface.
 */
import { render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TimelineResponse } from "../../src/lib/api/contract.js";

const getTimeline = vi.fn<() => Promise<TimelineResponse>>();

vi.mock("$lib/api/usage", () => ({
  getTimeline: () => getTimeline(),
}));

const { default: ActivityTimeline } = await import(
  "../../src/lib/components/charts/ActivityTimeline.svelte"
);

function timeline(overrides: Partial<TimelineResponse> = {}): TimelineResponse {
  return {
    userId: 1,
    tz: "UTC",
    from: "2026-06-20T00:00:00.000Z",
    to: "2026-06-21T00:00:00.000Z",
    activities: [
      { id: 1, kind: "app", matcher: "steam" },
      { id: 2, kind: "app", matcher: "discord" },
    ],
    samples: [
      { activityId: 1, startedAt: "2026-06-20T06:00:00.000Z", endedAt: "2026-06-20T12:00:00.000Z" },
      { activityId: 2, startedAt: "2026-06-20T13:00:00.000Z", endedAt: "2026-06-20T13:30:00.000Z" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  getTimeline.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActivityTimeline", () => {
  it("renders one labelled lane per activity", async () => {
    getTimeline.mockResolvedValue(timeline());

    render(ActivityTimeline, { userId: 1 });

    expect(await screen.findByText("steam")).toBeInTheDocument();
    expect(screen.getByText("discord")).toBeInTheDocument();
    expect(getTimeline).toHaveBeenCalledOnce();
  });

  it("shows the empty state when nothing was recorded", async () => {
    getTimeline.mockResolvedValue(timeline({ activities: [], samples: [] }));

    render(ActivityTimeline, { userId: 1 });

    expect(await screen.findByText("No activity recorded for this period.")).toBeInTheDocument();
  });

  it("surfaces an API error inline", async () => {
    getTimeline.mockRejectedValue(new Error("nope"));

    render(ActivityTimeline, { userId: 1 });

    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
  });
});
