/**
 * Component test for the "Add time today" control on `LinksView` (#257).
 *
 * Exercises the logic this view adds beyond the link CRUD skeleton: picking a
 * user, the quick +15/+30 and custom-minutes adjustments (minutes → seconds),
 * and rendering the per-client applied/unreachable result. Drives the real
 * component against a mocked `$lib/api` (no live backend), following the
 * established `tests/components/*` pattern.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ClientResponse,
  LinkResponse,
  TimeTodayResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const listClients = vi.fn<() => Promise<ClientResponse[]>>();
const listUserLinks = vi.fn<(userId: number) => Promise<LinkResponse[]>>();
const adjustTimeToday = vi.fn<(userId: number, input: unknown) => Promise<TimeTodayResponse>>();

vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));
vi.mock("$lib/api/clients", () => ({ listClients: () => listClients() }));
vi.mock("$lib/api/links", () => ({
  listUserLinks: (userId: number) => listUserLinks(userId),
  upsertLink: vi.fn(),
  deleteLink: vi.fn(),
}));
vi.mock("$lib/api/time-today", () => ({
  adjustTimeToday: (userId: number, input: unknown) => adjustTimeToday(userId, input),
}));

const { default: LinksView } = await import("../../src/lib/views/LinksView.svelte");

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
  return { id: 7, hostname: "mint-01", ...overrides } as ClientResponse;
}

function link(overrides: Partial<LinkResponse> = {}): LinkResponse {
  return { userId: 1, clientId: 7, osUsername: "alice", osUserRef: "1001" } as LinkResponse;
}

/** Pick "Alice" in the user dropdown and wait for her links to load. */
async function selectAlice(): Promise<void> {
  await screen.findByRole("option", { name: "Alice" });
  await fireEvent.change(screen.getByLabelText("User"), { target: { value: "1" } });
  await screen.findByText("Add time today");
}

beforeEach(() => {
  listUsers.mockReset().mockResolvedValue([user()]);
  listClients.mockReset().mockResolvedValue([client()]);
  listUserLinks.mockReset().mockResolvedValue([link()]);
  adjustTimeToday.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LinksView — Add time today (#257)", () => {
  it("sends +30 minutes as a 1800-second delta and renders the per-client result", async () => {
    adjustTimeToday.mockResolvedValue({
      userId: 1,
      operation: "+",
      seconds: 1800,
      results: [{ clientId: 7, osUsername: "alice", status: "applied" }],
    });

    render(LinksView);
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

    render(LinksView);
    await selectAlice();

    await fireEvent.input(screen.getByLabelText("Custom minutes (negative to remove time)"), {
      target: { value: "-10" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(adjustTimeToday).toHaveBeenCalledWith(1, { deltaSeconds: -600 }));
  });

  it("does not call the API for a zero / empty custom amount", async () => {
    render(LinksView);
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

    render(LinksView);
    await selectAlice();

    await fireEvent.click(screen.getByRole("button", { name: "+15 min" }));

    const results = await screen.findByLabelText("Adjustment results");
    expect(within(results).getByText("unreachable")).toBeInTheDocument();
    expect(within(results).getByText("offline")).toBeInTheDocument();
  });

  it("shows an error when the adjustment request fails", async () => {
    adjustTimeToday.mockRejectedValue(new Error("transport unavailable"));

    render(LinksView);
    await selectAlice();

    await fireEvent.click(screen.getByRole("button", { name: "+15 min" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("transport unavailable");
  });
});
