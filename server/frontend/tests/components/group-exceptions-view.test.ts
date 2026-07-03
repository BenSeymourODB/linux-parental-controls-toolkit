/**
 * Component smoke test for `GroupExceptionsView` (#363) — the group counterpart
 * of `exceptions-view.test.ts`. Focuses on what the group view adds: the group
 * picker gates the editor and drives `listGroupExceptions`; create omits the
 * owner and POSTs via `createGroupException(groupId, …)`; the date-window
 * validation, inline edit, and delete mirror ExceptionsView. All `/api`
 * wrappers are mocked — no live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityGroupResponse,
  ActivityResponse,
  GroupExceptionResponse,
  UserGroupResponse,
} from "../../src/lib/api/contract.js";

const listGroupExceptions = vi.fn<(groupId: number) => Promise<GroupExceptionResponse[]>>();
const createGroupException =
  vi.fn<(groupId: number, input: unknown) => Promise<GroupExceptionResponse>>();
const updateGroupException = vi.fn<(id: number, input: unknown) => Promise<GroupExceptionResponse>>();
const deleteGroupException = vi.fn<(id: number) => Promise<void>>();
const listUserGroups = vi.fn<() => Promise<UserGroupResponse[]>>();
const listActivities = vi.fn<() => Promise<ActivityResponse[]>>();
const listActivityGroups = vi.fn<() => Promise<ActivityGroupResponse[]>>();

vi.mock("$lib/api/group-exceptions", () => ({
  listGroupExceptions: (groupId: number) => listGroupExceptions(groupId),
  createGroupException: (groupId: number, input: unknown) => createGroupException(groupId, input),
  updateGroupException: (id: number, input: unknown) => updateGroupException(id, input),
  deleteGroupException: (id: number) => deleteGroupException(id),
}));
vi.mock("$lib/api/user-groups", () => ({ listUserGroups: () => listUserGroups() }));
vi.mock("$lib/api/activities", () => ({ listActivities: () => listActivities() }));
vi.mock("$lib/api/activity-groups", () => ({ listActivityGroups: () => listActivityGroups() }));

const { default: GroupExceptionsView } = await import(
  "../../src/lib/views/GroupExceptionsView.svelte"
);

function activity(overrides: Partial<ActivityResponse> = {}): ActivityResponse {
  return { id: 10, kind: "app", matcher: "steam", matchType: "exact", ...overrides };
}

function activityGroup(overrides: Partial<ActivityGroupResponse> = {}): ActivityGroupResponse {
  return { id: 20, name: "Games", ...overrides };
}

function exception(overrides: Partial<GroupExceptionResponse> = {}): GroupExceptionResponse {
  return {
    id: 100,
    userGroupId: 1,
    targetKind: "overall",
    targetId: null,
    action: "allow",
    reason: null,
    effectiveFrom: null,
    expiresAt: "2026-07-05T12:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Select the group named `name` by index (robust against Svelte's value binding). */
async function selectGroup(name: string): Promise<void> {
  const select = (await screen.findByLabelText("Manage exceptions for group")) as HTMLSelectElement;
  const index = Array.from(select.options).findIndex((o) => o.textContent?.trim() === name);
  expect(index).toBeGreaterThanOrEqual(0);
  select.selectedIndex = index;
  await fireEvent.change(select);
}

