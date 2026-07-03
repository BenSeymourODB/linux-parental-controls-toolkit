/**
 * Component test for the fleet-wide queue-summary widget (#322) on the admin
 * Dashboard. Drives the real component against a mocked `$lib/api/system`
 * (no live backend), following the established `tests/components/*` pattern.
 *
 * Covers the behaviour the component owns: the calm all-clear state, the
 * pending/failed counts, the prominent (never-suppressed) failed count, the
 * oldest-pending age line, the "View clients" navigation, and a fetch-failure
 * surfaced inline.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueueSummaryResponse } from "../../src/lib/api/contract.js";

const fetchQueueSummary = vi.fn<() => Promise<QueueSummaryResponse>>();

vi.mock("$lib/api/system", () => ({ fetchQueueSummary: () => fetchQueueSummary() }));

const { default: QueueSummaryWidget } = await import(
  "../../src/lib/components/QueueSummaryWidget.svelte"
);

const onnavigate = vi.fn<(id: string) => void>();

beforeEach(() => {
  fetchQueueSummary.mockReset();
  onnavigate.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QueueSummaryWidget (#322)", () => {
  it("shows a calm all-clear state when nothing is pending or failed", async () => {
    fetchQueueSummary.mockResolvedValue({ pending: 0, failed: 0, oldestPendingAt: null });

    render(QueueSummaryWidget, { onnavigate });

    expect(await screen.findByText(/all policy pushes delivered/i)).toBeInTheDocument();
  });

  it("renders pending and failed counts and the oldest-waiting age when there is a backlog", async () => {
    const oldestPendingAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    fetchQueueSummary.mockResolvedValue({ pending: 4, failed: 0, oldestPendingAt });

    render(QueueSummaryWidget, { onnavigate });

    const pending = await screen.findByText("4");
    expect(pending).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    // Oldest-waiting age is shown while there is pending work.
    expect(screen.getByText("oldest waiting")).toBeInTheDocument();
    expect(screen.getByText(/^3h/)).toBeInTheDocument();
  });

  it("surfaces a dead-lettered count prominently and always", async () => {
    fetchQueueSummary.mockResolvedValue({ pending: 0, failed: 2, oldestPendingAt: null });

    render(QueueSummaryWidget, { onnavigate });

    // The failed count is visible (not suppressed) even with zero pending, and
    // an alert calls out that dead-lettered actions need attention.
    const failedLabel = await screen.findByText("failed");
    expect(failedLabel).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/2 dead-lettered actions need attention/i)).toBeInTheDocument();
    // No all-clear when something is stuck.
    expect(screen.queryByText(/all policy pushes delivered/i)).not.toBeInTheDocument();
  });

  it("omits the oldest-waiting age when nothing is pending", async () => {
    fetchQueueSummary.mockResolvedValue({ pending: 0, failed: 1, oldestPendingAt: null });

    render(QueueSummaryWidget, { onnavigate });

    await screen.findByText("failed");
    expect(screen.queryByText("oldest waiting")).not.toBeInTheDocument();
  });

  it("navigates to the Clients view via the View clients link", async () => {
    fetchQueueSummary.mockResolvedValue({ pending: 0, failed: 0, oldestPendingAt: null });

    render(QueueSummaryWidget, { onnavigate });

    await screen.findByText(/all policy pushes delivered/i);
    await fireEvent.click(screen.getByRole("button", { name: /view clients/i }));

    expect(onnavigate).toHaveBeenCalledWith("clients");
  });

  it("surfaces a fetch failure inline", async () => {
    fetchQueueSummary.mockRejectedValue(new Error("boom"));

    render(QueueSummaryWidget, { onnavigate });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load queue status: boom/i),
    );
  });
});
