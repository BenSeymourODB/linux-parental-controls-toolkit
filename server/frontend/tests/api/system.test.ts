import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAnsibleStatus, fetchQueueSummary } from "../../src/lib/api/system.js";

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

describe("system API", () => {
  it("fetchAnsibleStatus GETs /api/system/ansible", async () => {
    const body = {
      state: "ready",
      binaryPath: "/data/ansible/venv/bin/ansible-playbook",
      playbooksDir: "/data/ansible/playbooks",
      coreVersion: "2.18.1",
      checkedAt: "2026-01-01T00:00:00.000Z",
      detail: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const result = await fetchAnsibleStatus();

    expect(result).toEqual(body);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/system/ansible");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method ?? "GET").toBe("GET");
  });

  it("fetchQueueSummary GETs /api/system/queue-summary and returns the parsed summary", async () => {
    const body = { pending: 3, failed: 1, oldestPendingAt: "2026-01-01T00:00:00.000Z" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const result = await fetchQueueSummary();

    expect(result).toEqual(body);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/system/queue-summary");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method ?? "GET").toBe("GET");
  });
});
