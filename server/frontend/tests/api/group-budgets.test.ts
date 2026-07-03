import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGroupBudget,
  deleteGroupBudget,
  listGroupBudgets,
  updateGroupBudget,
} from "../../src/lib/api/group-budgets.js";

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

describe("group-budgets API", () => {
  it("listGroupBudgets GETs the nested group path", async () => {
    const rows = [
      { id: 1, userGroupId: 7, scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listGroupBudgets(7);

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/user-groups/7/budgets");
  });

  it("createGroupBudget POSTs the body to the nested group path", async () => {
    const body = {
      scope: "activity" as const,
      targetId: 9,
      window: "daily" as const,
      secondsAllowed: 3600,
    };
    const created = { id: 2, userGroupId: 7, ...body };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createGroupBudget(7, body);

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user-groups/7/budgets");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify(body));
  });

  it("updateGroupBudget PATCHes the flat-by-id path", async () => {
    const updated = {
      id: 3,
      userGroupId: 7,
      scope: "overall",
      targetId: null,
      window: "weekly",
      secondsAllowed: 18000,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateGroupBudget(3, { secondsAllowed: 18000 });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/group-budgets/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ secondsAllowed: 18000 }));
  });

  it("deleteGroupBudget DELETEs the flat-by-id path and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteGroupBudget(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/group-budgets/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
