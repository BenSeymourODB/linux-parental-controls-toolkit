/**
 * CRUD smoke test for `ClientsView` (#53 follow-through).
 *
 * `ClientsView` repeats the canonical `UsersView` editor pattern verbatim
 * (list → create → inline edit → delete + the shared `role="alert"` surface),
 * just over a two-field record. This test confirms the pattern generalises to
 * the clone editor; the logic-heavy editors (Budgets, Schedules, Exceptions,
 * Activity Groups, Client Health, Audit Log, Links) are covered by their own
 * follow-up issue. Runs against a mocked `$lib/api/clients` — no live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientResponse } from "../../src/lib/api/contract.js";

const listClients = vi.fn<() => Promise<ClientResponse[]>>();
const createClient = vi.fn<(input: unknown) => Promise<ClientResponse>>();
const updateClient = vi.fn<(id: number, input: unknown) => Promise<ClientResponse>>();
const deleteClient = vi.fn<(id: number) => Promise<void>>();

vi.mock("$lib/api/clients", () => ({
  listClients: () => listClients(),
  createClient: (input: unknown) => createClient(input),
  updateClient: (id: number, input: unknown) => updateClient(id, input),
  deleteClient: (id: number) => deleteClient(id),
}));

const { default: ClientsView } = await import("../../src/lib/views/ClientsView.svelte");

function client(overrides: Partial<ClientResponse> = {}): ClientResponse {
  return {
    id: 1,
    hostname: "mint-01",
    sshUser: "pct-agent",
    enrolledAt: "2026-01-01T00:00:00.000Z",
    lastSeen: null,
    ...overrides,
  } as ClientResponse;
}

beforeEach(() => {
  listClients.mockReset();
  createClient.mockReset();
  updateClient.mockReset();
  deleteClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClientsView CRUD", () => {
  it("renders the rows returned by the API", async () => {
    listClients.mockResolvedValue([client({ id: 1, hostname: "mint-01" })]);

    render(ClientsView);

    expect(await screen.findByText("mint-01")).toBeInTheDocument();
    expect(listClients).toHaveBeenCalledOnce();
  });

  it("shows the empty state when there are no clients", async () => {
    listClients.mockResolvedValue([]);

    render(ClientsView);

    expect(await screen.findByText("No clients yet. Add one above.")).toBeInTheDocument();
  });

  it("creates a client and appends the new row", async () => {
    listClients.mockResolvedValue([]);
    createClient.mockResolvedValue(client({ id: 7, hostname: "mint-07", sshUser: "pct-agent" }));

    render(ClientsView);
    await screen.findByText("No clients yet. Add one above.");

    await fireEvent.input(screen.getByLabelText("New client hostname"), {
      target: { value: "mint-07" },
    });
    await fireEvent.input(screen.getByLabelText("New client SSH user"), {
      target: { value: "pct-agent" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add client" }));

    expect(await screen.findByText("mint-07")).toBeInTheDocument();
    expect(createClient).toHaveBeenCalledWith({ hostname: "mint-07", sshUser: "pct-agent" });
  });

  it("saves an inline edit and replaces the row", async () => {
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

  it("deletes a client after confirmation and drops the row", async () => {
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

  it("keeps a create error inline without losing the existing rows", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listClients.mockResolvedValue([client({ id: 1, hostname: "mint-01" })]);
    createClient.mockRejectedValue(new ApiError(409, "conflict", "That hostname is taken."));

    render(ClientsView);
    await screen.findByText("mint-01");

    await fireEvent.input(screen.getByLabelText("New client hostname"), {
      target: { value: "mint-01" },
    });
    await fireEvent.input(screen.getByLabelText("New client SSH user"), {
      target: { value: "pct-agent" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add client" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That hostname is taken.");
    const table = screen.getByRole("table");
    expect(within(table).getByText("mint-01")).toBeInTheDocument();
  });
});
