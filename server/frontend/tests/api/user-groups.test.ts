import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addUserToGroup,
  createUserGroup,
  deleteUserGroup,
  listGroupMembers,
  listUserGroups,
  removeUserFromGroup,
  updateUserGroup,
} from "../../src/lib/api/user-groups.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("user-groups API", () => {
  it("listUserGroups GETs /api/user-groups", async () => {
    const rows = [{ id: 1, name: "Kids", createdAt: "2026-06-23T00:00:00.000Z" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listUserGroups();

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/user-groups");
  });

  it("createUserGroup POSTs the body to /api/user-groups", async () => {
    const created = { id: 2, name: "Teens", createdAt: "2026-06-23T00:00:00.000Z" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createUserGroup({ name: "Teens" });

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user-groups");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify({ name: "Teens" }));
  });

  it("updateUserGroup PATCHes /api/user-groups/:id", async () => {
    const updated = { id: 3, name: "Littles", createdAt: "2026-06-23T00:00:00.000Z" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateUserGroup(3, { name: "Littles" });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user-groups/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ name: "Littles" }));
  });

  it("deleteUserGroup DELETEs /api/user-groups/:id and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteUserGroup(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user-groups/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("listGroupMembers GETs the nested membership collection", async () => {
    const rows = [{ id: 7, displayName: "Alice", tz: null, createdAt: "2026-06-23T00:00:00.000Z" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listGroupMembers(5);

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/user-groups/5/members");
  });

  it("addUserToGroup PUTs the membership and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(addUserToGroup(5, 7)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user-groups/5/members/7");
    expect((init as RequestInit).method).toBe("PUT");
  });

  it("removeUserFromGroup DELETEs the membership and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(removeUserFromGroup(5, 7)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user-groups/5/members/7");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
