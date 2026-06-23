/**
 * Smoke test for `AuditLogView` — a read-only view whose logic is the cursor
 * pagination and the filter parsing (#266): "load older" appends the next page
 * and advances the cursor, `hasMore` derives from a non-null `nextCursor`, the
 * client-id text filter is parsed to a positive integer (blank/invalid → omit),
 * and the outcome filter passes through. The single `$lib/api/audit` wrapper is
 * mocked — no live backend, no write path.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditEntryResponse, AuditListResponse } from "../../src/lib/api/contract.js";

const listAudit = vi.fn<(params?: unknown) => Promise<AuditListResponse>>();

vi.mock("$lib/api/audit", () => ({
  listAudit: (params?: unknown) => listAudit(params),
}));

const { default: AuditLogView } = await import("../../src/lib/views/AuditLogView.svelte");

function entry(overrides: Partial<AuditEntryResponse> = {}): AuditEntryResponse {
  return {
    id: 1,
    at: "2026-06-20T10:00:00.000Z",
    targetHost: "mint-box",
    targetPort: 22,
    targetUser: "alice",
    clientId: 5,
    userId: 1,
    actor: "admin",
    reason: null,
    command: ["timekpra", "--settimeleft", "alice", "+", "3600"],
    outcome: "ok",
    exitCode: 0,
    signal: null,
    durationMs: 42,
    errorMessage: null,
    ...overrides,
  };
}

function page(overrides: Partial<AuditListResponse> = {}): AuditListResponse {
  return { entries: [entry()], nextCursor: null, ...overrides };
}

beforeEach(() => {
  listAudit.mockReset().mockResolvedValue(page());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuditLogView", () => {
  it("renders the first page newest-first and joins the redacted command", async () => {
    listAudit.mockResolvedValue(page({ entries: [entry({ id: 1 })], nextCursor: null }));

    render(AuditLogView);

    expect(
      await screen.findByText("timekpra --settimeleft alice + 3600"),
    ).toBeInTheDocument();
    // No cursor → no "load older" control.
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
  });

  it("appends the next page and advances the cursor on 'load older'", async () => {
    listAudit
      .mockResolvedValueOnce(page({ entries: [entry({ id: 2, actor: "first-page" })], nextCursor: 2 }))
      .mockResolvedValueOnce(page({ entries: [entry({ id: 1, actor: "older-page" })], nextCursor: null }));

    render(AuditLogView);
    await screen.findByText("first-page");

    const loadOlder = screen.getByRole("button", { name: "Load older" });
    await fireEvent.click(loadOlder);

    // Older page appended below the first, both visible.
    expect(await screen.findByText("older-page")).toBeInTheDocument();
    expect(screen.getByText("first-page")).toBeInTheDocument();

    // The second call carried the cursor from the first page.
    expect(listAudit).toHaveBeenNthCalledWith(2, { before: 2 });
    // Cursor now null → control gone.
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
  });

  it("parses a valid client-id filter and reloads from the newest page", async () => {
    render(AuditLogView);
    await screen.findByRole("table");

    await fireEvent.input(screen.getByLabelText("Filter by client id"), { target: { value: "5" } });
    await fireEvent.change(screen.getByLabelText("Filter by outcome"), {
      target: { value: "failed" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith({ clientId: 5, outcome: "failed" }),
    );
  });

  it("omits a blank client-id filter from the query", async () => {
    render(AuditLogView);
    await screen.findByRole("table");

    // Set then clear the field — a blank filter must not send clientId.
    const field = screen.getByLabelText("Filter by client id");
    await fireEvent.input(field, { target: { value: "" } });
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(listAudit).toHaveBeenLastCalledWith({}));
  });

  it("shows the empty state when no entries match", async () => {
    listAudit.mockResolvedValue(page({ entries: [], nextCursor: null }));

    render(AuditLogView);

    expect(
      await screen.findByText("No audit entries match these filters."),
    ).toBeInTheDocument();
  });

  it("surfaces a load error inline", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listAudit.mockRejectedValue(new ApiError(500, "internal", "Audit load failed."));

    render(AuditLogView);

    expect(await screen.findByRole("alert")).toHaveTextContent("Audit load failed.");
  });
});
