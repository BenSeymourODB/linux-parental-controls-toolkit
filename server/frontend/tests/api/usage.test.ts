import { afterEach, describe, expect, it, vi } from "vitest";

import { getBurndown, getTimeline } from "../../src/lib/api/usage.js";

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

describe("usage API", () => {
  it("getBurndown GETs the daily window by default", async () => {
    const body = { userId: 1, window: "daily", tz: "UTC", budgets: [] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const result = await getBurndown(1);

    expect(result).toEqual(body);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/users/1/usage/burndown?window=daily");
  });

  it("getBurndown passes the chosen window", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { budgets: [] }));

    await getBurndown(7, "monthly");

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/users/7/usage/burndown?window=monthly");
  });

  it("getTimeline omits the querystring when no range is given", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { samples: [], activities: [] }));

    await getTimeline(3);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/users/3/usage/timeline");
  });

  it("getTimeline encodes the from/to range", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { samples: [], activities: [] }));

    await getTimeline(3, { from: "2026-06-20T00:00:00.000Z", to: "2026-06-21T00:00:00.000Z" });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/api/users/3/usage/timeline?");
    expect(url).toContain("from=2026-06-20T00%3A00%3A00.000Z");
    expect(url).toContain("to=2026-06-21T00%3A00%3A00.000Z");
  });
});
