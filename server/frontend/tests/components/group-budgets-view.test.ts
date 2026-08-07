/**
 * Component smoke test for `GroupBudgetsView` (#363) — the group counterpart of
 * `budgets-view.test.ts`. Focuses on what the group view adds over the user
 * view: the group picker gates the editor and drives `listGroupBudgets`; create
 * omits the owner (the group is the selected one) and POSTs via
 * `createGroupBudget(groupId, …)`; the rest (minutes↔seconds, `Xh Ym`
 * formatting, scope→target picker, inline window+allowance edit, delete) mirrors
 * BudgetsView. All `/api` wrappers are mocked — no live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityGroupResponse,
  ActivityResponse,
  GroupBudgetResponse,
  UserGroupResponse,
} from "../../src/lib/api/contract.js";

const listGroupBudgets = vi.fn<(groupId: number) => Promise<GroupBudgetResponse[]>>();
const createGroupBudget = vi.fn<(groupId: number, input: unknown) => Promise<GroupBudgetResponse>>();
const updateGroupBudget = vi.fn<(id: number, input: unknown) => Promise<GroupBudgetResponse>>();
const deleteGroupBudget = vi.fn<(id: number) => Promise<void>>();
const listUserGroups = vi.fn<() => Promise<UserGroupResponse[]>>();
const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();
const listActivityGroups = vi.fn<() => Promise<ActivityGroupResponse[]>>();

vi.mock("$lib/api/group-budgets", () => ({
  listGroupBudgets: (groupId: number) => listGroupBudgets(groupId),
  createGroupBudget: (groupId: number, input: unknown) => createGroupBudget(groupId, input),
  updateGroupBudget: (id: number, input: unknown) => updateGroupBudget(id, input),
  deleteGroupBudget: (id: number) => deleteGroupBudget(id),
}));
vi.mock("$lib/api/user-groups", () => ({ listUserGroups: () => listUserGroups() }));
vi.mock("$lib/api/activities", () => ({ listActivities: () => listActivities() }));
vi.mock("$lib/api/activity-groups", () => ({ listActivityGroups: () => listActivityGroups() }));

const { default: GroupBudgetsView } = await import("../../src/lib/views/GroupBudgetsView.svelte");

function activity(overrides: Partial<ActivityResponse> = {}): ActivityResponse {
  return { id: 10, kind: "app", matcher: "steam", matchType: "exact", ...overrides };
}

function activityGroup(overrides: Partial<ActivityGroupResponse> = {}): ActivityGroupResponse {
  return { id: 20, name: "Games", ...overrides };
}

function budget(overrides: Partial<GroupBudgetResponse> = {}): GroupBudgetResponse {
  return {
    id: 100,
    userGroupId: 1,
    scope: "overall",
    targetId: null,
    window: "daily",
    secondsAllowed: 3600,
    recurrenceDays: null,
    ...overrides,
  };
}

/** Select the group named `name` by index (robust against Svelte's value binding). */
async function selectGroup(name: string): Promise<void> {
  const select = (await screen.findByLabelText("Manage budgets for group")) as HTMLSelectElement;
  const index = Array.from(select.options).findIndex((o) => o.textContent?.trim() === name);
  expect(index).toBeGreaterThanOrEqual(0);
  select.selectedIndex = index;
  await fireEvent.change(select);
}

