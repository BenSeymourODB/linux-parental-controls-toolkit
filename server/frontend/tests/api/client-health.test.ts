import { afterEach, describe, expect, it, vi } from "vitest";

import { getClientHealth, listClientHealth } from "../../src/lib/api/client-health.js";

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

describe("client-health API", () => {
  const health = {
    clientId: 1,
    hostname: "mint-01",
    reachability: "unknown",
    lastSeen: null,
    enrolledAt: "2026-01-01T00:00:00.000Z",
    probedAt: null,
    components: [{ component: "timekpr-next", status: "unknown", detail: "not probed" }],
    queue: { pending: 0, failed: 0, actions: [] },
  };

  it("listClientHealth GETs /api/clients/health", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, [health]));

    const result = await listClientHealth();

    expect(result).toEqual([health]);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/clients/health");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });

  it("getClientHealth GETs /api/clients/:id/health", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, health));

    const result = await getClientHealth(1);

    expect(result).toEqual(health);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/clients/1/health");
  });
});
