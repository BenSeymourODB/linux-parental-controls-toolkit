import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBudget,
  deleteBudget,
  listBudgets,
  updateBudget,
} from "../../src/lib/api/budgets.js";

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

describe("budgets API", () => {
  it("listBudgets GETs /api/budgets without a filter", async () => {
    const rows = [
      { id: 1, userId: 1, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listBudgets();

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/budgets");
  });

  it("listBudgets appends the ?userId= filter when given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, []));

    await listBudgets(42);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/budgets?userId=42");
  });

  it("createBudget POSTs the body to /api/budgets", async () => {
    const body = {
      userId: 1,
      scope: "activity" as const,
      targetId: 9,
      window: "daily" as const,
      secondsAllowed: 3600,
    };
    const created = { id: 2, ...body };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createBudget(body);

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/budgets");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify(body));
  });

  it("updateBudget PATCHes /api/budgets/:id", async () => {
    const updated = {
      id: 3,
      userId: 1,
      scope: "overall",
      targetId: null,
      window: "weekly",
      secondsAllowed: 18000,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateBudget(3, { secondsAllowed: 18000 });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/budgets/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ secondsAllowed: 18000 }));
  });

  it("deleteBudget DELETEs /api/budgets/:id and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteBudget(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/budgets/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
