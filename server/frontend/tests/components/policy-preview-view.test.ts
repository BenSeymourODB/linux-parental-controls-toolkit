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
  PolicyPreviewRequest,
  PolicyPreviewResponse,
  ScheduleResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const listBudgets = vi.fn<(userId?: number) => Promise<BudgetResponse[]>>();
const listSchedules = vi.fn<(userId?: number) => Promise<ScheduleResponse[]>>();
const previewPolicyPush =
  vi.fn<(userId: number, body: PolicyPreviewRequest) => Promise<PolicyPreviewResponse>>();

/** The proposed payload from the most recent `previewPolicyPush` call. */
function lastProposed(): PolicyPreviewRequest {
  return previewPolicyPush.mock.calls.at(-1)![1];
}

vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));
vi.mock("$lib/api/budgets", () => ({ listBudgets: (userId?: number) => listBudgets(userId) }));
vi.mock("$lib/api/schedules", () => ({
  listSchedules: (userId?: number) => listSchedules(userId),
}));
vi.mock("$lib/api/policy-preview", () => ({
  previewPolicyPush: (userId: number, body: PolicyPreviewRequest) =>
    previewPolicyPush(userId, body),
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
      {
        clientId: 3,
        hostname: "mint-livingroom",
        lastSeen: null,
        pendingQueueDepth: 2,
        reachability: null,
        probedAt: null,
      },
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
    expect(previewPolicyPush.mock.calls.at(-1)![0]).toBe(1);
    expect(lastProposed().budgets).toHaveLength(1);
    expect(lastProposed().schedules).toHaveLength(1);
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

    await fireEvent.click(screen.getByLabelText(/^Include .*schedule rule:/));

    await waitFor(() => expect(lastProposed().schedules).toHaveLength(0));
  });

  it("renders the no-clients empty state when the user has no linked clients", async () => {
    previewPolicyPush.mockResolvedValue(previewResponse({ affectedClients: [] }));

    render(PolicyPreviewView);
    await selectUser();

    expect(await screen.findByText("0 clients affected")).toBeInTheDocument();
    expect(
      screen.getByText("No clients linked — nothing to push to yet."),
    ).toBeInTheDocument();
  });

  it("re-previews with the edited overall minutes", async () => {
    render(PolicyPreviewView);
    await selectUser();
    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalled());

    await fireEvent.input(screen.getByLabelText("Daily overall minutes"), {
      target: { value: "150" },
    });

    await waitFor(() => expect(lastProposed().budgets[0]!.secondsAllowed).toBe(150 * 60));
  });

  it("falls back to the persisted seconds when the minutes field is empty or non-integer", async () => {
    render(PolicyPreviewView);
    await selectUser();
    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalled());
    const minutes = screen.getByLabelText("Daily overall minutes");

    // Cleared field → keep the baseline 7200s, NOT a real "0 minutes" limit.
    await fireEvent.input(minutes, { target: { value: "" } });
    await waitFor(() => expect(lastProposed().budgets[0]!.secondsAllowed).toBe(7200));

    // Non-integer → also falls back rather than emitting a bogus limit.
    await fireEvent.input(minutes, { target: { value: "1.5" } });
    await waitFor(() => expect(lastProposed().budgets[0]!.secondsAllowed).toBe(7200));
  });

  it("collapses a burst of edits into a single trailing preview (debounce)", async () => {
    render(PolicyPreviewView);
    await selectUser();
    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalledTimes(1));
    const minutes = screen.getByLabelText("Daily overall minutes");

    // Three rapid edits within the debounce window → one more request, not three.
    await fireEvent.input(minutes, { target: { value: "30" } });
    await fireEvent.input(minutes, { target: { value: "31" } });
    await fireEvent.input(minutes, { target: { value: "32" } });

    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalledTimes(2));
    expect(lastProposed().budgets[0]!.secondsAllowed).toBe(32 * 60);
    // Give any erroneously-scheduled extra timers a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(previewPolicyPush).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale (out-of-order) preview response and keeps the newest", async () => {
    // Hand-controlled promises so we can resolve the OLDER request last.
    const resolvers: Array<(value: PolicyPreviewResponse) => void> = [];
    previewPolicyPush.mockImplementation(
      () => new Promise<PolicyPreviewResponse>((resolve) => resolvers.push(resolve)),
    );

    render(PolicyPreviewView);
    await selectUser();
    await waitFor(() => expect(resolvers).toHaveLength(1)); // initial load preview
    const minutes = screen.getByLabelText("Daily overall minutes");

    await fireEvent.input(minutes, { target: { value: "60" } });
    await waitFor(() => expect(resolvers).toHaveLength(2)); // request A
    await fireEvent.input(minutes, { target: { value: "90" } });
    await waitFor(() => expect(resolvers).toHaveLength(3)); // request B (newest)

    const stale = previewResponse({
      changes: [{ ...previewResponse().changes[0]!, summary: "STALE — should not win" }],
    });
    const newest = previewResponse({
      changes: [{ ...previewResponse().changes[0]!, summary: "NEWEST — should win" }],
    });
    // Resolve the NEWEST (B) first, then the older A — A must not overwrite B.
    resolvers[2]!(newest);
    await screen.findByText("NEWEST — should win");
    resolvers[1]!(stale);
    resolvers[0]!(previewResponse());

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText("NEWEST — should win")).toBeInTheDocument();
    expect(screen.queryByText("STALE — should not win")).not.toBeInTheDocument();
  });

  it("drops an overall budget from the payload when its include toggle is cleared", async () => {
    render(PolicyPreviewView);
    await selectUser();
    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalled());

    await fireEvent.click(screen.getByLabelText("Include Daily overall budget"));

    await waitFor(() => expect(lastProposed().budgets).toHaveLength(0));
  });

  it("keeps the auto-preview probe-free (no live SSH on every edit)", async () => {
    render(PolicyPreviewView);
    await selectUser();

    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalled());
    // The cheap on-load / on-edit preview never opts into the probe.
    expect(lastProposed().probe).toBeUndefined();
    // …and with no probe, no reachability marker is rendered.
    expect(screen.queryByTestId("reachability-3")).not.toBeInTheDocument();
  });

  it("probes live reachability on demand and renders per-client markers", async () => {
    previewPolicyPush.mockResolvedValue(
      previewResponse({
        affectedClients: [
          {
            clientId: 3,
            hostname: "mint-livingroom",
            lastSeen: "2026-06-17T12:00:05.000Z",
            pendingQueueDepth: 2,
            reachability: "online",
            probedAt: "2026-06-17T12:00:05.000Z",
          },
        ],
      }),
    );
    render(PolicyPreviewView);
    await selectUser();
    await waitFor(() => expect(previewPolicyPush).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole("button", { name: "Check live status" }));

    // The button re-requests with the opt-in probe flag …
    await waitFor(() => expect(lastProposed().probe).toBe(true));
    // … and the returned verdict renders as a per-client marker.
    expect(await screen.findByTestId("reachability-3")).toHaveTextContent("online");
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
