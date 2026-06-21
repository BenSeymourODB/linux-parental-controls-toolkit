import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createActivity,
  deleteActivity,
  listActivities,
  updateActivity,
} from "../../src/lib/api/activities.js";

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

describe("activities API", () => {
  it("listActivities GETs /api/activities", async () => {
    const rows = [{ id: 1, kind: "app", matcher: "firefox", matchType: "exact" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listActivities();

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/activities");
  });

  it("createActivity POSTs the body to /api/activities", async () => {
    const created = { id: 2, kind: "domain", matcher: "youtube.com", matchType: "substring" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createActivity({
      kind: "domain",
      matcher: "youtube.com",
      matchType: "substring",
    });

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/activities");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ kind: "domain", matcher: "youtube.com", matchType: "substring" }),
    );
  });

  it("updateActivity PATCHes /api/activities/:id", async () => {
    const updated = { id: 3, kind: "app", matcher: "steam", matchType: "exact" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateActivity(3, { matcher: "steam" });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/activities/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ matcher: "steam" }));
  });

  it("updateActivity sends a matchType-only PATCH body unchanged", async () => {
    const updated = { id: 5, kind: "domain", matcher: "*.youtube.com", matchType: "glob" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateActivity(5, { matchType: "glob" });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/activities/5");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ matchType: "glob" }));
  });

  it("deleteActivity DELETEs /api/activities/:id and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteActivity(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/activities/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
