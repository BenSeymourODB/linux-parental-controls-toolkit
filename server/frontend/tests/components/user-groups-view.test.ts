/**
 * Smoke test for `UserGroupsView` — the master-detail membership logic that
 * sits on top of the CRUD skeleton (#124): membership is loaded **lazily** when
 * a group panel is expanded (`toggleMembers` → `listGroupMembers`), the
 * add-member dropdown `candidates` exclude users already in the group, adding/
 * removing a member mutates the rendered list, and re-toggling collapses the
 * panel. The CRUD shape (create/rename/delete) repeats the proven
 * ActivityGroupsView pattern; this focuses on the user-membership layer. All
 * `$lib/api/user-groups` + `users` calls are mocked — no live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserGroupResponse, UserResponse } from "../../src/lib/api/contract.js";

const listUserGroups = vi.fn<() => Promise<UserGroupResponse[]>>();
const createUserGroup = vi.fn<(input: unknown) => Promise<UserGroupResponse>>();
const updateUserGroup = vi.fn<(id: number, input: unknown) => Promise<UserGroupResponse>>();
const deleteUserGroup = vi.fn<(id: number) => Promise<void>>();
const listGroupMembers = vi.fn<(groupId: number) => Promise<UserResponse[]>>();
const addUserToGroup = vi.fn<(groupId: number, userId: number) => Promise<void>>();
const removeUserFromGroup = vi.fn<(groupId: number, userId: number) => Promise<void>>();
const listUsers = vi.fn<() => Promise<UserResponse[]>>();

vi.mock("$lib/api/user-groups", () => ({
  listUserGroups: () => listUserGroups(),
  createUserGroup: (input: unknown) => createUserGroup(input),
  updateUserGroup: (id: number, input: unknown) => updateUserGroup(id, input),
  deleteUserGroup: (id: number) => deleteUserGroup(id),
  listGroupMembers: (groupId: number) => listGroupMembers(groupId),
  addUserToGroup: (groupId: number, userId: number) => addUserToGroup(groupId, userId),
  removeUserFromGroup: (groupId: number, userId: number) => removeUserFromGroup(groupId, userId),
}));
vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));

const { default: UserGroupsView } = await import("../../src/lib/views/UserGroupsView.svelte");

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return { id: 10, displayName: "Alice", tz: null, createdAt: "2026-06-23T00:00:00.000Z", ...overrides };
}

const ALICE = user({ id: 10, displayName: "Alice" });
const BOB = user({ id: 11, displayName: "Bob" });

const GROUP: UserGroupResponse = { id: 20, name: "Kids", createdAt: "2026-06-23T00:00:00.000Z" };

beforeEach(() => {
  listUserGroups.mockReset().mockResolvedValue([GROUP]);
  createUserGroup.mockReset();
  updateUserGroup.mockReset();
  deleteUserGroup.mockReset();
  listGroupMembers.mockReset().mockResolvedValue([]);
  addUserToGroup.mockReset().mockResolvedValue(undefined);
  removeUserFromGroup.mockReset().mockResolvedValue(undefined);
  listUsers.mockReset().mockResolvedValue([ALICE, BOB]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UserGroupsView membership", () => {
  it("loads members lazily only when the panel is expanded", async () => {
    listGroupMembers.mockResolvedValue([ALICE]);

    render(UserGroupsView);
    await screen.findByText("Kids");

    // Not fetched until the user opens the panel.
    expect(listGroupMembers).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Members" }));

    await waitFor(() => expect(listGroupMembers).toHaveBeenCalledWith(20));
    expect(await screen.findByText("Alice")).toBeInTheDocument();
  });

  it("offers only non-member users as add candidates", async () => {
    listGroupMembers.mockResolvedValue([ALICE]); // alice already a member

    render(UserGroupsView);
    await screen.findByText("Kids");
    await fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText("Alice");

    const picker = screen.getByLabelText("User to add");
    const optionLabels = within(picker)
      .getAllByRole("option")
      .map((o) => o.textContent?.trim());

    // bob is selectable; alice (already a member) is not in the candidate list.
    expect(optionLabels).toContain("Bob");
    expect(optionLabels).not.toContain("Alice");
  });

  it("adds a member and appends it to the rendered list", async () => {
    listGroupMembers.mockResolvedValue([]); // empty group

    render(UserGroupsView);
    await screen.findByText("Kids");
    await fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText("No users in this group yet.");

    await fireEvent.change(screen.getByLabelText("User to add"), { target: { value: "11" } });
    await fireEvent.click(screen.getByRole("button", { name: "Add to group" }));

    await waitFor(() => expect(addUserToGroup).toHaveBeenCalledWith(20, 11));
    expect(await screen.findByText("Bob")).toBeInTheDocument();
  });

  it("removes a member and drops it from the rendered list", async () => {
    listGroupMembers.mockResolvedValue([ALICE, BOB]);

    render(UserGroupsView);
    await screen.findByText("Kids");
    await fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText("Alice");

    // Two member rows, each with a Remove button — remove the first (alice).
    // Scope membership assertions to the member list: once removed, Alice
    // reappears as an add-candidate <option>, so a document-wide query would
    // still match her name.
    const memberList = screen.getByRole("list");
    const removeButtons = within(memberList).getAllByRole("button", { name: "Remove" });
    await fireEvent.click(removeButtons[0]!);

    await waitFor(() => expect(removeUserFromGroup).toHaveBeenCalledWith(20, 10));
    await waitFor(() =>
      expect(within(screen.getByRole("list")).queryByText("Alice")).not.toBeInTheDocument(),
    );
    expect(within(screen.getByRole("list")).getByText("Bob")).toBeInTheDocument();
  });

  it("notes when every user is already a member", async () => {
    listGroupMembers.mockResolvedValue([ALICE, BOB]); // both users in the group

    render(UserGroupsView);
    await screen.findByText("Kids");
    await fireEvent.click(screen.getByRole("button", { name: "Members" }));

    expect(await screen.findByText("All users are already in this group.")).toBeInTheDocument();
    expect(screen.queryByLabelText("User to add")).not.toBeInTheDocument();
  });

  it("collapses the panel when Members is toggled again", async () => {
    listGroupMembers.mockResolvedValue([ALICE]);

    render(UserGroupsView);
    await screen.findByText("Kids");

    await fireEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(await screen.findByText("Alice")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Hide members" }));
    await waitFor(() => expect(screen.queryByText("Alice")).not.toBeInTheDocument());
  });

  it("surfaces a membership-load error inline", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listGroupMembers.mockRejectedValue(new ApiError(500, "internal", "Members load failed."));

    render(UserGroupsView);
    await screen.findByText("Kids");
    await fireEvent.click(screen.getByRole("button", { name: "Members" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Members load failed.");
  });

  it("creates a group and appends it to the table", async () => {
    const created: UserGroupResponse = {
      id: 21,
      name: "Teens",
      createdAt: "2026-06-23T00:00:00.000Z",
    };
    createUserGroup.mockResolvedValue(created);

    render(UserGroupsView);
    await screen.findByText("Kids");

    await fireEvent.input(screen.getByLabelText("New group name"), { target: { value: "Teens" } });
    await fireEvent.click(screen.getByRole("button", { name: "Add group" }));

    await waitFor(() => expect(createUserGroup).toHaveBeenCalledWith({ name: "Teens" }));
    expect(await screen.findByText("Teens")).toBeInTheDocument();
  });
});
