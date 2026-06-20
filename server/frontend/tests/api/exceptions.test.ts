import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createException,
  deleteException,
  listExceptions,
  updateException,
} from "../../src/lib/api/exceptions.js";

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

describe("exceptions API", () => {
  it("listExceptions GETs /api/exceptions without a filter", async () => {
    const rows = [
      {
        id: 1,
        userId: 1,
        targetKind: "overall",
        targetId: null,
        action: "extend",
        reason: "birthday",
        effectiveFrom: null,
        expiresAt: "2026-07-01T00:00:00.000Z",
        createdAt: "2026-06-20T00:00:00.000Z",
      },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listExceptions();

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/exceptions");
  });

  it("listExceptions appends the ?userId= filter when given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, []));

    await listExceptions(42);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/exceptions?userId=42");
  });

  it("createException POSTs the body to /api/exceptions", async () => {
    const body = {
      userId: 1,
      targetKind: "activity" as const,
      targetId: 9,
      action: "deny" as const,
      reason: "grounded",
      effectiveFrom: null,
      expiresAt: "2026-07-01T00:00:00.000Z",
    };
    const created = { id: 2, ...body, createdAt: "2026-06-20T00:00:00.000Z" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createException(body);

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/exceptions");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify(body));
  });

  it("updateException PATCHes /api/exceptions/:id", async () => {
    const updated = {
      id: 3,
      userId: 1,
      targetKind: "overall",
      targetId: null,
      action: "allow",
      reason: null,
      effectiveFrom: null,
      expiresAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-06-20T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateException(3, { expiresAt: "2026-08-01T00:00:00.000Z" });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/exceptions/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ expiresAt: "2026-08-01T00:00:00.000Z" }),
    );
  });

  it("deleteException DELETEs /api/exceptions/:id and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteException(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/exceptions/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
