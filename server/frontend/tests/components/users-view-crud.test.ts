/**
 * End-to-end smoke test for one CRUD editor (#53's last acceptance box).
 *
 * `UsersView` is the canonical editor — the shape every deferred editor
 * (clients, activities/groups, budgets, schedules) repeats — so proving it
 * mount → list → create → inline-edit → delete against a mocked
 * `$lib/api/users` (no live backend) covers the shared pattern. The final case
 * exercises the inline error surface (`role="alert"`) that every view shares.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserResponse } from "../../src/lib/api/contract.js";
import { resetResources } from "../../src/lib/data/resources.svelte.js";

const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const createUser = vi.fn<(input: unknown) => Promise<UserResponse>>();
const updateUser = vi.fn<(id: number, input: unknown) => Promise<UserResponse>>();
const deleteUser = vi.fn<(id: number) => Promise<void>>();

vi.mock("$lib/api/users", () => ({
  listUsers: () => listUsers(),
  createUser: (input: unknown) => createUser(input),
  updateUser: (id: number, input: unknown) => updateUser(id, input),
  deleteUser: (id: number) => deleteUser(id),
}));

// UsersView now composes `UserGroupsView` as a second section (UI
// consolidation). That child fetches user groups on mount; stub its API to a
// quiet empty state so it doesn't reach for a live backend. The shared user
// list is read through `usersResource` by both sections, so a single load
// (and a single error surface) is shared between them.
vi.mock("$lib/api/user-groups", () => ({
  listUserGroups: () => Promise.resolve([]),
  createUserGroup: vi.fn(),
  updateUserGroup: vi.fn(),
  deleteUserGroup: vi.fn(),
  listGroupMembers: vi.fn(),
  addUserToGroup: vi.fn(),
  removeUserFromGroup: vi.fn(),
}));

const { default: UsersView } = await import("../../src/lib/views/UsersView.svelte");

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 1,
    displayName: "Alice",
    tz: "Europe/London",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserResponse;
}

beforeEach(() => {
  resetResources();
  listUsers.mockReset();
  createUser.mockReset();
  updateUser.mockReset();
  deleteUser.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UsersView CRUD", () => {
  it("renders the rows returned by the API", async () => {
    listUsers.mockResolvedValue([user({ id: 1, displayName: "Alice" })]);

    render(UsersView);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    // The view and the embedded UserGroupsView both read the shared
    // `usersResource`, whose concurrent loads coalesce onto one request — so the
    // underlying wrapper is hit exactly once despite two consumers.
    expect(listUsers).toHaveBeenCalledOnce();
  });

  it("shows the empty state when there are no users", async () => {
    listUsers.mockResolvedValue([]);

    render(UsersView);

    expect(await screen.findByText("No users yet. Add one above.")).toBeInTheDocument();
  });

  it("creates a user and appends the new row", async () => {
    listUsers.mockResolvedValue([]);
    createUser.mockResolvedValue(user({ id: 7, displayName: "Bob", tz: "" }));

    render(UsersView);
    await screen.findByText("No users yet. Add one above.");

    await fireEvent.input(screen.getByLabelText("New user display name"), {
      target: { value: "Bob" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add user" }));

    expect(await screen.findByText("Bob")).toBeInTheDocument();
    expect(createUser).toHaveBeenCalledWith({ displayName: "Bob" });
  });

  it("saves an inline edit and replaces the row", async () => {
    listUsers.mockResolvedValue([user({ id: 1, displayName: "Alice" })]);
    updateUser.mockResolvedValue(user({ id: 1, displayName: "Alicia" }));

    render(UsersView);
    await screen.findByText("Alice");

    await fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const nameInput = screen.getByLabelText("Edit display name");
    await fireEvent.input(nameInput, { target: { value: "Alicia" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Alicia")).toBeInTheDocument();
    expect(updateUser).toHaveBeenCalledWith(1, { displayName: "Alicia", tz: "Europe/London" });
  });

  it("deletes a user after confirmation and drops the row", async () => {
    listUsers.mockResolvedValue([user({ id: 1, displayName: "Alice" })]);
    deleteUser.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(UsersView);
    await screen.findByText("Alice");

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Alice")).not.toBeInTheDocument());
    expect(deleteUser).toHaveBeenCalledWith(1);
    expect(screen.getByText("No users yet. Add one above.")).toBeInTheDocument();
  });

  it("does not delete when the confirmation is declined", async () => {
    listUsers.mockResolvedValue([user({ id: 1, displayName: "Alice" })]);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(UsersView);
    await screen.findByText("Alice");

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleteUser).not.toHaveBeenCalled();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("surfaces an ApiError from the list load in the inline alert", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listUsers.mockRejectedValue(new ApiError(500, "internal", "The server exploded."));

    render(UsersView);

    // The shared user list is owned here, and the composed UserGroupsView no
    // longer reports the shared-list load error — so a single alert surfaces.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The server exploded.");
  });

  it("keeps the create error inline without losing the existing rows", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listUsers.mockResolvedValue([user({ id: 1, displayName: "Alice" })]);
    createUser.mockRejectedValue(new ApiError(409, "conflict", "That name is taken."));

    render(UsersView);
    await screen.findByText("Alice");

    await fireEvent.input(screen.getByLabelText("New user display name"), {
      target: { value: "Alice" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Add user" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That name is taken.");
    // The existing row is still present — the error didn't blow away the table.
    const table = screen.getByRole("table");
    expect(within(table).getByText("Alice")).toBeInTheDocument();
  });
});
