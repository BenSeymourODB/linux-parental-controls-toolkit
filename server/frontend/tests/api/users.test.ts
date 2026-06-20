import { afterEach, describe, expect, it, vi } from "vitest";

import { createUser, deleteUser, listUsers, updateUser } from "../../src/lib/api/users.js";

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

describe("users API", () => {
  it("listUsers GETs /api/users", async () => {
    const rows = [{ id: 1, displayName: "Alice", tz: null, createdAt: "2026-01-01T00:00:00.000Z" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listUsers();

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/users");
  });

  it("createUser POSTs the body to /api/users", async () => {
    const created = { id: 2, displayName: "Bob", tz: "Europe/London", createdAt: "x" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createUser({ displayName: "Bob", tz: "Europe/London" });

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/users");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ displayName: "Bob", tz: "Europe/London" }),
    );
  });

  it("updateUser PATCHes /api/users/:id", async () => {
    const updated = { id: 3, displayName: "Carol", tz: null, createdAt: "x" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateUser(3, { displayName: "Carol", tz: null });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/users/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ displayName: "Carol", tz: null }));
  });

  it("deleteUser DELETEs /api/users/:id and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteUser(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/users/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
