import { afterEach, describe, expect, it, vi } from "vitest";

import { listAudit } from "../../src/lib/api/audit.js";

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

describe("audit API", () => {
  const page = {
    entries: [
      {
        id: 7,
        at: "2026-01-01T00:00:00.000Z",
        targetHost: "mint-01",
        targetPort: 22,
        targetUser: "pct-agent",
        clientId: 3,
        userId: 2,
        actor: "system",
        reason: null,
        command: ["timekpra", "--setlimit"],
        outcome: "ok",
        exitCode: 0,
        signal: null,
        durationMs: 42,
        errorMessage: null,
      },
    ],
    nextCursor: 7,
  };

  it("listAudit with no filters GETs /api/audit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, page));

    const result = await listAudit();

    expect(result).toEqual(page);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/audit");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method ?? "GET").toBe("GET");
  });

  it("listAudit serialises clientId and outcome filters into the querystring", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, page));

    await listAudit({ clientId: 3, outcome: "failed" });

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/audit?clientId=3&outcome=failed");
  });

  it("listAudit passes the cursor as before and the page size as limit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, page));

    await listAudit({ before: 7, limit: 25 });

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/audit?before=7&limit=25");
  });

  it("listAudit returns the parsed page including the nextCursor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, page));

    const result = await listAudit();

    expect(result.nextCursor).toBe(7);
    expect(result.entries).toHaveLength(1);
  });
});
