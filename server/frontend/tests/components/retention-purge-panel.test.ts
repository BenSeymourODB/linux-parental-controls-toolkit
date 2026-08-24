/**
 * Flow test for the data-purge panel of `RetentionView` (#137).
 *
 * Renders the real component against a mocked `$lib/api/retention` and exercises
 * the purge-panel flows: the last-run summary on mount, the empty state, the
 * dry-run preview, the manual "run now" (which updates the summary and clears
 * the preview), and the inline error surface. The config-editor flows live in
 * `retention-view.test.ts`.
 */
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RetentionConfigResponse,
  RetentionPurgePreviewResponse,
  RetentionPurgeRunResponse,
  RetentionPurgeRunsResponse,
} from "../../src/lib/api/contract.js";

const fetchRetention = vi.fn<() => Promise<RetentionConfigResponse>>();
const fetchRetentionPurgeRuns = vi.fn<() => Promise<RetentionPurgeRunsResponse>>();
const previewRetentionPurge = vi.fn<() => Promise<RetentionPurgePreviewResponse>>();
const runRetentionPurge = vi.fn<() => Promise<RetentionPurgeRunResponse>>();

vi.mock("$lib/api/retention", () => ({
  fetchRetention: () => fetchRetention(),
  setRetentionOverride: vi.fn(),
  clearRetentionOverride: vi.fn(),
  fetchRetentionPurgeRuns: () => fetchRetentionPurgeRuns(),
  previewRetentionPurge: () => previewRetentionPurge(),
  runRetentionPurge: () => runRetentionPurge(),
}));

const { default: RetentionView } = await import("../../src/lib/views/RetentionView.svelte");

/** A minimal config so the table renders and the panel is reachable. */
const CONFIG: RetentionConfigResponse = {
  defaultDays: 365,
  categories: [
    { category: "usage_samples", source: "default", keepForever: false, days: 365, updatedAt: null },
  ],
};

function run(overrides: Partial<RetentionPurgeRunResponse> = {}): RetentionPurgeRunResponse {
  return {
    id: 1,
    at: "2026-06-20T03:00:00.000Z",
    trigger: "scheduled",
    totalDeleted: 3,
    durationMs: 12,
    items: [
      { category: "usage_samples", cutoff: "2025-06-20T03:00:00.000Z", deleted: 2 },
      { category: "grant_ledger", cutoff: null, deleted: 0 },
      { category: "audit_log", cutoff: "2025-06-20T03:00:00.000Z", deleted: 1 },
      { category: "date_overrides", cutoff: "2025-06-20T03:00:00.000Z", deleted: 0 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  fetchRetention.mockReset();
  fetchRetentionPurgeRuns.mockReset();
  previewRetentionPurge.mockReset();
  runRetentionPurge.mockReset();
  fetchRetention.mockResolvedValue(CONFIG);
  fetchRetentionPurgeRuns.mockResolvedValue({ runs: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RetentionView data-purge panel", () => {
  it("shows the last-run summary with its per-category breakdown on mount", async () => {
    fetchRetentionPurgeRuns.mockResolvedValue({ runs: [run()] });

    render(RetentionView);

    const card = await screen.findByTestId("last-run");
    expect(within(card).getByText("3 rows removed")).toBeInTheDocument();
    expect(within(card).getByText("scheduled")).toBeInTheDocument();
    // Breakdown lists each category label with its deleted count.
    expect(within(card).getByText("Usage samples")).toBeInTheDocument();
    expect(within(card).getByText("Audit log")).toBeInTheDocument();
    expect(fetchRetentionPurgeRuns).toHaveBeenCalledOnce();
  });

  it("shows the empty state when no purge has ever run", async () => {
    render(RetentionView);
    expect(await screen.findByText("No purge has run yet.")).toBeInTheDocument();
  });

  it("previews without recording a run, showing what would be removed", async () => {
    previewRetentionPurge.mockResolvedValue({
      at: "2026-06-20T04:00:00.000Z",
      totalWouldDelete: 5,
      items: [
        { category: "usage_samples", cutoff: "2025-06-20T04:00:00.000Z", wouldDelete: 5 },
        { category: "grant_ledger", cutoff: null, wouldDelete: 0 },
        { category: "audit_log", cutoff: "2025-06-20T04:00:00.000Z", wouldDelete: 0 },
        { category: "date_overrides", cutoff: "2025-06-20T04:00:00.000Z", wouldDelete: 0 },
      ],
    });

    render(RetentionView);
    await screen.findByText("No purge has run yet.");

    await fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    const card = await screen.findByTestId("preview");
    expect(within(card).getByText("5 rows would be removed")).toBeInTheDocument();
    expect(previewRetentionPurge).toHaveBeenCalledOnce();
    expect(runRetentionPurge).not.toHaveBeenCalled();
  });

  it("runs the purge now and refreshes the last-run summary", async () => {
    runRetentionPurge.mockResolvedValue(run({ id: 7, trigger: "manual", totalDeleted: 4 }));

    render(RetentionView);
    await screen.findByText("No purge has run yet.");

    await fireEvent.click(screen.getByRole("button", { name: "Run purge now" }));

    const card = await screen.findByTestId("last-run");
    expect(within(card).getByText("manual")).toBeInTheDocument();
    expect(within(card).getByText("4 rows removed")).toBeInTheDocument();
    expect(runRetentionPurge).toHaveBeenCalledOnce();
  });

  it("surfaces a purge error inline", async () => {
    runRetentionPurge.mockRejectedValue(new Error("boom"));

    render(RetentionView);
    await screen.findByText("No purge has run yet.");

    await fireEvent.click(screen.getByRole("button", { name: "Run purge now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
