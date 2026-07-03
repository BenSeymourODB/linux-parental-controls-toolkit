/**
 * Recurrence authoring flow for `SchedulesView` (#361) — the write path the
 * presentational `recurrence-fields` suite doesn't cover. Drives the real
 * `<RecurrenceFields>` binding in the create form and inline edit, and asserts
 * the exact `/api` payload, plus the client-side validation gating.
 *
 * The `/api` wrappers are mocked; no live backend. Mirrors the mock setup in
 * `schedules-view.test.ts`.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityGroupResponse,
  ActivityResponse,
  ScheduleOrderView,
  ScheduleResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";
import { dateInputToInstant } from "../../src/lib/recurrence.js";

const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();
const listActivityGroups = vi.fn<() => Promise<ActivityGroupResponse[]>>();
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
  } as ScheduleResponse;
}

function orderView(schedules: ScheduleResponse[]): ScheduleOrderView {
  return { schedules, shadows: [], effectiveIds: [] };
}

async function selectUser(name: string): Promise<void> {
  const select = (await screen.findByLabelText("Manage schedules for user")) as HTMLSelectElement;
  const index = Array.from(select.options).findIndex((o) => o.textContent?.trim() === name);
  expect(index).toBeGreaterThanOrEqual(0);
  select.selectedIndex = index;
  await fireEvent.change(select);
}

async function selectOptionContaining(label: string, text: string): Promise<void> {
  const select = (await screen.findByLabelText(label)) as HTMLSelectElement;
  const index = Array.from(select.options).findIndex((o) => o.textContent?.includes(text));
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
  listActivityGroups
    .mockReset()
    .mockResolvedValue([{ id: 9, name: "Social media" }] as ActivityGroupResponse[]);
  getScheduleOrder.mockReset().mockResolvedValue(orderView([schedule({ id: 1 })]));
  reorderSchedules.mockReset();
  createSchedule.mockReset().mockResolvedValue(schedule({ id: 2 }));
  updateSchedule.mockReset().mockResolvedValue(schedule({ id: 1 }));
  deleteSchedule.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SchedulesView create with recurrence", () => {
  it("creates 'allow Mon–Fri 16:00–18:00' with the authored recurrence", async () => {
    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      await fireEvent.click(screen.getByLabelText(day));
    }
    await fireEvent.input(screen.getByLabelText("Start time"), { target: { value: "16:00" } });
    await fireEvent.input(screen.getByLabelText("End time"), { target: { value: "18:00" } });
    await selectOptionContaining("Schedule action", "Allow");
    await fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    await waitFor(() =>
      expect(createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          targetKind: "overall",
          action: "allow",
          recurrenceDays: 0b0011111, // Mon–Fri = 31
          recurrenceStartMinute: 960,
          recurrenceEndMinute: 1080,
          effectiveFrom: null,
          effectiveTo: null,
        }),
      ),
    );
  });

  it("creates 'deny after 21:00 daily' with end 00:00 mapped to end-of-day (1440)", async () => {
    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    await fireEvent.input(screen.getByLabelText("Start time"), { target: { value: "21:00" } });
    await fireEvent.input(screen.getByLabelText("End time"), { target: { value: "00:00" } });
    await fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    await waitFor(() =>
      expect(createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          recurrenceDays: null, // no weekday restriction = every day
          recurrenceStartMinute: 1260,
          recurrenceEndMinute: 1440,
        }),
      ),
    );
  });

  it("creates a date-scoped rule from the effective-date pickers", async () => {
    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    await fireEvent.input(screen.getByLabelText("Active from date"), {
      target: { value: "2026-03-01" },
    });
    await fireEvent.input(screen.getByLabelText("Active until date"), {
      target: { value: "2026-09-01" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    await waitFor(() =>
      expect(createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          effectiveFrom: dateInputToInstant("2026-03-01"),
          effectiveTo: dateInputToInstant("2026-09-01"),
        }),
      ),
    );
  });

  it("blocks Add and never calls the API for an invalid window (start only)", async () => {
    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    await fireEvent.input(screen.getByLabelText("Start time"), { target: { value: "16:00" } });

    const addButton = screen.getByRole("button", { name: "Add schedule" });
    expect(addButton).toBeDisabled();
    expect(await screen.findByText(/both a start and end time/i)).toBeInTheDocument();

    await fireEvent.click(addButton);
    expect(createSchedule).not.toHaveBeenCalled();
  });
});

describe("SchedulesView edit with recurrence", () => {
  it("prefills the picker and PATCHes the full recurrence set on save", async () => {
    getScheduleOrder.mockResolvedValue(
      orderView([
        schedule({
          id: 1,
          recurrenceDays: 0b0011111,
          recurrenceStartMinute: 960,
          recurrenceEndMinute: 1080,
        }),
      ]),
    );
    render(SchedulesView);
    await selectUser("Alice");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    await fireEvent.click(within(item).getByRole("button", { name: "Edit" }));

    // Prefilled from the row.
    expect(within(item).getByLabelText("Monday")).toBeChecked();
    expect(within(item).getByLabelText("Start time")).toHaveValue("16:00");

    // Widen the window to 15:00 and save.
    await fireEvent.input(within(item).getByLabelText("Start time"), {
      target: { value: "15:00" },
    });
    await fireEvent.click(within(item).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateSchedule).toHaveBeenCalledWith(1, {
        action: "deny",
        recurrenceDays: 0b0011111,
        recurrenceStartMinute: 900,
        recurrenceEndMinute: 1080,
        effectiveFrom: null,
        effectiveTo: null,
      }),
    );
  });

  it("disables Save and does not PATCH when the edited window is invalid", async () => {
    getScheduleOrder.mockResolvedValue(
      orderView([
        schedule({ id: 1, recurrenceStartMinute: 960, recurrenceEndMinute: 1080 }),
      ]),
    );
    render(SchedulesView);
    await selectUser("Alice");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    await fireEvent.click(within(item).getByRole("button", { name: "Edit" }));

    // End before start → invalid.
    await fireEvent.input(within(item).getByLabelText("End time"), { target: { value: "08:00" } });

    const saveButton = within(item).getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();
    await fireEvent.click(saveButton);
    expect(updateSchedule).not.toHaveBeenCalled();
  });
});
