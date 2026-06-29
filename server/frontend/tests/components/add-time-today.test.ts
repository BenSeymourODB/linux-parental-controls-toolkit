/**
 * Component test for the "Add time today" lever (#257), now its own
 * `AddTimeToday` component on the Dashboard (UI consolidation — it used to be
 * embedded at the bottom of `LinksView`).
 *
 * Exercises the behaviour the component owns: loading users + clients, picking
 * a target user, the quick +15/+30 and custom-minutes adjustments
 * (minutes → seconds), and rendering the per-client applied/unreachable result.
 * Drives the real component against a mocked `$lib/api` (no live backend),
 * following the established `tests/components/*` pattern.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientResponse, TimeTodayResponse, UserResponse } from "../../src/lib/api/contract.js";

const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const listClients = vi.fn<() => Promise<ClientResponse[]>>();
const adjustTimeToday = vi.fn<(userId: number, input: unknown) => Promise<TimeTodayResponse>>();

vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));
vi.mock("$lib/api/clients", () => ({ listClients: () => listClients() }));
vi.mock("$lib/api/time-today", () => ({
  adjustTimeToday: (userId: number, input: unknown) => adjustTimeToday(userId, input),
}));

const { default: AddTimeToday } = await import("../../src/lib/components/AddTimeToday.svelte");

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 1,
    displayName: "Alice",
    tz: "UTC",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserResponse;
}

function client(overrides: Partial<ClientResponse> = {}): ClientResponse {
  return {
    id: 7,
    hostname: "mint-01",
    sshUser: "pct-agent",
    enrolledAt: "2026-01-01T00:00:00.000Z",
    lastSeen: null,
    enrolled: true,
    platform: "linux",
    ...overrides,
  } as ClientResponse;
}

/** Pick "Alice" in the user dropdown and wait for the adjustment controls. */
async function selectAlice(): Promise<void> {
  await screen.findByRole("option", { name: "Alice" });
  await fireEvent.change(screen.getByLabelText("User"), { target: { value: "1" } });
  await screen.findByRole("button", { name: "+30 min" });
}

beforeEach(() => {
  listUsers.mockReset().mockResolvedValue([user()]);
  listClients.mockReset().mockResolvedValue([client()]);
  adjustTimeToday.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AddTimeToday (#257)", () => {
  it("hides the controls until a user is chosen", async () => {
    render(AddTimeToday);
    // The heading/caveat are always present; the levers are not, until a user
    // is selected.
    await screen.findByRole("option", { name: "Alice" });
    expect(screen.queryByRole("button", { name: "+30 min" })).not.toBeInTheDocument();
  });

  it("sends +30 minutes as a 1800-second delta and renders the per-client result", async () => {
    adjustTimeToday.mockResolvedValue({
      userId: 1,
      operation: "+",
      seconds: 1800,
      results: [{ clientId: 7, osUsername: "alice", status: "applied" }],
    });

    render(AddTimeToday);
    await selectAlice();

    await fireEvent.click(screen.getByRole("button", { name: "+30 min" }));

    await waitFor(() => expect(adjustTimeToday).toHaveBeenCalledWith(1, { deltaSeconds: 1800 }));

    const results = await screen.findByLabelText("Adjustment results");
    expect(within(results).getByText("mint-01")).toBeInTheDocument();
    expect(within(results).getByText("applied")).toBeInTheDocument();
  });

  it("sends a custom minute amount (negative removes time)", async () => {
    adjustTimeToday.mockResolvedValue({
      userId: 1,
      operation: "-",
      seconds: 600,
      results: [{ clientId: 7, osUsername: "alice", status: "applied" }],
    });

    render(AddTimeToday);
    await selectAlice();

    await fireEvent.input(screen.getByLabelText("Custom minutes (negative to remove time)"), {
      target: { value: "-10" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(adjustTimeToday).toHaveBeenCalledWith(1, { deltaSeconds: -600 }));
  });

  it("does not call the API for a zero / empty custom amount", async () => {
    render(AddTimeToday);
    await selectAlice();

    await fireEvent.input(screen.getByLabelText("Custom minutes (negative to remove time)"), {
      target: { value: "0" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(adjustTimeToday).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("non-zero");
  });

  it("surfaces an unreachable client outcome", async () => {
    adjustTimeToday.mockResolvedValue({
      userId: 1,
      operation: "+",
      seconds: 900,
      results: [{ clientId: 7, osUsername: "alice", status: "unreachable", error: "offline" }],
    });

    render(AddTimeToday);
    await selectAlice();

    await fireEvent.click(screen.getByRole("button", { name: "+15 min" }));

    const results = await screen.findByLabelText("Adjustment results");
    expect(within(results).getByText("unreachable")).toBeInTheDocument();
    expect(within(results).getByText("offline")).toBeInTheDocument();
  });

  it("shows an error when the adjustment request fails", async () => {
    adjustTimeToday.mockRejectedValue(new Error("transport unavailable"));

    render(AddTimeToday);
    await selectAlice();

    await fireEvent.click(screen.getByRole("button", { name: "+15 min" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("transport unavailable");
  });
});