beforeEach(() => {
  listGroupBudgets.mockReset().mockResolvedValue([]);
  createGroupBudget.mockReset();
  updateGroupBudget.mockReset();
  deleteGroupBudget.mockReset();
  listUserGroups
    .mockReset()
    .mockResolvedValue([
      { id: 1, name: "Kids", createdAt: "2026-01-01T00:00:00.000Z" },
    ] as UserGroupResponse[]);
  listActivities.mockReset().mockResolvedValue([activity()]);
  listActivityGroups.mockReset().mockResolvedValue([activityGroup()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GroupBudgetsView", () => {
  it("prompts to add a user group first when none exist", async () => {
    listUserGroups.mockResolvedValue([]);

    render(GroupBudgetsView);

    expect(
      await screen.findByText(
        "Add a user group first — a group budget always belongs to a group.",
      ),
    ).toBeInTheDocument();
  });

  it("gates the editor behind the group picker, then loads that group's budgets", async () => {
    render(GroupBudgetsView);

    // Before a group is picked, the create form is not shown.
    expect(await screen.findByText("Choose a group to view and manage its budgets.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add budget" })).not.toBeInTheDocument();

    listGroupBudgets.mockResolvedValue([budget({ id: 1, secondsAllowed: 5400 })]);
    await selectGroup("Kids");

    expect(listGroupBudgets).toHaveBeenCalledWith(1);
    expect(await screen.findByText("1h 30m")).toBeInTheDocument();
  });

  it("creates a budget on the selected group without an owner field", async () => {
    render(GroupBudgetsView);
    await selectGroup("Kids");
    await screen.findByText("No budgets yet. Add one above.");

    createGroupBudget.mockResolvedValue(budget({ id: 7, secondsAllowed: 1800, window: "weekly" }));

    const submit = screen.getByRole("button", { name: "Add budget" });
    expect(submit).toBeDisabled(); // no minutes yet

    await fireEvent.change(screen.getByLabelText("Budget window"), { target: { value: "weekly" } });
    await fireEvent.input(screen.getByLabelText("Allowance in minutes"), {
      target: { value: "30" },
    });
    expect(submit).toBeEnabled();
    await fireEvent.click(submit);

    // The group id comes from the picker; the body has no userId.
    expect(createGroupBudget).toHaveBeenCalledWith(1, {
      scope: "overall",
      targetId: null,
      window: "weekly",
      secondsAllowed: 1800,
    });
  });

  it("requires a target before an activity-scoped budget can be created", async () => {
    render(GroupBudgetsView);
    await selectGroup("Kids");
    await screen.findByText("No budgets yet. Add one above.");

    await fireEvent.input(screen.getByLabelText("Allowance in minutes"), {
      target: { value: "60" },
    });
    await fireEvent.change(screen.getByLabelText("Budget scope"), { target: { value: "activity" } });
    expect(screen.getByRole("button", { name: "Add budget" })).toBeDisabled();

    await fireEvent.change(screen.getByLabelText("Target activity"), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: "Add budget" })).toBeEnabled();
  });

  it("edits the window + allowance inline and sends the converted seconds", async () => {
    listGroupBudgets.mockResolvedValue([budget({ id: 100, secondsAllowed: 3600, window: "daily" })]);
    updateGroupBudget.mockResolvedValue(budget({ id: 100, secondsAllowed: 2700, window: "weekly" }));

    render(GroupBudgetsView);
    await selectGroup("Kids");
    await screen.findByText("1h");

    await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const minutes = screen.getByLabelText("Edit allowance in minutes");
    expect(minutes).toHaveValue("60");

    await fireEvent.change(screen.getByLabelText("Edit window"), { target: { value: "weekly" } });
    await fireEvent.input(minutes, { target: { value: "45" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateGroupBudget).toHaveBeenCalledWith(100, { window: "weekly", secondsAllowed: 2700 });
    expect(await screen.findByText("45m")).toBeInTheDocument();
  });

  it("deletes a budget after confirmation", async () => {
    listGroupBudgets.mockResolvedValue([budget({ id: 100 })]);
    deleteGroupBudget.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(GroupBudgetsView);
    await selectGroup("Kids");
    await screen.findByText("1h");

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteGroupBudget).toHaveBeenCalledWith(100));
    expect(screen.getByText("No budgets yet. Add one above.")).toBeInTheDocument();
  });

  it("resolves an activity target to its matcher in the table", async () => {
    listGroupBudgets.mockResolvedValue([budget({ scope: "activity", targetId: 10 })]);

    render(GroupBudgetsView);
    await selectGroup("Kids");

    const table = await screen.findByRole("table");
    expect(within(table).getByText("steam")).toBeInTheDocument();
    expect(within(table).getByText("Activity")).toBeInTheDocument();
  });

  it("surfaces a load error in the inline alert", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listGroupBudgets.mockRejectedValue(new ApiError(500, "internal", "Group budget load failed."));

    render(GroupBudgetsView);
    await selectGroup("Kids");

    expect(await screen.findByRole("alert")).toHaveTextContent("Group budget load failed.");
  });
});
