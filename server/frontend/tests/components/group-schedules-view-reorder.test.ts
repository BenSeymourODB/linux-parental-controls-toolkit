/**
 * Component smoke test for the group-schedule drag-to-order editor (#270) — the
 * group counterpart of `schedules-view-reorder.test.ts`.
 *
 * Focuses on what `GroupSchedulesView` adds: selecting a group loads its ordered
 * rules with the server-derived "never applies" shadow warning, reordering (the
 * keyboard Move buttons and a drag-drop) persists the new id order and
 * re-renders from the server's fresh view, and — unlike the user view — there is
 * **no "in effect now" badge** (a group has no single timezone). The `/api`
 * wrappers are mocked — no live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityResponse,
  GroupScheduleOrderView,
  GroupScheduleResponse,
  UserGroupResponse,
} from "../../src/lib/api/contract.js";

const listUserGroups = vi.fn<() => Promise<UserGroupResponse[]>>();
const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();
const listActivityGroups = vi.fn<() => Promise<unknown[]>>();
const getGroupScheduleOrder = vi.fn<(groupId: number) => Promise<GroupScheduleOrderView>>();
const reorderGroupSchedules =
  vi.fn<(groupId: number, ids: number[]) => Promise<GroupScheduleOrderView>>();
const createGroupSchedule = vi.fn<(groupId: number, input: unknown) => Promise<GroupScheduleResponse>>();
const updateGroupSchedule = vi.fn<(id: number, input: unknown) => Promise<GroupScheduleResponse>>();
const deleteGroupSchedule = vi.fn<(id: number) => Promise<void>>();

vi.mock("$lib/api/user-groups", () => ({ listUserGroups: () => listUserGroups() }));
vi.mock("$lib/api/activities", () => ({ listActivities: () => listActivities() }));
vi.mock("$lib/api/activity-groups", () => ({ listActivityGroups: () => listActivityGroups() }));
vi.mock("$lib/api/schedules", () => ({
  getGroupScheduleOrder: (groupId: number) => getGroupScheduleOrder(groupId),
  reorderGroupSchedules: (groupId: number, ids: number[]) => reorderGroupSchedules(groupId, ids),
  createGroupSchedule: (groupId: number, input: unknown) => createGroupSchedule(groupId, input),
  updateGroupSchedule: (id: number, input: unknown) => updateGroupSchedule(id, input),
  deleteGroupSchedule: (id: number) => deleteGroupSchedule(id),
}));

const { default: GroupSchedulesView } = await import(
  "../../src/lib/views/GroupSchedulesView.svelte"
);

function schedule(overrides: Partial<GroupScheduleResponse> & Pick<GroupScheduleResponse, "id">) {
  return {
    userGroupId: 1,
    targetKind: "activity",
    targetId: 5,
    action: "deny",
    recurrenceDays: null,
    recurrenceStartMinute: null,
    recurrenceEndMinute: null,
    effectiveFrom: null,
    effectiveTo: null,
    ordinal: 0,
    ...overrides,
  } as GroupScheduleResponse;
}

/** Two activity:5 rules where the second is shadowed by the first. */
function initialView(): GroupScheduleOrderView {
  return {
    schedules: [
      schedule({ id: 10, action: "deny", ordinal: 0 }),
      schedule({ id: 11, action: "allow", ordinal: 1 }),
    ],
    shadows: [{ shadowedId: 11, shadowedById: 10 }],
  };
}

/** The view after swapping the two rules: the allow now wins. */
function swappedView(): GroupScheduleOrderView {
  return {
    schedules: [
      schedule({ id: 11, action: "allow", ordinal: 0 }),
      schedule({ id: 10, action: "deny", ordinal: 1 }),
    ],
    shadows: [{ shadowedId: 10, shadowedById: 11 }],
  };
}

/** Select the group named `name` by index (robust against Svelte's value binding). */
async function selectGroup(name: string): Promise<void> {
  const select = (await screen.findByLabelText(
    "Manage schedules for group",
  )) as HTMLSelectElement;
  const index = Array.from(select.options).findIndex((o) => o.textContent?.trim() === name);
  expect(index).toBeGreaterThanOrEqual(0);
  select.selectedIndex = index;
  await fireEvent.change(select);
}

