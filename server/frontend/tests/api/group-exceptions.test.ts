import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGroupException,
  deleteGroupException,
  listGroupExceptions,
  updateGroupException,
} from "../../src/lib/api/group-exceptions.js";

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

describe("group-exceptions API", () => {
  it("listGroupExceptions GETs the nested group path", async () => {
    const rows = [
      {
        id: 1,
        userGroupId: 7,
        targetKind: "overall",
        targetId: null,
        action: "deny",
        reason: null,
        effectiveFrom: null,
        expiresAt: "2026-07-05T00:00:00.000Z",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listGroupExceptions(7);

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/user-groups/7/exceptions");
  });

  it("createGroupException POSTs the body to the nested group path", async () => {
    const body = {
      targetKind: "activity" as const,
      targetId: 9,
      action: "allow" as const,
      reason: "birthday",
      effectiveFrom: null,
      expiresAt: "2026-07-05T00:00:00.000Z",
    };
    const created = { id: 2, userGroupId: 7, createdAt: "2026-07-01T00:00:00.000Z", ...body };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createGroupException(7, body);

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user-groups/7/exceptions");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify(body));
  });

  it("updateGroupException PATCHes the flat-by-id path", async () => {
    const updated = {
      id: 3,
      userGroupId: 7,
      targetKind: "overall",
      targetId: null,
      action: "deny",
      reason: null,
      effectiveFrom: null,
      expiresAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateGroupException(3, { action: "deny" });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/group-exceptions/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ action: "deny" }));
  });

  it("deleteGroupException DELETEs the flat-by-id path and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteGroupException(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/group-exceptions/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
