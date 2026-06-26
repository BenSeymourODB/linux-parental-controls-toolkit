/**
 * Inventory CRUD smoke test for `ClientsView` (#53 follow-through, merged
 * surface #305).
 *
 * `ClientsView` keeps the canonical inline edit + delete editor (plus the shared
 * `role="alert"` surface), now over a card-based merged view that joins
 * inventory with health. Adding a client is done through the enrol-token flow
 * (covered by `clients-view-health.test.ts`); the manual `POST /api/clients`
 * create is deliberately off the admin surface (#305), so there is no create
 * form here. `$app/environment` is mocked so `browser` is true (the view guards
 * its fetches on it); the `$lib/api/*` wrappers are mocked — no live backend.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ClientResponse,
  ClientHealthResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

vi.mock("$app/environment", () => ({ browser: true }));

const listClients = vi.fn<() => Promise<ClientResponse[]>>();
const updateClient = vi.fn<(id: number, input: unknown) => Promise<ClientResponse>>();
const deleteClient = vi.fn<(id: number) => Promise<void>>();
const mintEnrolmentToken = vi.fn<(input: unknown) => Promise<unknown>>();
const listClientHealth = vi.fn<() => Promise<ClientHealthResponse[]>>();
const listUsers = vi.fn<() => Promise<UserResponse[]>>();

vi.mock("$lib/api/clients", () => ({
  listClients: () => listClients(),
  updateClient: (id: number, input: unknown) => updateClient(id, input),
  deleteClient: (id: number) => deleteClient(id),
  mintEnrolmentToken: (input: unknown) => mintEnrolmentToken(input),
}));
vi.mock("$lib/api/client-health", () => ({ listClientHealth: () => listClientHealth() }));
vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));

const { default: ClientsView } = await import("../../src/lib/views/ClientsView.svelte");

function client(overrides: Partial<ClientResponse> = {}): ClientResponse {
  return {
    id: 1,
    hostname: "mint-01",
    sshUser: "pct-agent",
    enrolledAt: "2026-01-01T00:00:00.000Z",
    lastSeen: null,
    enrolled: true,
    platform: "linux",
    ...overrides,
  } as ClientResponse;
}

beforeEach(() => {
  listClients.mockReset();
  updateClient.mockReset();
  deleteClient.mockReset();
  mintEnrolmentToken.mockReset();
  listClientHealth.mockReset().mockResolvedValue([]);
  listUsers.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClientsView inventory CRUD", () => {
  it("renders the rows returned by the API", async () => {
    listClients.mockResolvedValue([client({ id: 1, hostname: "mint-01" })]);

    render(ClientsView);

    expect(await screen.findByText("mint-01")).toBeInTheDocument();
    expect(listClients).toHaveBeenCalledOnce();
  });

  it("flags a manually-created client as not enrolled", async () => {
    listClients.mockResolvedValue([client({ id: 1, hostname: "mint-manual", enrolled: false })]);

    render(ClientsView);

    await screen.findByText("mint-manual");
    expect(screen.getByText("manual · not enrolled")).toBeInTheDocument();
  });

  it("shows the empty state when there are no clients", async () => {
    listClients.mockResolvedValue([]);

    render(ClientsView);

    expect(await screen.findByText("No clients yet. Enrol one below.")).toBeInTheDocument();
  });

  it("saves an inline edit and replaces the card", async () => {
    listClients.mockResolvedValue([client({ id: 1, hostname: "mint-01" })]);
    updateClient.mockResolvedValue(client({ id: 1, hostname: "mint-renamed" }));

    render(ClientsView);
    await screen.findByText("mint-01");

    await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await fireEvent.input(screen.getByLabelText("Edit hostname"), {
      target: { value: "mint-renamed" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("mint-renamed")).toBeInTheDocument();
    expect(updateClient).toHaveBeenCalledWith(1, { hostname: "mint-renamed", sshUser: "pct-agent" });
  });

  it("deletes a client after confirmation and drops the card", async () => {
    listClients.mockResolvedValue([client({ id: 1, hostname: "mint-01" })]);
    deleteClient.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(ClientsView);
    await screen.findByText("mint-01");

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("mint-01")).not.toBeInTheDocument());
    expect(deleteClient).toHaveBeenCalledWith(1);
  });

  it("does not delete when the confirmation is declined", async () => {
    listClients.mockResolvedValue([client({ id: 1, hostname: "mint-01" })]);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(ClientsView);
    await screen.findByText("mint-01");

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleteClient).not.toHaveBeenCalled();
    expect(screen.getByText("mint-01")).toBeInTheDocument();
  });

  it("surfaces an ApiError from the list load in the inline alert", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listClients.mockRejectedValue(new ApiError(500, "internal", "The server exploded."));

    render(ClientsView);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The server exploded.");
  });
});
