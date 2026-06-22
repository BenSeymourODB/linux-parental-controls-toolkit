import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addActivityToGroup,
  createActivityGroup,
  deleteActivityGroup,
  listActivityGroups,
  listGroupActivities,
  removeActivityFromGroup,
  updateActivityGroup,
} from "../../src/lib/api/activity-groups.js";

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

describe("activity-groups API", () => {
  it("listActivityGroups GETs /api/activity-groups", async () => {
    const rows = [{ id: 1, name: "Games" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listActivityGroups();

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/activity-groups");
  });

  it("createActivityGroup POSTs the body to /api/activity-groups", async () => {
    const created = { id: 2, name: "Social" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createActivityGroup({ name: "Social" });

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/activity-groups");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify({ name: "Social" }));
  });

  it("updateActivityGroup PATCHes /api/activity-groups/:id", async () => {
    const updated = { id: 3, name: "Streaming" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateActivityGroup(3, { name: "Streaming" });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/activity-groups/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ name: "Streaming" }));
  });

  it("deleteActivityGroup DELETEs /api/activity-groups/:id and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteActivityGroup(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/activity-groups/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("listGroupActivities GETs the nested membership collection", async () => {
    const rows = [{ id: 7, kind: "app", matcher: "steam", matchType: "exact" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listGroupActivities(5);

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/activity-groups/5/activities");
  });

  it("addActivityToGroup PUTs the membership and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(addActivityToGroup(5, 7)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/activity-groups/5/activities/7");
    expect((init as RequestInit).method).toBe("PUT");
  });

  it("removeActivityFromGroup DELETEs the membership and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(removeActivityFromGroup(5, 7)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/activity-groups/5/activities/7");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
