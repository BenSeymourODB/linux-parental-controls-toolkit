/**
 * Unit tests for the group-schedule `/api` wrappers (#270): the order
 * read/reorder pair and the CRUD calls the group editor uses. Mirrors
 * `schedules.test.ts`; `fetch` is stubbed, so these assert the wrappers hit the
 * right URL/method/body and pass the JSON through.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGroupSchedule,
  deleteGroupSchedule,
  getGroupScheduleOrder,
  reorderGroupSchedules,
  updateGroupSchedule,
} from "../../src/lib/api/schedules.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

const ALWAYS_ON = {
  recurrenceDays: null,
  recurrenceStartMinute: null,
  recurrenceEndMinute: null,
  effectiveFrom: null,
  effectiveTo: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("group schedules API", () => {
  it("getGroupScheduleOrder GETs /api/user-groups/:groupId/schedules/order", async () => {
    const view = {
      schedules: [
        { id: 1, userGroupId: 7, targetKind: "overall", targetId: null, action: "deny", ...ALWAYS_ON, ordinal: 0 },
      ],
      shadows: [],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, view));

    const result = await getGroupScheduleOrder(7);

    expect(result).toEqual(view);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user-groups/7/schedules/order");
    // A plain GET — no method override.
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("reorderGroupSchedules PUTs the ordered ids", async () => {
    const view = { schedules: [], shadows: [] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, view));

    const result = await reorderGroupSchedules(7, [3, 1, 2]);

    expect(result).toEqual(view);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user-groups/7/schedules/order");
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).body).toBe(JSON.stringify({ orderedIds: [3, 1, 2] }));
  });

  it("createGroupSchedule POSTs the body to /api/user-groups/:groupId/schedules", async () => {
    const body = {
      targetKind: "activity" as const,
      targetId: 9,
      action: "deny" as const,
      ordinal: 2,
      ...ALWAYS_ON,
    };
    const created = { id: 2, userGroupId: 7, ...body };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createGroupSchedule(7, body);

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user-groups/7/schedules");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify(body));
  });

  it("updateGroupSchedule PATCHes the flat /api/group-schedules/:id route", async () => {
    const updated = {
      id: 3,
      userGroupId: 7,
      targetKind: "overall",
      targetId: null,
      action: "allow",
      ...ALWAYS_ON,
      ordinal: 0,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateGroupSchedule(3, { action: "allow" });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/group-schedules/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ action: "allow" }));
  });

  it("deleteGroupSchedule DELETEs /api/group-schedules/:id and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteGroupSchedule(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/group-schedules/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
