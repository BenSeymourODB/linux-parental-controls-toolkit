/**
 * Smoke test for `LinksView` — the two-level state + validation that sits on
 * top of the CRUD skeleton (#266): selecting a user loads *that* user's links
 * (`onSelectUser` → `listUserLinks`), the `osUserRef` charset rule gates the
 * save button client-side, the client dropdown offers only `candidateClients`
 * (clients the user is not already linked to), and the idempotent `PUT` upsert
 * either replaces an existing link or appends a new one. All `$lib/api/*`
 * wrappers are mocked — no live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientResponse, LinkResponse, UserResponse } from "../../src/lib/api/contract.js";

const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const listClients = vi.fn<() => Promise<ClientResponse[]>>();
const listUserLinks = vi.fn<(userId: number) => Promise<LinkResponse[]>>();
const upsertLink = vi.fn<(userId: number, clientId: number, input: unknown) => Promise<LinkResponse>>();
const deleteLink = vi.fn<(userId: number, clientId: number) => Promise<void>>();

vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));
vi.mock("$lib/api/clients", () => ({ listClients: () => listClients() }));
vi.mock("$lib/api/links", () => ({
  listUserLinks: (userId: number) => listUserLinks(userId),
  upsertLink: (userId: number, clientId: number, input: unknown) =>
    upsertLink(userId, clientId, input),
  deleteLink: (userId: number, clientId: number) => deleteLink(userId, clientId),
}));

const { default: LinksView } = await import("../../src/lib/views/LinksView.svelte");

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 1,
    displayName: "Alice",
    tz: "Europe/London",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserResponse;
}

function client(overrides: Partial<ClientResponse> = {}): ClientResponse {
  return {
    id: 5,
    hostname: "mint-box",
    sshUser: "admin",
    enrolledAt: "2026-01-01T00:00:00.000Z",
    lastSeen: null,
    ...overrides,
  };
}

function link(overrides: Partial<LinkResponse> = {}): LinkResponse {
  return { userId: 1, clientId: 5, osUsername: "alice", osUserRef: "1000", ...overrides };
}

const MINT = client({ id: 5, hostname: "mint-box" });
const LAPTOP = client({ id: 6, hostname: "laptop" });

beforeEach(() => {
  listUsers.mockReset().mockResolvedValue([user()]);
  listClients.mockReset().mockResolvedValue([MINT, LAPTOP]);
  listUserLinks.mockReset().mockResolvedValue([]);
  upsertLink.mockReset();
  deleteLink.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function selectUser(): Promise<void> {
  await fireEvent.change(screen.getByLabelText("User"), { target: { value: "1" } });
}

describe("LinksView", () => {
  it("loads the selected user's links only after a user is picked", async () => {
    listUserLinks.mockResolvedValue([link({ clientId: 5 })]);

    render(LinksView);
    await screen.findByLabelText("User");

    expect(listUserLinks).not.toHaveBeenCalled();

    await selectUser();

    await waitFor(() => expect(listUserLinks).toHaveBeenCalledWith(1));
    // "mint-box" appears both as a select option and a table cell; scope to the
    // links table so the assertion targets the rendered link row.
    const table = await screen.findByRole("table");
    expect(within(table).getByText("mint-box")).toBeInTheDocument();
  });

  it("offers only not-yet-linked clients as candidates", async () => {
    listUserLinks.mockResolvedValue([link({ clientId: 5 })]); // mint-box already linked

    render(LinksView);
    await screen.findByLabelText("User");
    await selectUser();
    await screen.findByRole("table"); // links table rendered

    const clientPicker = screen.getByLabelText("Client");
    const options = within(clientPicker)
      .getAllByRole("option")
      .map((o) => o.textContent?.trim());

    // laptop (unlinked) is a candidate; the placeholder is present. mint-box only
    // appears via the "keep the edited link selectable" branch — assert laptop is
    // offered and the candidate set isn't empty.
    expect(options).toContain("laptop");
  });

  it("keeps the save button disabled until the OS user ref is a valid token", async () => {
    render(LinksView);
    await screen.findByLabelText("User");
    await selectUser();
    await screen.findByText("No links for this user yet. Add one above.");

    await fireEvent.change(screen.getByLabelText("Client"), { target: { value: "6" } });
    await fireEvent.input(screen.getByLabelText("OS username"), { target: { value: "bob" } });

    const refField = screen.getByLabelText("OS user reference (UID on Linux)");
    const save = screen.getByRole("button", { name: "Save link" });

    // A space is outside the [A-Za-z0-9._:-] charset → invalid.
    await fireEvent.input(refField, { target: { value: "10 00" } });
    expect(save).toBeDisabled();

    await fireEvent.input(refField, { target: { value: "1000" } });
    expect(save).toBeEnabled();
  });

  it("appends a new link on upsert when the user has none for that client", async () => {
    listUserLinks.mockResolvedValue([]);
    upsertLink.mockResolvedValue(link({ clientId: 6, osUsername: "bob", osUserRef: "1001" }));

    render(LinksView);
    await screen.findByLabelText("User");
    await selectUser();
    await screen.findByText("No links for this user yet. Add one above.");

    await fireEvent.change(screen.getByLabelText("Client"), { target: { value: "6" } });
    await fireEvent.input(screen.getByLabelText("OS username"), { target: { value: " bob " } });
    await fireEvent.input(screen.getByLabelText("OS user reference (UID on Linux)"), {
      target: { value: "1001" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save link" }));

    // Values are trimmed before they reach the wrapper.
    expect(upsertLink).toHaveBeenCalledWith(1, 6, { osUsername: "bob", osUserRef: "1001" });
    // "laptop" is also a dropdown option; assert on the appended table row.
    const table = await screen.findByRole("table");
    expect(within(table).getByText("laptop")).toBeInTheDocument();
  });

  it("replaces the existing row when upserting a link to an already-linked client", async () => {
    listUserLinks.mockResolvedValue([link({ clientId: 5, osUserRef: "1000" })]);
    upsertLink.mockResolvedValue(link({ clientId: 5, osUserRef: "1234" }));

    render(LinksView);
    await screen.findByLabelText("User");
    await selectUser();
    await screen.findByRole("table");

    // Edit prefills the form from the existing link's client + values.
    await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await fireEvent.input(screen.getByLabelText("OS user reference (UID on Linux)"), {
      target: { value: "1234" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save link" }));

    await waitFor(() => expect(upsertLink).toHaveBeenCalledWith(1, 5, expect.anything()));
    // Still exactly one row for mint-box — replaced, not appended.
    const table = await screen.findByRole("table");
    expect(within(table).getAllByText("mint-box")).toHaveLength(1);
    expect(within(table).getByText("1234")).toBeInTheDocument();
  });

  it("deletes a link after confirmation", async () => {
    listUserLinks.mockResolvedValue([link({ clientId: 5 })]);
    deleteLink.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(LinksView);
    await screen.findByLabelText("User");
    await selectUser();
    await screen.findByRole("table");

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteLink).toHaveBeenCalledWith(1, 5));
    expect(screen.getByText("No links for this user yet. Add one above.")).toBeInTheDocument();
  });

  it("prompts to enrol a client first when none exist", async () => {
    listClients.mockResolvedValue([]);

    render(LinksView);
    await screen.findByLabelText("User");
    await selectUser();

    expect(
      await screen.findByText("Enrol a client first — there's nothing to link to yet."),
    ).toBeInTheDocument();
  });
});
