/**
 * CRUD smoke test for `ActivitiesView` (#53 follow-through).
 *
 * `ActivitiesView` repeats the canonical `UsersView` editor pattern, with the
 * only twist being two enum `<select>`s (kind / match type) instead of free
 * text — so this covers list → create (incl. picking a non-default kind) →
 * inline edit → delete + the shared `role="alert"` surface. The logic-heavy
 * editors are covered by their own follow-up issue. Runs against a mocked
 * `$lib/api/activities` — no live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityResponse } from "../../src/lib/api/contract.js";

const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();
const createActivity = vi.fn<(input: unknown) => Promise<ActivityResponse>>();
const updateActivity = vi.fn<(id: number, input: unknown) => Promise<ActivityResponse>>();
const deleteActivity = vi.fn<(id: number) => Promise<void>>();

vi.mock("$lib/api/activities", () => ({
  listActivities: () => listActivities(),
  createActivity: (input: unknown) => createActivity(input),
  updateActivity: (id: number, input: unknown) => updateActivity(id, input),
  deleteActivity: (id: number) => deleteActivity(id),
}));

// ActivitiesView now composes `ActivityGroupsView` as a second section (UI
// consolidation). That child fetches activity groups on mount; stub its API to
// a quiet empty state so it doesn't reach for a live backend or render a second
// error alert that would clash with the assertions below.
vi.mock("$lib/api/activity-groups", () => ({
  listActivityGroups: () => Promise.resolve([]),
  createActivityGroup: vi.fn(),
  updateActivityGroup: vi.fn(),
  deleteActivityGroup: vi.fn(),
  listGroupActivities: vi.fn(),
  addActivityToGroup: vi.fn(),
  removeActivityFromGroup: vi.fn(),
}));

const { default: ActivitiesView } = await import("../../src/lib/views/ActivitiesView.svelte");

function activity(overrides: Partial<ActivityResponse> = {}): ActivityResponse {
  return {
    id: 1,
    kind: "app",
    matcher: "firefox",
    matchType: "exact",
    ...overrides,
  } as ActivityResponse;
}

beforeEach(() => {
  listActivities.mockReset();
  createActivity.mockReset();
  updateActivity.mockReset();
  deleteActivity.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActivitiesView CRUD", () => {
  it("renders the rows returned by the API with human-readable enum labels", async () => {
    listActivities.mockResolvedValue([
      activity({ id: 1, kind: "domain", matcher: "*.youtube.com", matchType: "glob" }),
    ]);

    render(ActivitiesView);

    expect(await screen.findByText("*.youtube.com")).toBeInTheDocument();
    // The enum values are mapped to display labels (kindLabel / matchTypeLabel).
    // Scope to the table — "Domain"/"Glob" also appear as <select> option text
    // in the create form.
    const table = screen.getByRole("table");
    expect(within(table).getByText("Domain")).toBeInTheDocument();
    expect(within(table).getByText("Glob")).toBeInTheDocument();
  });

  it("shows the empty state when there are no activities", async () => {
    listActivities.mockResolvedValue([]);

    render(ActivitiesView);

    expect(await screen.findByText("No activities yet. Add one above.")).toBeInTheDocument();
  });

  it("creates an activity with the picked kind/match-type and appends the row", async () => {
    listActivities.mockResolvedValue([]);
    createActivity.mockResolvedValue(
      activity({ id: 9, kind: "domain", matcher: "example.com", matchType: "substring" }),
    );

    render(ActivitiesView);
    await screen.findByText("No activities yet. Add one above.");

    await fireEvent.change(screen.getByLabelText("New activity kind"), {
      target: { value: "domain" },
    });
    await fireEvent.change(screen.getByLabelText("New activity match type"), {
      target: { value: "substring" },
    });
    await fireEvent.input(screen.getByLabelText("New activity matcher"), {
      target: { value: "example.com" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add activity" }));

    expect(await screen.findByText("example.com")).toBeInTheDocument();
    expect(createActivity).toHaveBeenCalledWith({
      kind: "domain",
      matcher: "example.com",
      matchType: "substring",
    });
  });

  it("saves an inline edit and replaces the row", async () => {
    listActivities.mockResolvedValue([activity({ id: 1, matcher: "firefox" })]);
    updateActivity.mockResolvedValue(activity({ id: 1, matcher: "chrome" }));

    render(ActivitiesView);
    await screen.findByText("firefox");

    await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await fireEvent.input(screen.getByLabelText("Edit matcher"), { target: { value: "chrome" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("chrome")).toBeInTheDocument();
    expect(updateActivity).toHaveBeenCalledWith(1, {
      kind: "app",
      matcher: "chrome",
      matchType: "exact",
    });
  });

  it("deletes an activity after confirmation and drops the row", async () => {
    listActivities.mockResolvedValue([activity({ id: 1, matcher: "firefox" })]);
    deleteActivity.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(ActivitiesView);
    await screen.findByText("firefox");

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("firefox")).not.toBeInTheDocument());
    expect(deleteActivity).toHaveBeenCalledWith(1);
  });

  it("surfaces an ApiError (e.g. a regex that does not compile) inline", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listActivities.mockResolvedValue([]);
    createActivity.mockRejectedValue(new ApiError(400, "bad_request", "Invalid regular expression."));

    render(ActivitiesView);
    await screen.findByText("No activities yet. Add one above.");

    await fireEvent.change(screen.getByLabelText("New activity match type"), {
      target: { value: "regex" },
    });
    await fireEvent.input(screen.getByLabelText("New activity matcher"), {
      target: { value: "[" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add activity" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid regular expression.");
  });
});
