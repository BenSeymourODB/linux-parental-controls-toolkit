/**
 * Smoke test for `ExceptionsView` — the logic beyond the CRUD skeleton (#266):
 * the `datetime-local` ↔ ISO conversion (a blank field → null `effectiveFrom`,
 * a populated one → a trailing-`Z` instant), the `datesInvalid`
 * expiry-after-start guard that both warns and gates the create button, the
 * conditional scope→target picker, and the inline edit of action/reason/expiry.
 * All four `$lib/api/*` wrappers loaded on mount are mocked — no live backend.
 *
 * `datetime-local` strings are interpreted in the browser's local zone, so the
 * assertions compare against `new Date(local).toISOString()` rather than a
 * hard-coded `Z` instant, keeping the suite independent of the runner's TZ.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityGroupResponse,
  ActivityResponse,
  ExceptionResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

const listExceptions = vi.fn<() => Promise<ExceptionResponse[]>>();
const createException = vi.fn<(input: unknown) => Promise<ExceptionResponse>>();
const updateException = vi.fn<(id: number, input: unknown) => Promise<ExceptionResponse>>();
const deleteException = vi.fn<(id: number) => Promise<void>>();
const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();
const listActivityGroups = vi.fn<() => Promise<ActivityGroupResponse[]>>();

vi.mock("$lib/api/exceptions", () => ({
  listExceptions: () => listExceptions(),
  createException: (input: unknown) => createException(input),
  updateException: (id: number, input: unknown) => updateException(id, input),
  deleteException: (id: number) => deleteException(id),
}));
vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));
vi.mock("$lib/api/activities", () => ({ listActivities: () => listActivities() }));
vi.mock("$lib/api/activity-groups", () => ({ listActivityGroups: () => listActivityGroups() }));

const { default: ExceptionsView } = await import("../../src/lib/views/ExceptionsView.svelte");

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 1,
    displayName: "Alice",
    tz: "Europe/London",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserResponse;
}

function exception(overrides: Partial<ExceptionResponse> = {}): ExceptionResponse {
  return {
    id: 100,
    userId: 1,
    targetKind: "overall",
    targetId: null,
    action: "allow",
    reason: null,
    effectiveFrom: null,
    expiresAt: "2026-07-01T12:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  listExceptions.mockReset().mockResolvedValue([]);
  createException.mockReset();
  updateException.mockReset();
  deleteException.mockReset();
  listUsers.mockReset().mockResolvedValue([user()]);
  listActivities.mockReset().mockResolvedValue([{ id: 10, kind: "app", matcher: "steam", matchType: "exact" }]);
  listActivityGroups.mockReset().mockResolvedValue([{ id: 20, name: "Games" }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ExceptionsView", () => {
  it("warns and blocks create when expiry is not after the start", async () => {
    render(ExceptionsView);
    await screen.findByText("No exceptions yet. Add one above.");

    await fireEvent.change(screen.getByLabelText("Exception user"), { target: { value: "1" } });
    await fireEvent.input(screen.getByLabelText("Effective from"), {
      target: { value: "2026-07-01T12:00" },
    });
    await fireEvent.input(screen.getByLabelText("Expires at"), {
      target: { value: "2026-07-01T10:00" }, // before the start
    });

    expect(await screen.findByText("Expiry must be after the start time.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add exception" })).toBeDisabled();
  });

  it("creates an overall exception, converting the local datetimes to ISO instants", async () => {
    createException.mockResolvedValue(exception({ id: 7 }));

    render(ExceptionsView);
    await screen.findByText("No exceptions yet. Add one above.");

    await fireEvent.change(screen.getByLabelText("Exception user"), { target: { value: "1" } });
    await fireEvent.change(screen.getByLabelText("Exception action"), { target: { value: "deny" } });
    await fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "  homework  " } });
    await fireEvent.input(screen.getByLabelText("Effective from"), {
      target: { value: "2026-07-01T09:00" },
    });
    await fireEvent.input(screen.getByLabelText("Expires at"), {
      target: { value: "2026-07-01T18:00" },
    });

    const submit = screen.getByRole("button", { name: "Add exception" });
    expect(submit).toBeEnabled();
    await fireEvent.click(submit);

    expect(createException).toHaveBeenCalledWith({
      userId: 1,
      targetKind: "overall",
      targetId: null,
      action: "deny",
      reason: "homework", // trimmed
      effectiveFrom: new Date("2026-07-01T09:00").toISOString(),
      expiresAt: new Date("2026-07-01T18:00").toISOString(),
    });
  });

  it("treats a blank start as a null effectiveFrom", async () => {
    createException.mockResolvedValue(exception({ id: 8 }));

    render(ExceptionsView);
    await screen.findByText("No exceptions yet. Add one above.");

    await fireEvent.change(screen.getByLabelText("Exception user"), { target: { value: "1" } });
    await fireEvent.input(screen.getByLabelText("Expires at"), {
      target: { value: "2026-07-01T18:00" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add exception" }));

    expect(createException).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveFrom: null,
        reason: null, // blank reason → null
        expiresAt: new Date("2026-07-01T18:00").toISOString(),
      }),
    );
  });

  it("swaps in the group picker for the group scope and requires a target", async () => {
    render(ExceptionsView);
    await screen.findByText("No exceptions yet. Add one above.");

    await fireEvent.change(screen.getByLabelText("Exception user"), { target: { value: "1" } });
    await fireEvent.input(screen.getByLabelText("Expires at"), {
      target: { value: "2026-07-01T18:00" },
    });
    await fireEvent.change(screen.getByLabelText("Exception scope"), { target: { value: "group" } });

    expect(screen.getByLabelText("Target group")).toBeInTheDocument();
    // No target chosen yet → still blocked.
    expect(screen.getByRole("button", { name: "Add exception" })).toBeDisabled();

    await fireEvent.change(screen.getByLabelText("Target group"), { target: { value: "20" } });
    expect(screen.getByRole("button", { name: "Add exception" })).toBeEnabled();
  });

  it("prefills the edit expiry from the stored instant and sends a fresh ISO on save", async () => {
    listExceptions.mockResolvedValue([
      exception({ id: 100, action: "allow", reason: "old", expiresAt: "2026-07-01T12:00:00.000Z" }),
    ]);
    updateException.mockResolvedValue(exception({ id: 100, action: "extend", reason: "new" }));

    render(ExceptionsView);
    await screen.findByRole("table");

    await fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    // The edit datetime-local is prefilled from the stored instant (local zone).
    const editExpiry = screen.getByLabelText("Edit expiry");
    expect(editExpiry).toHaveValue();

    await fireEvent.change(screen.getByLabelText("Edit action"), { target: { value: "extend" } });
    await fireEvent.input(screen.getByLabelText("Edit reason"), { target: { value: "new" } });
    await fireEvent.input(editExpiry, { target: { value: "2026-08-01T08:00" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateException).toHaveBeenCalledWith(100, {
      action: "extend",
      reason: "new",
      expiresAt: new Date("2026-08-01T08:00").toISOString(),
    });
  });

  it("deletes an exception after confirmation", async () => {
    listExceptions.mockResolvedValue([exception({ id: 100 })]);
    deleteException.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(ExceptionsView);
    await screen.findByRole("table");

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteException).toHaveBeenCalledWith(100));
    expect(screen.getByText("No exceptions yet. Add one above.")).toBeInTheDocument();
  });
});
