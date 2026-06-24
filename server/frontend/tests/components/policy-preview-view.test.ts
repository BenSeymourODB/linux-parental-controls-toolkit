/**
 * Smoke test for `PolicyPreviewView` (#281) — the save-and-push preview surface.
 *
 * Covers the logic the view owns on top of the CRUD skeleton: loading a user's
 * persisted budgets + schedules into the what-if sandbox, building the proposed
 * payload from the admin's edits (overall-minute changes, budget/schedule
 * include toggles), and rendering the push bar (change rows + affected clients,
 * the no-changes state, and the preview-error state). All four `$lib/api/*`
 * wrappers it loads are mocked — no live backend.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BudgetResponse,
  PolicyPreviewResponse,
  ScheduleResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const listBudgets = vi.fn<(userId?: number) => Promise<BudgetResponse[]>>();
const listSchedules = vi.fn<(userId?: number) => Promise<ScheduleResponse[]>>();
const previewPolicyPush =
  vi.fn<(userId: number, body: unknown) => Promise<PolicyPreviewResponse>>();

vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));
vi.mock("$lib/api/budgets", () => ({ listBudgets: (userId?: number) => listBudgets(userId) }));
vi.mock("$lib/api/schedules", () => ({
  listSchedules: (userId?: number) => listSchedules(userId),
}));
vi.mock("$lib/api/policy-preview", () => ({
  previewPolicyPush: (userId: number, body: unknown) => previewPolicyPush(userId, body),
}));

const { default: PolicyPreviewView } = await import(
  "../../src/lib/views/PolicyPreviewView.svelte"
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

function budget(overrides: Partial<BudgetResponse> = {}): BudgetResponse {
  return {
    id: 100,
    userId: 1,
    scope: "overall",
    targetId: null,
    window: "daily",
    secondsAllowed: 7200,
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleResponse> = {}): ScheduleResponse {
  return {
    id: 500,
    userId: 1,
    targetKind: "overall",
    targetId: null,
    action: "deny",
    recurrenceDays: 0b0011111, // Mon–Fri
    recurrenceStartMinute: 480,
    recurrenceEndMinute: 900,
    effectiveFrom: null,
    effectiveTo: null,
    ordinal: 0,
    ...overrides,
  };
}

function previewResponse(overrides: Partial<PolicyPreviewResponse> = {}): PolicyPreviewResponse {
  return {
    userId: 1,
    hasChanges: true,
    changes: [
      {
        field: "daily-overall",
        kind: "changed",
        weekday: null,
        before: "2h",
        after: "2h 30m",
        summary: "Daily overall limit: 2h → 2h 30m",
      },
    ],
    affectedClients: [
      { clientId: 3, hostname: "mint-livingroom", lastSeen: null, pendingQueueDepth: 2 },
    ],
    ...overrides,
  };
}

async function selectUser(id = 1): Promise<void> {
  await fireEvent.change(await screen.findByLabelText("User"), { target: { value: String(id) } });
}

beforeEach(() => {
  listUsers.mockReset().mockResolvedValue([user()]);
  listBudgets.mockReset().mockResolvedValue([budget()]);
  listSchedules.mockReset().mockResolvedValue([schedule()]);
  previewPolicyPush.mockReset().mockResolvedValue(previewResponse());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PolicyPreviewView", () => {
  it("prompts to add a user first when none exist", async () => {
    listUsers.mockResolvedValue([]);

    render(PolicyPreviewView);

    expect(
      await screen.findByText("Add a user first — a preview is always for one user's policy."),
    ).toBeInTheDocument();
  });

  it("loads a user's policy and renders the change set + affected clients", async () => {
    render(PolicyPreviewView);
    await selectUser();

    expect(await screen.findByText("Daily overall limit: 2h → 2h 30m")).toBeInTheDocument();
    expect(screen.getByText("1 change for Alice")).toBeInTheDocument();
    expect(screen.getByText("mint-livingroom")).toBeInTheDocument();
    expect(screen.getByText("2 queued actions")).toBeInTheDocument();
    expect(screen.getByText("never seen")).toBeInTheDocument();

    // The proposed payload mirrors the loaded baseline on first preview.
    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalled());
    const [userId, body] = previewPolicyPush.mock.calls.at(-1)!;
    expect(userId).toBe(1);
    expect((body as { budgets: BudgetResponse[] }).budgets).toHaveLength(1);
    expect((body as { schedules: ScheduleResponse[] }).schedules).toHaveLength(1);
  });

  it("renders the no-changes state when the push would be a no-op", async () => {
    previewPolicyPush.mockResolvedValue(previewResponse({ hasChanges: false, changes: [] }));

    render(PolicyPreviewView);
    await selectUser();

    expect(await screen.findByTestId("no-changes")).toBeInTheDocument();
  });

  it("excludes a schedule from the proposed payload when toggled off", async () => {
    render(PolicyPreviewView);
    await selectUser();
    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalled());

    await fireEvent.click(screen.getByLabelText("Include schedule rule 500"));

    await waitFor(() => {
      const last = previewPolicyPush.mock.calls.at(-1)!;
      expect((last[1] as { schedules: ScheduleResponse[] }).schedules).toHaveLength(0);
    });
  });

  it("re-previews with the edited overall minutes", async () => {
    render(PolicyPreviewView);
    await selectUser();
    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalled());

    await fireEvent.input(screen.getByLabelText("Daily overall minutes"), {
      target: { value: "150" },
    });

    await waitFor(() => {
      const last = previewPolicyPush.mock.calls.at(-1)!;
      const budgets = (last[1] as { budgets: BudgetResponse[] }).budgets;
      expect(budgets[0]!.secondsAllowed).toBe(150 * 60);
    });
  });

  it("drops an overall budget from the payload when its include toggle is cleared", async () => {
    render(PolicyPreviewView);
    await selectUser();
    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalled());

    await fireEvent.click(screen.getByLabelText("Include Daily overall budget"));

    await waitFor(() => {
      const last = previewPolicyPush.mock.calls.at(-1)!;
      expect((last[1] as { budgets: BudgetResponse[] }).budgets).toHaveLength(0);
    });
  });

  it("surfaces a preview failure in the push bar", async () => {
    previewPolicyPush.mockRejectedValue(new Error("preview blew up"));

    render(PolicyPreviewView);
    await selectUser();

    expect(await screen.findByText("preview blew up")).toBeInTheDocument();
  });

  it("surfaces a user-load failure", async () => {
    listUsers.mockRejectedValue(new Error("users load failed"));

    render(PolicyPreviewView);

    expect(await screen.findByRole("alert")).toHaveTextContent("users load failed");
  });
});