beforeEach(() => {
  listUserGroups
    .mockReset()
    .mockResolvedValue([
      { id: 1, name: "Kids", createdAt: "2026-01-01T00:00:00.000Z" },
    ] as UserGroupResponse[]);
  listActivities
    .mockReset()
    .mockResolvedValue([{ id: 5, matcher: "youtube.com", kind: "domain" }] as ActivityResponse[]);
  listActivityGroups.mockReset().mockResolvedValue([]);
  getGroupScheduleOrder.mockReset().mockResolvedValue(initialView());
  reorderGroupSchedules.mockReset();
  createGroupSchedule.mockReset();
  updateGroupSchedule.mockReset();
  deleteGroupSchedule.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GroupSchedulesView drag-to-order", () => {
  it("loads a group's ordered rules with the shadow warning and no in-effect badge", async () => {
    render(GroupSchedulesView);
    await selectGroup("Kids");

    await waitFor(() => expect(getGroupScheduleOrder).toHaveBeenCalledWith(1));

    // Both rules render, in order, with 1-based positions.
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Deny")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Allow")).toBeInTheDocument();

    // The shadowed rule warns and points at its shadower.
    expect(within(items[1]!).getByText(/Never applies — rule #1 above/)).toBeInTheDocument();
    // No "in effect now" badge anywhere — the group view omits it by design.
    expect(screen.queryByText("In effect now")).not.toBeInTheDocument();
  });

  it("persists a Move down and re-renders from the server's fresh view", async () => {
    reorderGroupSchedules.mockResolvedValue(swappedView());

    render(GroupSchedulesView);
    await selectGroup("Kids");
    await screen.findAllByRole("listitem");

    // Move the first rule (id 10) down — the keyboard-accessible path.
    await fireEvent.click(screen.getAllByLabelText("Move down")[0]!);

    await waitFor(() => expect(reorderGroupSchedules).toHaveBeenCalledWith(1, [11, 10]));

    // The list re-renders in the new order: the allow is now first, the deny shadowed.
    const items = await screen.findAllByRole("listitem");
    expect(within(items[0]!).getByText("Allow")).toBeInTheDocument();
    expect(within(items[1]!).getByText(/Never applies — rule #1 above/)).toBeInTheDocument();
  });

  it("persists a drag-and-drop reorder", async () => {
    reorderGroupSchedules.mockResolvedValue(swappedView());

    render(GroupSchedulesView);
    await selectGroup("Kids");
    const items = await screen.findAllByRole("listitem");

    // Drag the first row onto the second.
    await fireEvent.dragStart(items[0]!);
    await fireEvent.drop(items[1]!);

    await waitFor(() => expect(reorderGroupSchedules).toHaveBeenCalledWith(1, [11, 10]));
  });

  it("creates a rule for the selected group, appended after the existing ones", async () => {
    createGroupSchedule.mockResolvedValue(
      schedule({ id: 12, targetKind: "overall", targetId: null }),
    );
    getGroupScheduleOrder.mockResolvedValueOnce(initialView()).mockResolvedValueOnce(initialView());

    render(GroupSchedulesView);
    await selectGroup("Kids");
    await screen.findAllByRole("listitem");

    await fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    await waitFor(() =>
      expect(createGroupSchedule).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ targetKind: "overall", action: "deny", ordinal: 2 }),
      ),
    );
    // The order view is reloaded to reflect the new rule.
    expect(getGroupScheduleOrder).toHaveBeenCalledTimes(2);
  });

  it("surfaces a reorder failure and resyncs from the server", async () => {
    reorderGroupSchedules.mockRejectedValue(new Error("conflict"));
    getGroupScheduleOrder.mockResolvedValueOnce(initialView()).mockResolvedValueOnce(initialView());

    render(GroupSchedulesView);
    await selectGroup("Kids");
    await screen.findAllByRole("listitem");

    await fireEvent.click(screen.getAllByLabelText("Move down")[0]!);

    expect(await screen.findByRole("alert")).toHaveTextContent("conflict");
    // It reloads to the server's truth after the failed reorder.
    await waitFor(() => expect(getGroupScheduleOrder).toHaveBeenCalledTimes(2));
  });
});
