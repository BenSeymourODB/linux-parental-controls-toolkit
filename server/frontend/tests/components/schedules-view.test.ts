/**
 * Component smoke test for `SchedulesView`'s computed / conversion / picker
 * logic (#285, the SchedulesView slice deferred from #266/#279).
 *
 * The CRUD skeleton and the drag-to-order primitive (server-derived shadow +
 * "in effect now" badge, Move up/down, drag-drop, reorder failure resync) are
 * covered by `schedules-view-reorder.test.ts` (#63). This complementary suite
 * pins the read-only derived display that the reorder suite doesn't exercise:
 *
 *   - the 7-bit ISO-weekday bitmask decode (`daysLabel`) and the full
 *     `recurrenceSummary` (weekdays + intra-day window + effective-date scope,
 *     and the "Always" degenerate),
 *   - minutes-from-midnight → `HH:MM` conversion (`clockLabel`),
 *   - the per-row target label for each scope (`targetLabel`),
 *   - the conditional scope → target picker (overall vs activity vs group),
 *     its reset-on-scope-change, and the create-disabled gating.
 *
 * Authoring day/time windows is #140, so the inverse (HH:MM → minutes on save)
 * does not exist in this editor yet — the conversion is display-only here. The
 * `/api` wrappers are mocked; no live backend.
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

/** A schedule row with sane "always-on overall deny" defaults; override at will. */
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

/** An order view carrying `schedules`, with no shadows and nothing in effect. */
function orderView(schedules: ScheduleResponse[]): ScheduleOrderView {
  return { schedules, shadows: [], effectiveIds: [] };
}

/** Select the user named `name` by index (robust against Svelte's value binding). */
async function selectUser(name: string): Promise<void> {
  const select = (await screen.findByLabelText("Manage schedules for user")) as HTMLSelectElement;
  const index = Array.from(select.options).findIndex((o) => o.textContent?.trim() === name);
  expect(index).toBeGreaterThanOrEqual(0);
  select.selectedIndex = index;
  await fireEvent.change(select);
}

/** Select the option whose label contains `text` in the labelled `<select>`. */
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
  createSchedule.mockReset();
  updateSchedule.mockReset();
  deleteSchedule.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SchedulesView recurrence summary (bitmask + clock decode)", () => {
  it("renders 'Always' for the degenerate all-null rule", async () => {
    render(SchedulesView);
    await selectUser("Alice");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    expect(within(item).getByText("Always")).toBeInTheDocument();
  });

  it("decodes a partial weekday mask and the intra-day window", async () => {
    // bits 0..4 = Mon–Fri (0b0011111 = 31); 540 = 09:00, 1290 = 21:30.
    getScheduleOrder.mockResolvedValue(
      orderView([
        schedule({
          id: 1,
          recurrenceDays: 0b0011111,
          recurrenceStartMinute: 540,
          recurrenceEndMinute: 1290,
        }),
      ]),
    );
    render(SchedulesView);
    await selectUser("Alice");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    // En-dash (U+2013) separates the start/end clocks (SchedulesView line 180).
    expect(
      within(item).getByText(/^Mon, Tue, Wed, Thu, Fri 09:00–21:30$/),
    ).toBeInTheDocument();
  });

  it("collapses a full seven-bit mask to 'Every day' and pads the clock", async () => {
    // mask 127 = all seven days; 0 = 00:00, 1439 = 23:59 (clock padding).
    getScheduleOrder.mockResolvedValue(
      orderView([
        schedule({
          id: 1,
          recurrenceDays: 127,
          recurrenceStartMinute: 0,
          recurrenceEndMinute: 1439,
        }),
      ]),
    );
    render(SchedulesView);
    await selectUser("Alice");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    expect(within(item).getByText(/^Every day 00:00–23:59$/)).toBeInTheDocument();
  });

  it("decodes a single isolated weekday bit", async () => {
    // bit 6 alone (0b1000000 = 64) = Sunday only.
    getScheduleOrder.mockResolvedValue(orderView([schedule({ id: 1, recurrenceDays: 0b1000000 })]));
    render(SchedulesView);
    await selectUser("Alice");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    expect(within(item).getByText("Sun")).toBeInTheDocument();
  });

  it("appends a half-open effective-date scope (start set, no end)", async () => {
    getScheduleOrder.mockResolvedValue(
      orderView([schedule({ id: 1, effectiveFrom: "2026-03-01T00:00:00.000Z" })]),
    );
    render(SchedulesView);
    await selectUser("Alice");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    // "Always (<localised date> → …)" — the open end renders as the ellipsis,
    // the start as a date, so the left side is not itself an ellipsis. The
    // exact date string is locale-dependent, so assert only the structure.
    expect(within(item).getByText(/Always \([^…]+ → …\)/)).toBeInTheDocument();
  });

  it("appends a half-open effective-date scope (end set, no start)", async () => {
    getScheduleOrder.mockResolvedValue(
      orderView([schedule({ id: 1, effectiveTo: "2026-09-01T00:00:00.000Z" })]),
    );
    render(SchedulesView);
    await selectUser("Alice");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    expect(within(item).getByText(/Always \(… → [^…]+\)/)).toBeInTheDocument();
  });
});

