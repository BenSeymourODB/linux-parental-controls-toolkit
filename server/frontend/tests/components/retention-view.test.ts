/**
 * Flow test for `RetentionView` (#214).
 *
 * Mirrors `integration-tokens-view-crud.test.ts`: renders the real component
 * against a mocked `$lib/api/retention` (no live backend) and exercises the
 * highest-value flows — list + override-vs-inherited marking, the read-only
 * global default, saving a custom override, saving keep-forever, clearing an
 * override, client-side day validation, and the inline error surface.
 */
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RetentionConfigResponse,
  RetentionEntryResponse,
  RetentionPurgeRunsResponse,
} from "../../src/lib/api/contract.js";

const fetchRetention = vi.fn<() => Promise<RetentionConfigResponse>>();
const setRetentionOverride =
  vi.fn<(category: string, body: unknown) => Promise<RetentionEntryResponse>>();
const clearRetentionOverride = vi.fn<(category: string) => Promise<RetentionEntryResponse>>();
const fetchRetentionPurgeRuns = vi.fn<() => Promise<RetentionPurgeRunsResponse>>();

vi.mock("$lib/api/retention", () => ({
  fetchRetention: () => fetchRetention(),
  setRetentionOverride: (category: string, body: unknown) => setRetentionOverride(category, body),
  clearRetentionOverride: (category: string) => clearRetentionOverride(category),
  // The purge panel loads the last run on mount; stub it so these config-flow
  // tests aren't coupled to it (its own flows live in retention-purge-panel.test.ts).
  fetchRetentionPurgeRuns: () => fetchRetentionPurgeRuns(),
  previewRetentionPurge: vi.fn(),
  runRetentionPurge: vi.fn(),
}));

const { default: RetentionView } = await import("../../src/lib/views/RetentionView.svelte");

function entry(overrides: Partial<RetentionEntryResponse> = {}): RetentionEntryResponse {
  return {
    category: "usage_samples",
    source: "default",
    keepForever: false,
    days: 365,
    updatedAt: null,
    ...overrides,
  } as RetentionEntryResponse;
}

function config(
  categories: RetentionEntryResponse[],
  defaultDays = 365,
): RetentionConfigResponse {
  return { defaultDays, categories };
}

