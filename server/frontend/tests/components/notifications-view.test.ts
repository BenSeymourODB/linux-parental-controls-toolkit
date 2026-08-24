/**
 * Smoke test for `NotificationsView` (#105). The CRUD-skeleton shape is proven
 * elsewhere; this suite targets the logic this view adds: pick-a-user →
 * load-and-hydrate the effective policy, the dirty-gating on Save, the
 * grace-bound validation, Save sending the three knobs, Reset → DELETE +
 * reload, and the structured per-budget cadence editor (#302): hydrate rows,
 * add/edit/remove, key + normalise the PUT payload, client-side validation
 * gating, and Clear all → explicit null.
 *
 * The budget-sourced cadence picker (#388) is covered here too: options are
 * sourced from the user's budgets and labelled with the activity/group names,
 * de-duplicated across rollover windows, with a stored override for a
 * since-deleted budget staying pickable. The
 * `$lib/api/notifications` + `$lib/api/users` + `$lib/api/budgets` +
 * `$lib/api/activities` + `$lib/api/activity-groups` wrappers are mocked; the
 * real `ApiError` is used so the "already at defaults" 404 path is exercised.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../src/lib/api/client.js";
import type {
  ActivityGroupResponse,
  ActivityResponse,
  BudgetResponse,
  NotificationPolicyResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const getNotificationPolicy = vi.fn<(userId: number) => Promise<NotificationPolicyResponse>>();
const upsertNotificationPolicy =
  vi.fn<(userId: number, input: unknown) => Promise<NotificationPolicyResponse>>();
const deleteNotificationPolicy = vi.fn<(userId: number) => Promise<void>>();
const listBudgets = vi.fn<(userId?: number) => Promise<BudgetResponse[]>>();
const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();
const listActivityGroups = vi.fn<() => Promise<ActivityGroupResponse[]>>();

vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));
vi.mock("$lib/api/notifications", () => ({
  getNotificationPolicy: (userId: number) => getNotificationPolicy(userId),
  upsertNotificationPolicy: (userId: number, input: unknown) =>
    upsertNotificationPolicy(userId, input),
  deleteNotificationPolicy: (userId: number) => deleteNotificationPolicy(userId),
}));
vi.mock("$lib/api/budgets", () => ({ listBudgets: (userId?: number) => listBudgets(userId) }));
vi.mock("$lib/api/activities", () => ({ listActivities: () => listActivities() }));
vi.mock("$lib/api/activity-groups", () => ({ listActivityGroups: () => listActivityGroups() }));

const { default: NotificationsView } = await import(
  "../../src/lib/views/NotificationsView.svelte"
);

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 1,
    displayName: "Alice",
    tz: "Europe/London",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserResponse;
}

function policy(overrides: Partial<NotificationPolicyResponse> = {}): NotificationPolicyResponse {
  return {
    userId: 1,
    enabled: true,
    soundProfile: "subtle",
    graceSeconds: 15,
    cadenceOverrides: null,
    ...overrides,
  };
}

function budget(overrides: Partial<BudgetResponse> = {}): BudgetResponse {
  return {
    id: 1,
    userId: 1,
    recurrenceDays: null,
    scope: "overall",
    targetId: null,
    window: "daily",
    secondsAllowed: 3600,
    ...overrides,
  };
}

function activity(overrides: Partial<ActivityResponse> = {}): ActivityResponse {
  return { id: 1, kind: "app", matcher: "firefox", matchType: "exact", ...overrides };
}

function group(overrides: Partial<ActivityGroupResponse> = {}): ActivityGroupResponse {
  return { id: 1, name: "Games", ...overrides };
}

beforeEach(() => {
  listUsers.mockReset().mockResolvedValue([user()]);
  getNotificationPolicy.mockReset().mockResolvedValue(policy());
  upsertNotificationPolicy.mockReset().mockResolvedValue(policy());
  deleteNotificationPolicy.mockReset().mockResolvedValue();
  listBudgets.mockReset().mockResolvedValue([]);
  listActivities.mockReset().mockResolvedValue([]);
  listActivityGroups.mockReset().mockResolvedValue([]);
  vi.spyOn(globalThis, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function selectUser(value = "1"): Promise<void> {
  await fireEvent.change(await screen.findByLabelText("User"), { target: { value } });
}

describe("NotificationsView", () => {
  it("prompts to add a user first when none exist", async () => {
    listUsers.mockResolvedValue([]);

    render(NotificationsView);

    expect(
      await screen.findByText(
        "Add a user first — notification settings always belong to a user.",
      ),
    ).toBeInTheDocument();
  });

  it("loads and hydrates the selected user's policy", async () => {
    getNotificationPolicy.mockResolvedValue(
      policy({ enabled: false, soundProfile: "prominent", graceSeconds: 30 }),
    );

    render(NotificationsView);
    await selectUser();

    await waitFor(() => expect(getNotificationPolicy).toHaveBeenCalledWith(1));
    const enabled = (await screen.findByLabelText(
      "Notifications enabled",
    )) as HTMLInputElement;
    expect(enabled.checked).toBe(false);
    expect((screen.getByLabelText("Sound profile") as HTMLSelectElement).value).toBe("prominent");
    expect((screen.getByLabelText("Grace period seconds") as HTMLInputElement).value).toBe("30");
  });

  it("keeps Save disabled until a field changes, then PUTs the three knobs", async () => {
    upsertNotificationPolicy.mockResolvedValue(
      policy({ soundProfile: "prominent", graceSeconds: 30 }),
    );

    render(NotificationsView);
    await selectUser();

    const save = await screen.findByRole("button", { name: "Save" });
    // Unchanged form → no-op PUT is gated.
    expect(save).toBeDisabled();

    await fireEvent.change(screen.getByLabelText("Sound profile"), {
      target: { value: "prominent" },
    });
    await fireEvent.input(screen.getByLabelText("Grace period seconds"), {
      target: { value: "30" },
    });
    expect(save).toBeEnabled();

    await fireEvent.click(save);

    expect(upsertNotificationPolicy).toHaveBeenCalledWith(1, {
      enabled: true,
      soundProfile: "prominent",
      graceSeconds: 30,
    });
    expect(await screen.findByText("Saved notification settings for Alice.")).toBeInTheDocument();
  });

  it("blocks Save and warns when the grace period is out of bounds", async () => {
    render(NotificationsView);
    await selectUser();
    await screen.findByLabelText("Grace period seconds");

    await fireEvent.input(screen.getByLabelText("Grace period seconds"), {
      target: { value: "999" },
    });

    expect(
      screen.getByText("Grace period must be a whole number between 0 and 60."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(upsertNotificationPolicy).not.toHaveBeenCalled();
  });

  it("resets to defaults via DELETE and reloads the effective policy", async () => {
    render(NotificationsView);
    await selectUser();
    await screen.findByRole("button", { name: "Reset to defaults" });

    getNotificationPolicy.mockClear();
    await fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    await waitFor(() => expect(deleteNotificationPolicy).toHaveBeenCalledWith(1));
    // The view reloads the now-default policy after a reset.
    expect(getNotificationPolicy).toHaveBeenCalledWith(1);
    expect(
      await screen.findByText("Reset Alice to the default notification settings."),
    ).toBeInTheDocument();
  });

  it("treats a 404 on reset as 'already at defaults' rather than an error", async () => {
    deleteNotificationPolicy.mockRejectedValue(
      new ApiError(404, "not_found", "no custom policy"),
    );

    render(NotificationsView);
    await selectUser();
    await fireEvent.click(await screen.findByRole("button", { name: "Reset to defaults" }));

    expect(
      await screen.findByText("Alice was already using the default settings."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hydrates an existing per-budget override into an editable picker row", async () => {
    getNotificationPolicy.mockResolvedValue(
      policy({ cadenceOverrides: { "activity:7": { warningMinutes: [15, 10, 5] } } }),
    );

    render(NotificationsView);
    await selectUser();

    // The stored activity override hydrates a row: the picker is set to its key
    // (kept pickable even with no matching budget), and the marks join to a list.
    const picker = (await screen.findByLabelText("Budget")) as HTMLSelectElement;
    expect(picker.value).toBe("activity:7");
    expect((screen.getByLabelText("Warning minutes") as HTMLInputElement).value).toBe("15, 10, 5");
    // With no budget/catalogue for activity 7 the option falls back to an id label.
    expect(screen.getByRole("option", { name: "Activity 7" })).toBeInTheDocument();
  });

  it("adds a structured override and PUTs the normalised map", async () => {
    upsertNotificationPolicy.mockResolvedValue(
      policy({ cadenceOverrides: { overall: { warningMinutes: [15, 10, 5] } } }),
    );

    render(NotificationsView);
    await selectUser();

    // Save is gated until the cadence actually changes.
    const save = await screen.findByRole("button", { name: "Save cadence" });
    expect(save).toBeDisabled();

    await fireEvent.click(screen.getByRole("button", { name: "Add override" }));
    // New rows default to the overall budget.
    await fireEvent.input(screen.getByLabelText("Warning minutes"), {
      target: { value: "5, 15, 10, 10" },
    });
    expect(save).toBeEnabled();
    await fireEvent.click(save);

    expect(upsertNotificationPolicy).toHaveBeenCalledWith(1, {
      cadenceOverrides: { overall: { warningMinutes: [15, 10, 5] } },
    });
    expect(await screen.findByText("Saved the warning cadence for Alice.")).toBeInTheDocument();
  });

  it("keys an override picked from the user's budgets as '<scope>:<id>'", async () => {
    listBudgets.mockResolvedValue([budget({ scope: "activity", targetId: 3 })]);
    listActivities.mockResolvedValue([activity({ id: 3, matcher: "firefox" })]);
    upsertNotificationPolicy.mockResolvedValue(
      policy({ cadenceOverrides: { "activity:3": { warningMinutes: [5] } } }),
    );

    render(NotificationsView);
    await selectUser();
    await fireEvent.click(await screen.findByRole("button", { name: "Add override" }));
    // The activity budget surfaces as a labelled, pickable option.
    await screen.findByRole("option", { name: "Activity — firefox" });
    await fireEvent.change(screen.getByLabelText("Budget"), { target: { value: "activity:3" } });
    await fireEvent.input(screen.getByLabelText("Warning minutes"), { target: { value: "5" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save cadence" }));

    expect(upsertNotificationPolicy).toHaveBeenCalledWith(1, {
      cadenceOverrides: { "activity:3": { warningMinutes: [5] } },
    });
  });

  it("blocks saving an out-of-bounds warn-at mark and surfaces why", async () => {
    render(NotificationsView);
    await selectUser();
    await fireEvent.click(await screen.findByRole("button", { name: "Add override" }));
    await fireEvent.input(screen.getByLabelText("Warning minutes"), { target: { value: "0" } });

    expect(screen.getByRole("alert")).toHaveTextContent("Warning minutes must be whole numbers");
    expect(screen.getByRole("button", { name: "Save cadence" })).toBeDisabled();
    expect(upsertNotificationPolicy).not.toHaveBeenCalled();
  });

  it("blocks saving two overrides pointed at the same budget", async () => {
    getNotificationPolicy.mockResolvedValue(
      policy({
        cadenceOverrides: {
          "activity:1": { warningMinutes: [10] },
          "activity:2": { warningMinutes: [5] },
        },
      }),
    );

    render(NotificationsView);
    await selectUser();

    // Point the second row's picker at the same budget as the first.
    const pickers = await screen.findAllByLabelText("Budget");
    await fireEvent.change(pickers[1] as HTMLSelectElement, { target: { value: "activity:1" } });

    expect(screen.getByRole("alert")).toHaveTextContent("Duplicate override");
    expect(screen.getByRole("button", { name: "Save cadence" })).toBeDisabled();
  });

  it("labels picker options from the user's budgets and catalogues", async () => {
    listBudgets.mockResolvedValue([
      budget({ id: 1, scope: "activity", targetId: 3 }),
      budget({ id: 2, scope: "group", targetId: 2 }),
    ]);
    listActivities.mockResolvedValue([activity({ id: 3, matcher: "firefox" })]);
    listActivityGroups.mockResolvedValue([group({ id: 2, name: "Games" })]);

    render(NotificationsView);
    await selectUser();
    await fireEvent.click(await screen.findByRole("button", { name: "Add override" }));

    // Overall is always offered; the activity/group budgets resolve to names.
    expect(await screen.findByRole("option", { name: "Activity — firefox" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Group — Games" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Overall screen time" })).toBeInTheDocument();
  });

  it("de-duplicates a target's daily and weekly budgets into one option", async () => {
    listBudgets.mockResolvedValue([
      budget({ id: 1, scope: "activity", targetId: 3, window: "daily" }),
      budget({ id: 2, scope: "activity", targetId: 3, window: "weekly" }),
    ]);
    listActivities.mockResolvedValue([activity({ id: 3, matcher: "firefox" })]);

    render(NotificationsView);
    await selectUser();
    await fireEvent.click(await screen.findByRole("button", { name: "Add override" }));
    await screen.findByRole("option", { name: "Activity — firefox" });

    // The cadence key is keyed by target, not window, so the two budgets collapse
    // to a single "activity:3" option.
    const activityOptions = screen
      .getAllByRole("option")
      .filter((option) => (option as HTMLOptionElement).value === "activity:3");
    expect(activityOptions).toHaveLength(1);
  });

  it("loads the selected user's budgets to source the picker", async () => {
    render(NotificationsView);
    await selectUser();

    await waitFor(() => expect(listBudgets).toHaveBeenCalledWith(1));
  });

  it("keeps the editor usable when the budgets load fails (best-effort)", async () => {
    getNotificationPolicy.mockResolvedValue(
      policy({ cadenceOverrides: { "activity:7": { warningMinutes: [10] } } }),
    );
    listBudgets.mockRejectedValue(new ApiError(500, "server_error", "boom"));

    render(NotificationsView);
    await selectUser();

    // The stored override still hydrates a pickable row despite the budgets load
    // failing, and the always-present Overall entry plus the hydrated key remain
    // selectable — the picker degrades gracefully rather than blocking editing.
    const picker = (await screen.findByLabelText("Budget")) as HTMLSelectElement;
    expect(picker.value).toBe("activity:7");
    expect(screen.getByRole("option", { name: "Overall screen time" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Activity 7" })).toBeInTheDocument();
  });

  it("falls back to an id label for a stored group override with no catalogue entry", async () => {
    getNotificationPolicy.mockResolvedValue(
      policy({ cadenceOverrides: { "group:9": { warningMinutes: [5] } } }),
    );

    render(NotificationsView);
    await selectUser();

    const picker = (await screen.findByLabelText("Budget")) as HTMLSelectElement;
    expect(picker.value).toBe("group:9");
    expect(screen.getByRole("option", { name: "Group 9" })).toBeInTheDocument();
  });

  it("removes a hydrated row and saving reverts to the built-in cadence (null)", async () => {
    getNotificationPolicy.mockResolvedValue(
      policy({ cadenceOverrides: { overall: { warningMinutes: [10] } } }),
    );
    upsertNotificationPolicy.mockResolvedValue(policy({ cadenceOverrides: null }));

    render(NotificationsView);
    await selectUser();

    await fireEvent.click(await screen.findByRole("button", { name: "Remove override" }));
    await fireEvent.click(screen.getByRole("button", { name: "Save cadence" }));

    expect(upsertNotificationPolicy).toHaveBeenCalledWith(1, { cadenceOverrides: null });
  });

  it("clears all overrides with an explicit null via Clear all", async () => {
    getNotificationPolicy.mockResolvedValue(
      policy({ cadenceOverrides: { "activity:1": { warningMinutes: [10] } } }),
    );
    upsertNotificationPolicy.mockResolvedValue(policy({ cadenceOverrides: null }));

    render(NotificationsView);
    await selectUser();

    await fireEvent.click(await screen.findByRole("button", { name: "Clear all" }));

    expect(upsertNotificationPolicy).toHaveBeenCalledWith(1, { cadenceOverrides: null });
    expect(
      await screen.findByText("Using the built-in 15/5/1-minute warning cadence for every budget."),
    ).toBeInTheDocument();
  });
});
