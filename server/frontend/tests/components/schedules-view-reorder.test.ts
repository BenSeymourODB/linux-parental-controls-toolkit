/**
 * Component smoke test for the schedule drag-to-order editor (#63).
 *
 * The CRUD skeleton is covered by the shared pattern (#266); this focuses on
 * what `SchedulesView` adds: selecting a user loads their ordered rules with the
 * server-derived "in effect now" badge and "never applies" shadow warning, and
 * reordering (the keyboard Move buttons and a drag-drop) persists the new id
 * order and re-renders from the server's fresh view. The `/api` wrappers are
 * mocked — no live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityResponse,
  ScheduleOrderView,
  ScheduleResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();
const listActivityGroups = vi.fn<() => Promise<unknown[]>>();
const getScheduleOrder = vi.fn<(userId: number) => Promise<ScheduleOrderView>>();
const reorderSchedules = vi.fn<(userId: number, ids: number[]) => Promise<ScheduleOrderView>>();
const createSchedule = vi.fn<(input: unknown) => Promise<ScheduleResponse>>();
const updateSchedule = vi.fn<(id: number, input: unknown) => Promise<ScheduleResponse>>();
const deleteSchedule = vi.fn<(id: number) => Promise<void>>();

vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));
vi.mock("$lib/api/activities", () => ({ listActivities: () => listActivities() }));
vi.mock("$lib/api/activity-groups", () => ({ listActivityGroups: () => listActivityGroups() }));
vi.mock("$lib/api/schedules", () => ({
  getScheduleOrder: (userId: number) => getScheduleOrder(userId),
  reorderSchedules: (userId: number, ids: number[]) => reorderSchedules(userId, ids),
  createSchedule: (input: unknown) => createSchedule(input),
  updateSchedule: (id: number, input: unknown) => updateSchedule(id, input),
  deleteSchedule: (id: number) => deleteSchedule(id),
}));

const { default: SchedulesView } = await import("../../src/lib/views/SchedulesView.svelte");

function schedule(overrides: Partial<ScheduleResponse> & Pick<ScheduleResponse, "id">) {
  return {
    userId: 1,
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
  } as ScheduleResponse;
}

/** Two activity:5 rules where the second is shadowed by the first. */
function initialView(): ScheduleOrderView {
  return {
    schedules: [
      schedule({ id: 10, action: "deny", ordinal: 0 }),
      schedule({ id: 11, action: "allow", ordinal: 1 }),
    ],
    shadows: [{ shadowedId: 11, shadowedById: 10 }],
    effectiveIds: [10],
  };
}

/** The view after swapping the two rules: the allow now wins. */
function swappedView(): ScheduleOrderView {
  return {
    schedules: [
      schedule({ id: 11, action: "allow", ordinal: 0 }),
      schedule({ id: 10, action: "deny", ordinal: 1 }),
    ],
    shadows: [{ shadowedId: 10, shadowedById: 11 }],
    effectiveIds: [11],
  };
}

/** Select the user named `name` by index (robust against Svelte's value binding). */
async function selectUser(name: string): Promise<void> {
  const select = (await screen.findByLabelText(
    "Manage schedules for user",
  )) as HTMLSelectElement;
  const index = Array.from(select.options).findIndex((o) => o.textContent?.trim() === name);
  expect(index).toBeGreaterThanOrEqual(0);
  select.selectedIndex = index;
  await fireEvent.change(select);
}

beforeEach(() => {
  listUsers.mockReset().mockResolvedValue([
    { id: 1, displayName: "Alice", tz: "UTC", createdAt: "2026-01-01T00:00:00.000Z" },
  ] as UserResponse[]);
  listActivities
    .mockReset()
    .mockResolvedValue([{ id: 5, matcher: "youtube.com", kind: "domain" }] as ActivityResponse[]);
  listActivityGroups.mockReset().mockResolvedValue([]);
  getScheduleOrder.mockReset().mockResolvedValue(initialView());
  reorderSchedules.mockReset();
  createSchedule.mockReset();
  updateSchedule.mockReset();
  deleteSchedule.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SchedulesView drag-to-order", () => {
  it("loads a user's ordered rules with the in-effect badge and shadow warning", async () => {
    render(SchedulesView);
    await selectUser("Alice");

    await waitFor(() => expect(getScheduleOrder).toHaveBeenCalledWith(1));

    // Both rules render, in order, with 1-based positions.
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Deny")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Allow")).toBeInTheDocument();

    // The winning rule is badged; the shadowed rule warns and points at it.
    expect(within(items[0]!).getByText("In effect now")).toBeInTheDocument();
    expect(within(items[1]!).queryByText("In effect now")).not.toBeInTheDocument();
    expect(within(items[1]!).getByText(/Never applies — rule #1 above/)).toBeInTheDocument();
  });

  it("persists a Move down and re-renders from the server's fresh view", async () => {
    reorderSchedules.mockResolvedValue(swappedView());

    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    // Move the first rule (id 10) down — the keyboard-accessible path.
    await fireEvent.click(screen.getAllByLabelText("Move down")[0]!);

    await waitFor(() => expect(reorderSchedules).toHaveBeenCalledWith(1, [11, 10]));

    // The list re-renders in the new order: the allow is now first and in effect.
    const items = await screen.findAllByRole("listitem");
    expect(within(items[0]!).getByText("Allow")).toBeInTheDocument();
    expect(within(items[0]!).getByText("In effect now")).toBeInTheDocument();
    expect(within(items[1]!).getByText(/Never applies — rule #1 above/)).toBeInTheDocument();
  });

  it("persists a drag-and-drop reorder", async () => {
    reorderSchedules.mockResolvedValue(swappedView());

    render(SchedulesView);
    await selectUser("Alice");
    const items = await screen.findAllByRole("listitem");

    // Drag the first row onto the second.
    await fireEvent.dragStart(items[0]!);
    await fireEvent.drop(items[1]!);

    await waitFor(() => expect(reorderSchedules).toHaveBeenCalledWith(1, [11, 10]));
  });

  it("creates a rule for the selected user, appended after the existing ones", async () => {
    createSchedule.mockResolvedValue(schedule({ id: 12, targetKind: "overall", targetId: null }));
    // After create, the view reloads; second call returns the grown list.
    getScheduleOrder
      .mockResolvedValueOnce(initialView())
      .mockResolvedValueOnce({ ...initialView(), effectiveIds: [10] });

    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    await fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    await waitFor(() =>
      expect(createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, targetKind: "overall", action: "deny", ordinal: 2 }),
      ),
    );
    // The order view is reloaded to reflect the new rule.
    expect(getScheduleOrder).toHaveBeenCalledTimes(2);
  });

  it("surfaces a reorder failure and resyncs from the server", async () => {
    reorderSchedules.mockRejectedValue(new Error("conflict"));
    getScheduleOrder.mockResolvedValueOnce(initialView()).mockResolvedValueOnce(initialView());

    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    await fireEvent.click(screen.getAllByLabelText("Move down")[0]!);

    expect(await screen.findByRole("alert")).toHaveTextContent("conflict");
    // It reloads to the server's truth after the failed reorder.
    await waitFor(() => expect(getScheduleOrder).toHaveBeenCalledTimes(2));
  });
});