beforeEach(() => {
  fetchRetention.mockReset();
  setRetentionOverride.mockReset();
  clearRetentionOverride.mockReset();
  fetchRetentionPurgeRuns.mockReset();
  fetchRetentionPurgeRuns.mockResolvedValue({ runs: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RetentionView", () => {
  it("renders each category with its window, marks override-vs-inherited, and shows the read-only default", async () => {
    fetchRetention.mockResolvedValue(
      config([
        entry({ category: "usage_samples", source: "default", days: 365 }),
        entry({
          category: "audit_log",
          source: "override",
          keepForever: false,
          days: 30,
          updatedAt: "2026-08-07T00:00:00.000Z",
        }),
      ]),
    );

    render(RetentionView);

    expect(await screen.findByText("Usage samples")).toBeInTheDocument();
    expect(screen.getByText("Audit log")).toBeInTheDocument();
    expect(fetchRetention).toHaveBeenCalledOnce();

    // The overridden row is badged as an override; the inherited row is not.
    expect(screen.getByText("override")).toBeInTheDocument();
    expect(screen.getByText("inherited default")).toBeInTheDocument();
    expect(screen.getByText("30 days")).toBeInTheDocument();

    // The global default is surfaced read-only with the env note.
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("365 days");
    expect(note).toHaveTextContent("PCT_RETENTION_DEFAULT_DAYS");

    // Clear is disabled for a row that only inherits the default.
    expect(
      screen.getByRole("button", { name: "Clear Usage samples override" }),
    ).toBeDisabled();
  });

  it("saves a custom-day override and reflects it in the row", async () => {
    fetchRetention.mockResolvedValue(
      config([entry({ category: "usage_samples", source: "default", days: 365 })]),
    );
    setRetentionOverride.mockResolvedValue(
      entry({
        category: "usage_samples",
        source: "override",
        keepForever: false,
        days: 30,
        updatedAt: "2026-08-07T00:00:00.000Z",
      }),
    );

    render(RetentionView);
    await screen.findByText("Usage samples");

    await fireEvent.input(screen.getByLabelText("Usage samples retention days"), {
      target: { value: "30" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save Usage samples retention" }));

    expect(setRetentionOverride).toHaveBeenCalledWith("usage_samples", {
      keepForever: false,
      days: 30,
    });
    expect(await screen.findByText("30 days")).toBeInTheDocument();
    expect(screen.getByText("override")).toBeInTheDocument();
    // The Clear action becomes available once the row is an override.
    expect(
      screen.getByRole("button", { name: "Clear Usage samples override" }),
    ).not.toBeDisabled();
  });

  it("saves a keep-forever override without a day count", async () => {
    fetchRetention.mockResolvedValue(
      config([entry({ category: "grant_ledger", source: "default", days: 365 })]),
    );
    setRetentionOverride.mockResolvedValue(
      entry({
        category: "grant_ledger",
        source: "override",
        keepForever: true,
        days: null,
        updatedAt: "2026-08-07T00:00:00.000Z",
      }),
    );

    render(RetentionView);
    await screen.findByText("Grant ledger");

    await fireEvent.change(screen.getByLabelText("Grant ledger retention mode"), {
      target: { value: "forever" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save Grant ledger retention" }));

    expect(setRetentionOverride).toHaveBeenCalledWith("grant_ledger", { keepForever: true });
    expect(await screen.findByText("Kept forever")).toBeInTheDocument();
  });

  it("clears an override, reverting the row to the inherited default", async () => {
    fetchRetention.mockResolvedValue(
      config([
        entry({
          category: "audit_log",
          source: "override",
          keepForever: false,
          days: 30,
          updatedAt: "2026-08-07T00:00:00.000Z",
        }),
      ]),
    );
    clearRetentionOverride.mockResolvedValue(
      entry({ category: "audit_log", source: "default", keepForever: false, days: 365 }),
    );

    render(RetentionView);
    await screen.findByText("Audit log");
    expect(screen.getByText("override")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Clear Audit log override" }));

    expect(clearRetentionOverride).toHaveBeenCalledWith("audit_log");
    expect(await screen.findByText("inherited default")).toBeInTheDocument();
    // "365 days" also appears in the global-default banner, so scope to the row's table.
    expect(within(screen.getByRole("table")).getByText("365 days")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Audit log override" })).toBeDisabled();
  });

  it("rejects a non-positive day count client-side without calling the API", async () => {
    fetchRetention.mockResolvedValue(
      config([entry({ category: "usage_samples", source: "default", days: 365 })]),
    );

    render(RetentionView);
    await screen.findByText("Usage samples");

    await fireEvent.input(screen.getByLabelText("Usage samples retention days"), {
      target: { value: "0" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save Usage samples retention" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/whole number of days/i);
    expect(setRetentionOverride).not.toHaveBeenCalled();
  });

  it("rejects a day count above the maximum client-side without calling the API", async () => {
    fetchRetention.mockResolvedValue(
      config([entry({ category: "usage_samples", source: "default", days: 365 })]),
    );

    render(RetentionView);
    await screen.findByText("Usage samples");

    await fireEvent.input(screen.getByLabelText("Usage samples retention days"), {
      target: { value: "40000" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save Usage samples retention" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/between 1 and/i);
    expect(setRetentionOverride).not.toHaveBeenCalled();
  });

  it("surfaces a save error inline without losing the row", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    fetchRetention.mockResolvedValue(
      config([entry({ category: "usage_samples", source: "default", days: 365 })]),
    );
    setRetentionOverride.mockRejectedValue(new ApiError(400, "invalid", "Days out of range."));

    render(RetentionView);
    await screen.findByText("Usage samples");

    await fireEvent.input(screen.getByLabelText("Usage samples retention days"), {
      target: { value: "30" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save Usage samples retention" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Days out of range.");
    // The row is unchanged — still inheriting the default, not flipped to override.
    expect(screen.getByText("inherited default")).toBeInTheDocument();
  });

  it("toggles a keep-forever override back to a custom window and saves it", async () => {
    fetchRetention.mockResolvedValue(
      config([
        entry({
          category: "grant_ledger",
          source: "override",
          keepForever: true,
          days: null,
          updatedAt: "2026-08-07T00:00:00.000Z",
        }),
      ]),
    );
    setRetentionOverride.mockResolvedValue(
      entry({
        category: "grant_ledger",
        source: "override",
        keepForever: false,
        days: 45,
        updatedAt: "2026-08-07T00:00:00.000Z",
      }),
    );

    render(RetentionView);
    await screen.findByText("Grant ledger");
    expect(screen.getByText("Kept forever")).toBeInTheDocument();

    // The day input is disabled while keep-forever is selected...
    const daysInput = screen.getByLabelText("Grant ledger retention days");
    expect(daysInput).toBeDisabled();

    // ...and re-enables when the mode toggles back to Custom.
    await fireEvent.change(screen.getByLabelText("Grant ledger retention mode"), {
      target: { value: "custom" },
    });
    expect(daysInput).not.toBeDisabled();

    await fireEvent.input(daysInput, { target: { value: "45" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save Grant ledger retention" }));

    expect(setRetentionOverride).toHaveBeenCalledWith("grant_ledger", {
      keepForever: false,
      days: 45,
    });
    expect(await screen.findByText("45 days")).toBeInTheDocument();
  });

  it("surfaces an ApiError from the load in the inline alert", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    fetchRetention.mockRejectedValue(new ApiError(500, "internal", "The server exploded."));

    render(RetentionView);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The server exploded.");
  });
});
