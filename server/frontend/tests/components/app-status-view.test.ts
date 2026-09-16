/**
 * Component test for the `/app` per-child status screen (#110).
 *
 * Renders `AppStatusView` against a mocked `$lib/api/app-status` (no live
 * backend) and asserts the accessible textual surface: overall time left / no
 * limit, the per-activity "My limits today" rows, the paused vs. bedtime
 * next-transition banner, and the load-error state.
 */
import { render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppStatusResponse } from "../../src/lib/api/contract.js";

const fetchAppStatus = vi.fn<() => Promise<AppStatusResponse>>();

vi.mock("$lib/api/app-status", () => ({
  fetchAppStatus: () => fetchAppStatus(),
}));

const { default: AppStatusView } = await import("../../src/lib/views/AppStatusView.svelte");

function status(overrides: Partial<AppStatusResponse> = {}): AppStatusResponse {
  return {
    user: { id: 1, displayName: "Alice" },
    tz: "UTC",
    now: "2026-08-23T13:00:00.000Z",
    date: "2026-08-23",
    overall: { allowedSeconds: 9000, consumedSeconds: 6900, remainingSeconds: 2100 },
    activities: [
      {
        scope: "activity",
        targetId: 10,
        label: "steam",
        activityKind: "app",
        allowedSeconds: 3600,
        consumedSeconds: 3420,
        remainingSeconds: 180,
      },
      {
        scope: "group",
        targetId: 20,
        label: "Fun",
        activityKind: null,
        allowedSeconds: 2700,
        consumedSeconds: 1080,
        remainingSeconds: 1620,
      },
    ],
    access: { allowedNow: true, nextTransition: null },
    ...overrides,
  };
}

beforeEach(() => {
  fetchAppStatus.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppStatusView", () => {
  it("renders the greeting, overall time left, and per-activity rows", async () => {
    fetchAppStatus.mockResolvedValue(status());
    render(AppStatusView);

    expect(await screen.findByText("Hi, Alice 👋")).toBeInTheDocument();
    expect(screen.getByText("35m left today")).toBeInTheDocument();
    expect(screen.getByText(/You've used 1h 55m of 2h 30m/)).toBeInTheDocument();
    // Per-activity limits: label + remaining/allowed.
    expect(screen.getByText("steam")).toBeInTheDocument();
    expect(screen.getByText("Fun")).toBeInTheDocument();
    expect(screen.getByText("3m")).toBeInTheDocument(); // steam remaining
    expect(screen.getByText("of 1h")).toBeInTheDocument(); // steam allowed
  });

  it("shows a no-limit state when there is no overall budget", async () => {
    fetchAppStatus.mockResolvedValue(
      status({
        overall: { allowedSeconds: null, consumedSeconds: 0, remainingSeconds: null },
        activities: [],
      }),
    );
    render(AppStatusView);

    expect(await screen.findByText("No time limit today")).toBeInTheDocument();
    // No "My limits today" list when there are no budgeted activities.
    expect(screen.queryByText("My limits today")).not.toBeInTheDocument();
  });

  it("surfaces a paused state with the resume time", async () => {
    fetchAppStatus.mockResolvedValue(
      status({
        access: {
          allowedNow: false,
          nextTransition: { kind: "access_resumes", localDate: "2026-08-24", atMinuteOfDay: 420 },
        },
      }),
    );
    render(AppStatusView);

    expect(await screen.findByText("Screen time is paused right now")).toBeInTheDocument();
    expect(screen.getByText(/comes back tomorrow at 7:00/)).toBeInTheDocument();
  });

  it("surfaces the next bedtime while access is open", async () => {
    fetchAppStatus.mockResolvedValue(
      status({
        access: {
          allowedNow: true,
          nextTransition: { kind: "access_ends", localDate: "2026-08-23", atMinuteOfDay: 1260 },
        },
      }),
    );
    render(AppStatusView);

    expect(await screen.findByText("Screen time until 21:00")).toBeInTheDocument();
  });

  it("shows a friendly error when the status fails to load", async () => {
    fetchAppStatus.mockRejectedValue(new Error("boom"));
    render(AppStatusView);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});
