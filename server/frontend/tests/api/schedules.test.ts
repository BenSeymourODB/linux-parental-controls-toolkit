import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  updateSchedule,
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

describe("schedules API", () => {
  it("listSchedules GETs /api/schedules without a filter", async () => {
    const rows = [
      {
        id: 1,
        userId: 1,
        targetKind: "overall",
        targetId: null,
        action: "deny",
        ...ALWAYS_ON,
        ordinal: 0,
      },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listSchedules();

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/schedules");
  });

  it("listSchedules appends the ?userId= filter when given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, []));

    await listSchedules(42);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/schedules?userId=42");
  });

  it("createSchedule POSTs the body to /api/schedules", async () => {
    const body = {
      userId: 1,
      targetKind: "activity" as const,
      targetId: 9,
      action: "deny" as const,
      ...ALWAYS_ON,
    };
    const created = { id: 2, ...body, ordinal: 0 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createSchedule(body);

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/schedules");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify(body));
  });

  it("updateSchedule PATCHes /api/schedules/:id", async () => {
    const updated = {
      id: 3,
      userId: 1,
      targetKind: "overall",
      targetId: null,
      action: "allow",
      ...ALWAYS_ON,
      ordinal: 0,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateSchedule(3, { action: "allow" });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/schedules/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ action: "allow" }));
  });

  it("deleteSchedule DELETEs /api/schedules/:id and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteSchedule(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/schedules/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
