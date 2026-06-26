/**
 * Component smoke test for the overall-budget burndown chart (#62).
 *
 * Renders `BudgetBurndown` against a mocked `$lib/api/usage` (no live backend)
 * and drives the logic the typed API-wrapper tests can't reach: the load →
 * summary render, the Today/Week/Month toggle re-fetching the right window, the
 * no-overall-budget empty state, and the inline error surface.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BurndownResponse, TimelineResponse } from "../../src/lib/api/contract.js";

const getBurndown = vi.fn<(userId: number, window?: string) => Promise<BurndownResponse>>();
const getTimeline = vi.fn<() => Promise<TimelineResponse>>();

vi.mock("$lib/api/usage", () => ({
  getBurndown: (userId: number, window?: string) => getBurndown(userId, window),
  getTimeline: () => getTimeline(),
}));

const { default: BudgetBurndown } = await import(
  "../../src/lib/components/charts/BudgetBurndown.svelte"
);

function burndown(overrides: Partial<BurndownResponse> = {}): BurndownResponse {
  return {
    userId: 1,
    window: "daily",
    tz: "UTC",
    windowStart: "2026-06-20T00:00:00.000Z",
    windowEnd: "2026-06-21T00:00:00.000Z",
    now: "2026-06-20T12:00:00.000Z",
    budgets: [{ scope: "overall", targetId: null, allowedSeconds: 7200, consumedSeconds: 1800 }],
    ...overrides,
  };
}

function timeline(): TimelineResponse {
  return {
    userId: 1,
    tz: "UTC",
    from: "2026-06-20T00:00:00.000Z",
    to: "2026-06-21T00:00:00.000Z",
    activities: [{ id: 1, kind: "app", matcher: "steam" }],
    samples: [
      { activityId: 1, startedAt: "2026-06-20T01:00:00.000Z", endedAt: "2026-06-20T01:30:00.000Z" },
    ],
  };
}

beforeEach(() => {
  getBurndown.mockReset();
  getTimeline.mockReset();
  getTimeline.mockResolvedValue(timeline());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BudgetBurndown", () => {
  it("renders the overall consumed/remaining summary", async () => {
    getBurndown.mockResolvedValue(burndown());

    render(BudgetBurndown, { userId: 1 });

    expect(await screen.findByText(/30m of 2h used/)).toBeInTheDocument();
    expect(screen.getByText(/1h 30m remaining/)).toBeInTheDocument();
    expect(getBurndown).toHaveBeenCalledWith(1, "daily");
  });

  it("re-fetches the weekly window when the Week toggle is clicked", async () => {
    getBurndown.mockResolvedValue(burndown());

    render(BudgetBurndown, { userId: 1 });
    await screen.findByText(/30m of 2h used/);

    getBurndown.mockResolvedValue(burndown({ window: "weekly" }));
    await fireEvent.click(screen.getByRole("button", { name: "Week" }));

    await waitFor(() => expect(getBurndown).toHaveBeenLastCalledWith(1, "weekly"));
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the empty state when there is no overall budget", async () => {
    getBurndown.mockResolvedValue(burndown({ budgets: [] }));

    render(BudgetBurndown, { userId: 1 });

    expect(await screen.findByText("No overall budget set for this window.")).toBeInTheDocument();
    expect(screen.getByText("No budgets defined for this window.")).toBeInTheDocument();
  });

  it("surfaces an API error inline", async () => {
    getBurndown.mockRejectedValue(new Error("boom"));

    render(BudgetBurndown, { userId: 1 });

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
