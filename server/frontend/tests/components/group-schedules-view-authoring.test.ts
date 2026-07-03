/**
 * Recurrence authoring flow for `GroupSchedulesView` (#361) — the group
 * counterpart of `schedules-view-authoring.test.ts`. Drives the real
 * `<RecurrenceFields>` binding in the group create form and inline edit and
 * asserts the exact `/api` payload (create is keyed by the path `groupId`, so
 * the body carries no `userId`), plus the client-side validation gating.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityResponse,
  GroupScheduleOrderView,
  GroupScheduleResponse,
  UserGroupResponse,
} from "../../src/lib/api/contract.js";
import { dateInputToInstant } from "../../src/lib/recurrence.js";

const listUserGroups = vi.fn<() => Promise<UserGroupResponse[]>>();
const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();
const listActivityGroups = vi.fn<() => Promise<unknown[]>>();
const getGroupScheduleOrder = vi.fn<(groupId: number) => Promise<GroupScheduleOrderView>>();
const reorderGroupSchedules =
  vi.fn<(groupId: number, ids: number[]) => Promise<GroupScheduleOrderView>>();
const createGroupSchedule =
  vi.fn<(groupId: number, input: unknown) => Promise<GroupScheduleResponse>>();
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
    targetKind: "overall",
    targetId: null,
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

function orderView(schedules: GroupScheduleResponse[]): GroupScheduleOrderView {
  return { schedules, shadows: [] };
}

async function selectGroup(name: string): Promise<void> {
  const select = (await screen.findByLabelText("Manage schedules for group")) as HTMLSelectElement;
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
  getGroupScheduleOrder.mockReset().mockResolvedValue(orderView([schedule({ id: 1 })]));
  reorderGroupSchedules.mockReset();
  createGroupSchedule.mockReset().mockResolvedValue(schedule({ id: 2 }));
  updateGroupSchedule.mockReset().mockResolvedValue(schedule({ id: 1 }));
  deleteGroupSchedule.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GroupSchedulesView create with recurrence", () => {
  it("creates 'deny Mon–Fri 21:00–end-of-day' for the group, keyed by groupId, no userId", async () => {
    render(GroupSchedulesView);
    await selectGroup("Kids");
    await screen.findAllByRole("listitem");

    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      await fireEvent.click(screen.getByLabelText(day));
    }
    await fireEvent.input(screen.getByLabelText("Start time"), { target: { value: "21:00" } });
    await fireEvent.input(screen.getByLabelText("End time"), { target: { value: "00:00" } });
    await fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    await waitFor(() => expect(createGroupSchedule).toHaveBeenCalledTimes(1));
    const [groupId, body] = createGroupSchedule.mock.calls[0]!;
    expect(groupId).toBe(1);
    expect(body).toEqual(
      expect.objectContaining({
        targetKind: "overall",
        action: "deny",
        recurrenceDays: 0b0011111,
        recurrenceStartMinute: 1260,
        recurrenceEndMinute: 1440,
        effectiveFrom: null,
        effectiveTo: null,
      }),
    );
    expect(body).not.toHaveProperty("userId");
  });

  it("creates a date-scoped group rule from the effective-date pickers", async () => {
    render(GroupSchedulesView);
    await selectGroup("Kids");
    await screen.findAllByRole("listitem");

    await fireEvent.input(screen.getByLabelText("Active from date"), {
      target: { value: "2026-03-01" },
    });
    await fireEvent.input(screen.getByLabelText("Active until date"), {
      target: { value: "2026-09-01" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    await waitFor(() => expect(createGroupSchedule).toHaveBeenCalledTimes(1));
    const [groupId, body] = createGroupSchedule.mock.calls[0]!;
    expect(groupId).toBe(1);
    expect(body).toEqual(
      expect.objectContaining({
        effectiveFrom: dateInputToInstant("2026-03-01"),
        effectiveTo: dateInputToInstant("2026-09-01"),
      }),
    );
  });

  it("blocks Add for an invalid window (end only) and never calls the API", async () => {
    render(GroupSchedulesView);
    await selectGroup("Kids");
    await screen.findAllByRole("listitem");

    await fireEvent.input(screen.getByLabelText("End time"), { target: { value: "18:00" } });

    const addButton = screen.getByRole("button", { name: "Add schedule" });
    expect(addButton).toBeDisabled();
    await fireEvent.click(addButton);
    expect(createGroupSchedule).not.toHaveBeenCalled();
  });
});

describe("GroupSchedulesView edit with recurrence", () => {
  it("prefills the picker and PATCHes the full recurrence set on save", async () => {
    getGroupScheduleOrder.mockResolvedValue(
      orderView([schedule({ id: 1, recurrenceDays: 0b1000000, action: "allow" })]),
    );
    render(GroupSchedulesView);
    await selectGroup("Kids");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    await fireEvent.click(within(item).getByRole("button", { name: "Edit" }));

    expect(within(item).getByLabelText("Sunday")).toBeChecked();

    // Add a Saturday window scope by also checking Saturday.
    await fireEvent.click(within(item).getByLabelText("Saturday"));
    await fireEvent.click(within(item).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateGroupSchedule).toHaveBeenCalledWith(1, {
        action: "allow",
        recurrenceDays: 0b1100000, // Sat + Sun
        recurrenceStartMinute: null,
        recurrenceEndMinute: null,
        effectiveFrom: null,
        effectiveTo: null,
      }),
    );
  });

  it("disables Save and does not PATCH when the edited window is invalid", async () => {
    getGroupScheduleOrder.mockResolvedValue(
      orderView([schedule({ id: 1, recurrenceStartMinute: 960, recurrenceEndMinute: 1080 })]),
    );
    render(GroupSchedulesView);
    await selectGroup("Kids");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    await fireEvent.click(within(item).getByRole("button", { name: "Edit" }));

    // End before start → invalid.
    await fireEvent.input(within(item).getByLabelText("End time"), { target: { value: "08:00" } });

    const saveButton = within(item).getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();
    await fireEvent.click(saveButton);
    expect(updateGroupSchedule).not.toHaveBeenCalled();
  });
});