describe("SchedulesView target label per scope", () => {
  it("renders the activity matcher, the group name, and no target for overall", async () => {
    getScheduleOrder.mockResolvedValue(
      orderView([
        schedule({ id: 1, targetKind: "overall", targetId: null }),
        schedule({ id: 2, targetKind: "activity", targetId: 5, ordinal: 1 }),
        schedule({ id: 3, targetKind: "group", targetId: 9, ordinal: 2 }),
      ]),
    );
    render(SchedulesView);
    await selectUser("Alice");

    const items = await screen.findAllByRole("listitem");
    // overall: scope label only, no resolved target text.
    expect(within(items[0]!).getByText("Overall")).toBeInTheDocument();
    // activity: resolves the matcher from the loaded activities.
    expect(within(items[1]!).getByText("Activity")).toBeInTheDocument();
    expect(within(items[1]!).getByText("youtube.com")).toBeInTheDocument();
    // group: resolves the name from the loaded activity groups.
    expect(within(items[2]!).getByText("Activity group")).toBeInTheDocument();
    expect(within(items[2]!).getByText("Social media")).toBeInTheDocument();
  });

  it("falls back to an id label when the target isn't in the loaded lists", async () => {
    getScheduleOrder.mockResolvedValue(
      orderView([schedule({ id: 1, targetKind: "activity", targetId: 404 })]),
    );
    render(SchedulesView);
    await selectUser("Alice");

    const item = (await screen.findAllByRole("listitem"))[0]!;
    expect(within(item).getByText("Activity 404")).toBeInTheDocument();
  });
});

describe("SchedulesView scope → target picker", () => {
  it("shows no target picker for the overall scope", async () => {
    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    // The default scope is "overall": neither target picker is mounted, and Add
    // is enabled (overall needs no target).
    expect(screen.queryByLabelText("Target activity")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target group")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add schedule" })).toBeEnabled();
  });

  it("reveals the activity picker for Activity and swaps to the group picker for Activity group", async () => {
    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    await selectOptionContaining("Schedule scope", "Activity");
    expect(await screen.findByLabelText("Target activity")).toBeInTheDocument();
    expect(screen.queryByLabelText("Target group")).not.toBeInTheDocument();

    await selectOptionContaining("Schedule scope", "Activity group");
    expect(await screen.findByLabelText("Target group")).toBeInTheDocument();
    expect(screen.queryByLabelText("Target activity")).not.toBeInTheDocument();
  });

  it("disables Add until a target is chosen, and resets the target when the scope changes", async () => {
    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    const addButton = screen.getByRole("button", { name: "Add schedule" });

    // A non-overall scope with no target chosen → Add is blocked.
    await selectOptionContaining("Schedule scope", "Activity");
    expect(addButton).toBeDisabled();

    // Choosing the activity target unblocks it.
    await selectOptionContaining("Target activity", "youtube.com");
    expect(addButton).toBeEnabled();

    // Switching scope clears the chosen target, so Add is blocked again.
    await selectOptionContaining("Schedule scope", "Activity group");
    expect(addButton).toBeDisabled();
  });

  it("creates an activity-scoped rule with the chosen target", async () => {
    createSchedule.mockResolvedValue(schedule({ id: 2, targetKind: "activity", targetId: 5 }));
    render(SchedulesView);
    await selectUser("Alice");
    await screen.findAllByRole("listitem");

    await selectOptionContaining("Schedule scope", "Activity");
    await selectOptionContaining("Target activity", "youtube.com");
    await fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    await waitFor(() =>
      expect(createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          targetKind: "activity",
          targetId: 5,
          action: "deny",
        }),
      ),
    );
  });
});
