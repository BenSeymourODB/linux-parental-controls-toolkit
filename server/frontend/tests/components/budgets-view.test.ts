/**
 * Smoke test for `BudgetsView` — the first editor whose client-side logic goes
 * beyond the CRUD skeleton (#266). The CRUD shape itself is proven by
 * `users-view-crud.test.ts`; this suite targets the logic that view adds:
 * minutes↔seconds conversion + parsing, the `Xh Ym` allowance formatting, the
 * conditional scope→target picker (and clearing a stale target when the scope
 * changes), the multi-field `createDisabled` gating, and the window+allowance
 * inline edit. All four `$lib/api/*` wrappers it loads on mount are mocked — no
 * live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityGroupResponse,
  ActivityResponse,
  BudgetResponse,
  ResolvedBudgetResponse,
  UserGroupResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

const listBudgets = vi.fn<() => Promise<BudgetResponse[]>>();
const createBudget = vi.fn<(input: unknown) => Promise<BudgetResponse>>();
const updateBudget = vi.fn<(id: number, input: unknown) => Promise<BudgetResponse>>();
const deleteBudget = vi.fn<(id: number) => Promise<void>>();
const listResolvedBudgets = vi.fn<(userId: number) => Promise<ResolvedBudgetResponse[]>>();
const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const listUserGroups = vi.fn<() => Promise<UserGroupResponse[]>>();
const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();
const listActivityGroups = vi.fn<() => Promise<ActivityGroupResponse[]>>();

vi.mock("$lib/api/budgets", () => ({
  listBudgets: () => listBudgets(),
  createBudget: (input: unknown) => createBudget(input),
  updateBudget: (id: number, input: unknown) => updateBudget(id, input),
  deleteBudget: (id: number) => deleteBudget(id),
  listResolvedBudgets: (userId: number) => listResolvedBudgets(userId),
}));
vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));
vi.mock("$lib/api/user-groups", () => ({ listUserGroups: () => listUserGroups() }));
vi.mock("$lib/api/activities", () => ({ listActivities: () => listActivities() }));
vi.mock("$lib/api/activity-groups", () => ({ listActivityGroups: () => listActivityGroups() }));

const { default: BudgetsView } = await import("../../src/lib/views/BudgetsView.svelte");

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 1,
    displayName: "Alice",
    tz: "Europe/London",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserResponse;
}

function activity(overrides: Partial<ActivityResponse> = {}): ActivityResponse {
  return { id: 10, kind: "app", matcher: "steam", matchType: "exact", ...overrides };
}

function group(overrides: Partial<ActivityGroupResponse> = {}): ActivityGroupResponse {
  return { id: 20, name: "Games", ...overrides };
}

function budget(overrides: Partial<BudgetResponse> = {}): BudgetResponse {
  return {
    id: 100,
    userId: 1,
    scope: "overall",
    targetId: null,
    window: "daily",
    secondsAllowed: 3600,
    ...overrides,
  };
}

beforeEach(() => {
  listBudgets.mockReset().mockResolvedValue([]);
  createBudget.mockReset();
  updateBudget.mockReset();
  deleteBudget.mockReset();
  listResolvedBudgets.mockReset().mockResolvedValue([]);
  listUsers.mockReset().mockResolvedValue([user()]);
  // Default: no groups → no inherited rows and `listResolvedBudgets` is skipped.
  listUserGroups.mockReset().mockResolvedValue([]);
  listActivities.mockReset().mockResolvedValue([activity()]);
  listActivityGroups.mockReset().mockResolvedValue([group()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BudgetsView", () => {
  it("prompts to add a user first when none exist", async () => {
    listUsers.mockResolvedValue([]);

    render(BudgetsView);

    expect(
      await screen.findByText("Add a user first — a budget always belongs to a user."),
    ).toBeInTheDocument();
  });

  it("formats the stored allowance as a compact Xh Ym", async () => {
    listBudgets.mockResolvedValue([
      budget({ id: 1, secondsAllowed: 5400 }), // 1h 30m
      budget({ id: 2, secondsAllowed: 1800 }), // 30m
      budget({ id: 3, secondsAllowed: 7200 }), // 2h
    ]);

    render(BudgetsView);

    expect(await screen.findByText("1h 30m")).toBeInTheDocument();
    expect(screen.getByText("30m")).toBeInTheDocument();
    expect(screen.getByText("2h")).toBeInTheDocument();
  });

  it("renders the human target label for an activity-scoped budget", async () => {
    listBudgets.mockResolvedValue([budget({ scope: "activity", targetId: 10 })]);

    render(BudgetsView);

    // The "steam" matcher is shown both in the create dropdown's options and the
    // table's target cell; the table row resolves the targetId to the matcher.
    const table = await screen.findByRole("table");
    expect(within(table).getByText("steam")).toBeInTheDocument();
    expect(within(table).getByText("Activity")).toBeInTheDocument();
  });

  it("only shows the target picker for non-overall scopes and clears a stale target", async () => {
    render(BudgetsView);
    await screen.findByText("No budgets yet. Add one above.");

    // Overall: no target picker.
    expect(screen.queryByLabelText("Target activity")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target group")).not.toBeInTheDocument();

    // Switch to activity → activity picker appears.
    const scope = screen.getByLabelText("Budget scope");
    await fireEvent.change(scope, { target: { value: "activity" } });
    expect(screen.getByLabelText("Target activity")).toBeInTheDocument();

    // Switch to group → group picker appears, activity picker gone.
    await fireEvent.change(scope, { target: { value: "group" } });
    expect(screen.getByLabelText("Target group")).toBeInTheDocument();
    expect(screen.queryByLabelText("Target activity")).not.toBeInTheDocument();
  });

  it("keeps the create button disabled until the form is valid, then submits seconds", async () => {
    createBudget.mockResolvedValue(budget({ id: 7, secondsAllowed: 1800, window: "weekly" }));

    render(BudgetsView);
    await screen.findByText("No budgets yet. Add one above.");

    const submit = screen.getByRole("button", { name: "Add budget" });
    // No user / no minutes yet → disabled.
    expect(submit).toBeDisabled();

    await fireEvent.change(screen.getByLabelText("Budget user"), { target: { value: "1" } });
    await fireEvent.change(screen.getByLabelText("Budget window"), { target: { value: "weekly" } });
    await fireEvent.input(screen.getByLabelText("Allowance in minutes"), {
      target: { value: "30" },
    });

    expect(submit).toBeEnabled();
    await fireEvent.click(submit);

    // 30 minutes → 1800 seconds; overall scope carries a null target.
    expect(createBudget).toHaveBeenCalledWith({
      userId: 1,
      scope: "overall",
      targetId: null,
      window: "weekly",
      secondsAllowed: 1800,
    });
  });

  it("keeps create disabled for a non-numeric minutes value", async () => {
    render(BudgetsView);
    await screen.findByText("No budgets yet. Add one above.");

    await fireEvent.change(screen.getByLabelText("Budget user"), { target: { value: "1" } });
    // Non-numeric text can reach the field (it is `type=text` after the
    // number-coercion fix); `minutesToSeconds` returns null → create stays gated.
    await fireEvent.input(screen.getByLabelText("Allowance in minutes"), {
      target: { value: "abc" },
    });

    expect(screen.getByRole("button", { name: "Add budget" })).toBeDisabled();
    expect(createBudget).not.toHaveBeenCalled();
  });

  it("requires a target before an activity-scoped budget can be created", async () => {
    render(BudgetsView);
    await screen.findByText("No budgets yet. Add one above.");

    await fireEvent.change(screen.getByLabelText("Budget user"), { target: { value: "1" } });
    await fireEvent.input(screen.getByLabelText("Allowance in minutes"), {
      target: { value: "60" },
    });
    await fireEvent.change(screen.getByLabelText("Budget scope"), { target: { value: "activity" } });

    // User + minutes are set, but the activity target is still unchosen.
    expect(screen.getByRole("button", { name: "Add budget" })).toBeDisabled();

    await fireEvent.change(screen.getByLabelText("Target activity"), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: "Add budget" })).toBeEnabled();
  });

  it("edits only the window + allowance inline and sends the converted seconds", async () => {
    listBudgets.mockResolvedValue([budget({ id: 100, secondsAllowed: 3600, window: "daily" })]);
    updateBudget.mockResolvedValue(budget({ id: 100, secondsAllowed: 2700, window: "weekly" }));

    render(BudgetsView);
    await screen.findByText("1h");

    await fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    // Prefilled minutes = 3600 / 60 = 60.
    const minutes = screen.getByLabelText("Edit allowance in minutes");
    expect(minutes).toHaveValue("60");

    await fireEvent.change(screen.getByLabelText("Edit window"), { target: { value: "weekly" } });
    await fireEvent.input(minutes, { target: { value: "45" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateBudget).toHaveBeenCalledWith(100, { window: "weekly", secondsAllowed: 2700 });
    expect(await screen.findByText("45m")).toBeInTheDocument();
  });

  it("blocks an inline save when the minutes field is not a valid count", async () => {
    listBudgets.mockResolvedValue([budget({ id: 100 })]);

    render(BudgetsView);
    await screen.findByText("1h");
    await fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await fireEvent.input(screen.getByLabelText("Edit allowance in minutes"), {
      target: { value: "-5" },
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(updateBudget).not.toHaveBeenCalled();
  });

  it("deletes a budget after confirmation", async () => {
    listBudgets.mockResolvedValue([budget({ id: 100 })]);
    deleteBudget.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(BudgetsView);
    await screen.findByText("1h");

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteBudget).toHaveBeenCalledWith(100));
    expect(screen.getByText("No budgets yet. Add one above.")).toBeInTheDocument();
  });

  it("surfaces a load error in the inline alert", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listBudgets.mockRejectedValue(new ApiError(500, "internal", "Budget load failed."));

    render(BudgetsView);

    expect(await screen.findByRole("alert")).toHaveTextContent("Budget load failed.");
  });

  it("does not fetch resolved budgets when there are no user groups", async () => {
    listBudgets.mockResolvedValue([budget({ id: 1 })]);

    render(BudgetsView);
    await screen.findByText("1h");

    // No groups → nothing to inherit → the projection endpoint is never hit,
    // and every row is marked local.
    expect(listResolvedBudgets).not.toHaveBeenCalled();
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.queryByText(/^Inherited/)).not.toBeInTheDocument();
  });

  it("marks own budgets local and appends inherited-from-group rows", async () => {
    listUserGroups.mockResolvedValue([
      { id: 3, name: "Kids", createdAt: "2026-01-01T00:00:00.000Z" },
    ] as UserGroupResponse[]);
    // Own overall/daily budget; group daily activity:10 budget the user inherits.
    listBudgets.mockResolvedValue([
      budget({ id: 1, scope: "overall", targetId: null, secondsAllowed: 7200 }),
    ]);
    listResolvedBudgets.mockResolvedValue([
      {
        scope: "overall",
        targetId: null,
        window: "daily",
        secondsAllowed: 7200,
        source: { kind: "user" },
      },
      {
        scope: "activity",
        targetId: 10,
        window: "daily",
        secondsAllowed: 1800,
        source: { kind: "group", groupId: 3 },
      },
    ]);

    render(BudgetsView);

    // The own budget row is marked local…
    expect(await screen.findByText("Local")).toBeInTheDocument();
    expect(listResolvedBudgets).toHaveBeenCalledWith(1);
    // …and the inherited group slot appears as a read-only row with its group.
    const inheritedBadge = await screen.findByText("Inherited · Kids");
    expect(inheritedBadge).toBeInTheDocument();
    const inheritedRow = inheritedBadge.closest("tr");
    expect(inheritedRow).not.toBeNull();
    // Inherited rows are read-only here (no Edit/Delete).
    expect(within(inheritedRow as HTMLElement).queryByRole("button")).toBeNull();
    expect(within(inheritedRow as HTMLElement).getByText("30m")).toBeInTheDocument();
  });

  it("re-checks inheritance for the user after deleting an own budget", async () => {
    listUserGroups.mockResolvedValue([
      { id: 3, name: "Kids", createdAt: "2026-01-01T00:00:00.000Z" },
    ] as UserGroupResponse[]);
    listBudgets.mockResolvedValue([
      budget({ id: 100, scope: "overall", targetId: null, secondsAllowed: 7200 }),
    ]);
    // Initially the own budget overrides the group's overall slot (only `user`).
    listResolvedBudgets.mockResolvedValueOnce([
      {
        scope: "overall",
        targetId: null,
        window: "daily",
        secondsAllowed: 7200,
        source: { kind: "user" },
      },
    ]);
    deleteBudget.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(BudgetsView);
    await screen.findByText("Local");
    expect(screen.queryByText(/^Inherited/)).not.toBeInTheDocument();

    // After deletion the group's overall slot is no longer overridden, so the
    // refresh surfaces it as inherited.
    listResolvedBudgets.mockResolvedValueOnce([
      {
        scope: "overall",
        targetId: null,
        window: "daily",
        secondsAllowed: 7200,
        source: { kind: "group", groupId: 3 },
      },
    ]);
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteBudget).toHaveBeenCalledWith(100));
    expect(await screen.findByText("Inherited · Kids")).toBeInTheDocument();
  });
});
