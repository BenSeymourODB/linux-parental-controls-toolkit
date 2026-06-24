/**
 * Smoke test for `ActivityGroupsView` — the master-detail membership logic that
 * sits on top of the CRUD skeleton (#266): membership is loaded **lazily** when
 * a group panel is expanded (`toggleMembers` → `listGroupActivities`), the
 * add-member dropdown `candidates` exclude activities already in the group,
 * adding/removing a member mutates the rendered list, and re-toggling collapses
 * the panel. The CRUD shape (create/rename/delete) is proven elsewhere; this
 * focuses on the membership layer. All `$lib/api/activity-groups` + `activities`
 * calls are mocked — no live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityGroupResponse, ActivityResponse } from "../../src/lib/api/contract.js";

const listActivityGroups = vi.fn<() => Promise<ActivityGroupResponse[]>>();
const createActivityGroup = vi.fn<(input: unknown) => Promise<ActivityGroupResponse>>();
const updateActivityGroup = vi.fn<(id: number, input: unknown) => Promise<ActivityGroupResponse>>();
const deleteActivityGroup = vi.fn<(id: number) => Promise<void>>();
const listGroupActivities = vi.fn<(groupId: number) => Promise<ActivityResponse[]>>();
const addActivityToGroup = vi.fn<(groupId: number, activityId: number) => Promise<void>>();
const removeActivityFromGroup = vi.fn<(groupId: number, activityId: number) => Promise<void>>();
const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();

vi.mock("$lib/api/activity-groups", () => ({
  listActivityGroups: () => listActivityGroups(),
  createActivityGroup: (input: unknown) => createActivityGroup(input),
  updateActivityGroup: (id: number, input: unknown) => updateActivityGroup(id, input),
  deleteActivityGroup: (id: number) => deleteActivityGroup(id),
  listGroupActivities: (groupId: number) => listGroupActivities(groupId),
  addActivityToGroup: (groupId: number, activityId: number) => addActivityToGroup(groupId, activityId),
  removeActivityFromGroup: (groupId: number, activityId: number) =>
    removeActivityFromGroup(groupId, activityId),
}));
vi.mock("$lib/api/activities", () => ({ listActivities: () => listActivities() }));

const { default: ActivityGroupsView } = await import(
  "../../src/lib/views/ActivityGroupsView.svelte"
);

function activity(overrides: Partial<ActivityResponse> = {}): ActivityResponse {
  return { id: 10, kind: "app", matcher: "steam", matchType: "exact", ...overrides };
}

const STEAM = activity({ id: 10, matcher: "steam" });
const DISCORD = activity({ id: 11, matcher: "discord" });

beforeEach(() => {
  listActivityGroups.mockReset().mockResolvedValue([{ id: 20, name: "Games" }]);
  createActivityGroup.mockReset();
  updateActivityGroup.mockReset();
  deleteActivityGroup.mockReset();
  listGroupActivities.mockReset().mockResolvedValue([]);
  addActivityToGroup.mockReset().mockResolvedValue(undefined);
  removeActivityFromGroup.mockReset().mockResolvedValue(undefined);
  listActivities.mockReset().mockResolvedValue([STEAM, DISCORD]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActivityGroupsView membership", () => {
  it("loads members lazily only when the panel is expanded", async () => {
    listGroupActivities.mockResolvedValue([STEAM]);

    render(ActivityGroupsView);
    await screen.findByText("Games");

    // Not fetched until the user opens the panel.
    expect(listGroupActivities).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Members" }));

    await waitFor(() => expect(listGroupActivities).toHaveBeenCalledWith(20));
    expect(await screen.findByText("steam")).toBeInTheDocument();
  });

  it("offers only non-member activities as add candidates", async () => {
    listGroupActivities.mockResolvedValue([STEAM]); // steam already a member

    render(ActivityGroupsView);
    await screen.findByText("Games");
    await fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText("steam");

    const picker = screen.getByLabelText("Activity to add");
    const optionLabels = within(picker)
      .getAllByRole("option")
      .map((o) => o.textContent?.trim());

    // discord is selectable; steam (already a member) is not in the candidate list.
    expect(optionLabels).toContain("discord (app)");
    expect(optionLabels).not.toContain("steam (app)");
  });

  it("adds a member and appends it to the rendered list", async () => {
    listGroupActivities.mockResolvedValue([]); // empty group

    render(ActivityGroupsView);
    await screen.findByText("Games");
    await fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText("No activities in this group yet.");

    await fireEvent.change(screen.getByLabelText("Activity to add"), { target: { value: "11" } });
    await fireEvent.click(screen.getByRole("button", { name: "Add to group" }));

    await waitFor(() => expect(addActivityToGroup).toHaveBeenCalledWith(20, 11));
    expect(await screen.findByText("discord")).toBeInTheDocument();
  });

  it("removes a member and drops it from the rendered list", async () => {
    listGroupActivities.mockResolvedValue([STEAM, DISCORD]);

    render(ActivityGroupsView);
    await screen.findByText("Games");
    await fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText("steam");

    // Two member rows, each with a Remove button — remove the first (steam).
    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    await fireEvent.click(removeButtons[0]);

    await waitFor(() => expect(removeActivityFromGroup).toHaveBeenCalledWith(20, 10));
    await waitFor(() => expect(screen.queryByText("steam")).not.toBeInTheDocument());
    expect(screen.getByText("discord")).toBeInTheDocument();
  });

  it("notes when every activity is already a member", async () => {
    listGroupActivities.mockResolvedValue([STEAM, DISCORD]); // both activities in the group

    render(ActivityGroupsView);
    await screen.findByText("Games");
    await fireEvent.click(screen.getByRole("button", { name: "Members" }));

    expect(
      await screen.findByText("All activities are already in this group."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Activity to add")).not.toBeInTheDocument();
  });

  it("collapses the panel when Members is toggled again", async () => {
    listGroupActivities.mockResolvedValue([STEAM]);

    render(ActivityGroupsView);
    await screen.findByText("Games");

    await fireEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(await screen.findByText("steam")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Hide members" }));
    await waitFor(() => expect(screen.queryByText("steam")).not.toBeInTheDocument());
  });

  it("surfaces a membership-load error inline", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listGroupActivities.mockRejectedValue(new ApiError(500, "internal", "Members load failed."));

    render(ActivityGroupsView);
    await screen.findByText("Games");
    await fireEvent.click(screen.getByRole("button", { name: "Members" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Members load failed.");
  });
});
