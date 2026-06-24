/**
 * Unit test for the `user-groups` `/api` read wrapper (#270). `fetch` is
 * stubbed; this asserts the wrapper hits the right URL and passes the JSON
 * through. Only `listUserGroups` exists today — it is what the group-schedule
 * editor's group picker needs; the full user-groups CRUD is #124.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { listUserGroups } from "../../src/lib/api/user-groups.js";

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
    const rows = [{ id: 1, name: "Kids", createdAt: "2026-01-01T00:00:00.000Z" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listUserGroups();

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/user-groups");
  });
});