beforeEach(() => {
  listGroupExceptions.mockReset().mockResolvedValue([]);
  createGroupException.mockReset();
  updateGroupException.mockReset();
  deleteGroupException.mockReset();
  listUserGroups
    .mockReset()
    .mockResolvedValue([
      { id: 1, name: "Kids", createdAt: "2026-01-01T00:00:00.000Z" },
    ] as UserGroupResponse[]);
  listActivities.mockReset().mockResolvedValue([activity()]);
  listActivityGroups.mockReset().mockResolvedValue([activityGroup()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GroupExceptionsView", () => {
  it("prompts to add a user group first when none exist", async () => {
    listUserGroups.mockResolvedValue([]);

    render(GroupExceptionsView);

    expect(
      await screen.findByText(
        "Add a user group first — a group exception always belongs to a group.",
      ),
    ).toBeInTheDocument();
  });

  it("gates the editor behind the group picker, then loads that group's exceptions", async () => {
    render(GroupExceptionsView);

    expect(
      await screen.findByText("Choose a group to view and manage its exceptions."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add exception" })).not.toBeInTheDocument();

    listGroupExceptions.mockResolvedValue([exception({ id: 1, reason: "birthday" })]);
    await selectGroup("Kids");

    expect(listGroupExceptions).toHaveBeenCalledWith(1);
    expect(await screen.findByText("birthday")).toBeInTheDocument();
  });

  it("creates an exception on the selected group without an owner field", async () => {
    render(GroupExceptionsView);
    await selectGroup("Kids");
    await screen.findByText("No exceptions yet. Add one above.");

    createGroupException.mockResolvedValue(exception({ id: 7, action: "deny" }));

    const submit = screen.getByRole("button", { name: "Add exception" });
    expect(submit).toBeDisabled(); // no expiry yet

    await fireEvent.change(screen.getByLabelText("Exception action"), { target: { value: "deny" } });
    await fireEvent.input(screen.getByLabelText("Expires at"), {
      target: { value: "2026-07-05T12:00" },
    });
    expect(submit).toBeEnabled();
    await fireEvent.click(submit);

    expect(createGroupException).toHaveBeenCalledTimes(1);
    const [groupId, body] = createGroupException.mock.calls[0]!;
    expect(groupId).toBe(1);
    expect(body).toMatchObject({
      targetKind: "overall",
      targetId: null,
      action: "deny",
      reason: null,
      effectiveFrom: null,
    });
    // expiresAt is the local datetime converted to an ISO-8601 UTC instant.
    expect((body as { expiresAt: string }).expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("blocks create and warns when the expiry is not after the start", async () => {
    render(GroupExceptionsView);
    await selectGroup("Kids");
    await screen.findByText("No exceptions yet. Add one above.");

    await fireEvent.input(screen.getByLabelText("Effective from"), {
      target: { value: "2026-07-05T12:00" },
    });
    await fireEvent.input(screen.getByLabelText("Expires at"), {
      target: { value: "2026-07-05T10:00" },
    });

    expect(await screen.findByText("Expiry must be after the start time.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add exception" })).toBeDisabled();
    expect(createGroupException).not.toHaveBeenCalled();
  });

  it("requires a target before an activity-scoped exception can be created", async () => {
    render(GroupExceptionsView);
    await selectGroup("Kids");
    await screen.findByText("No exceptions yet. Add one above.");

    await fireEvent.input(screen.getByLabelText("Expires at"), {
      target: { value: "2026-07-05T12:00" },
    });
    await fireEvent.change(screen.getByLabelText("Exception scope"), {
      target: { value: "activity" },
    });
    expect(screen.getByRole("button", { name: "Add exception" })).toBeDisabled();

    await fireEvent.change(screen.getByLabelText("Target activity"), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: "Add exception" })).toBeEnabled();
  });

  it("edits action + reason + expiry inline", async () => {
    listGroupExceptions.mockResolvedValue([exception({ id: 100, action: "allow", reason: "old" })]);
    updateGroupException.mockResolvedValue(exception({ id: 100, action: "deny", reason: "new" }));

    render(GroupExceptionsView);
    await selectGroup("Kids");
    await screen.findByText("old");

    await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await fireEvent.change(screen.getByLabelText("Edit action"), { target: { value: "deny" } });
    await fireEvent.input(screen.getByLabelText("Edit reason"), { target: { value: "new" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateGroupException).toHaveBeenCalledTimes(1);
    const [id, body] = updateGroupException.mock.calls[0]!;
    expect(id).toBe(100);
    expect(body).toMatchObject({ action: "deny", reason: "new" });
    expect(await screen.findByText("new")).toBeInTheDocument();
  });

  it("deletes an exception after confirmation", async () => {
    listGroupExceptions.mockResolvedValue([exception({ id: 100, reason: "temp" })]);
    deleteGroupException.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(GroupExceptionsView);
    await selectGroup("Kids");
    await screen.findByText("temp");

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteGroupException).toHaveBeenCalledWith(100));
    expect(screen.getByText("No exceptions yet. Add one above.")).toBeInTheDocument();
  });

  it("resolves an activity target to its matcher in the table", async () => {
    listGroupExceptions.mockResolvedValue([exception({ targetKind: "activity", targetId: 10 })]);

    render(GroupExceptionsView);
    await selectGroup("Kids");

    const table = await screen.findByRole("table");
    expect(within(table).getByText("steam")).toBeInTheDocument();
    expect(within(table).getByText("Activity")).toBeInTheDocument();
  });

  it("surfaces a load error in the inline alert", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listGroupExceptions.mockRejectedValue(
      new ApiError(500, "internal", "Group exception load failed."),
    );

    render(GroupExceptionsView);
    await selectGroup("Kids");

    expect(await screen.findByRole("alert")).toHaveTextContent("Group exception load failed.");
  });
});
