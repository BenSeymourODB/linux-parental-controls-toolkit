import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getNotificationPolicy,
  upsertNotificationPolicy,
  deleteNotificationPolicy,
} from "../../src/lib/api/notifications.js";

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

describe("notifications API", () => {
  it("getNotificationPolicy GETs /api/users/:id/notification-policy", async () => {
    const policy = {
      userId: 7,
      enabled: true,
      soundProfile: "subtle",
      graceSeconds: 15,
      cadenceOverrides: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, policy));

    const result = await getNotificationPolicy(7);

    expect(result).toEqual(policy);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/users/7/notification-policy");
    // The wrapper defaults to a GET when no method is supplied.
    expect((init as RequestInit).method).toBe("GET");
  });

  it("upsertNotificationPolicy PUTs the partial body", async () => {
    const body = { enabled: false, soundProfile: "prominent" as const, graceSeconds: 30 };
    const updated = { userId: 7, ...body, cadenceOverrides: null };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await upsertNotificationPolicy(7, body);

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/users/7/notification-policy");
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).body).toBe(JSON.stringify(body));
  });

  it("upsertNotificationPolicy can clear cadence overrides with an explicit null", async () => {
    const updated = {
      userId: 7,
      enabled: true,
      soundProfile: "subtle",
      graceSeconds: 15,
      cadenceOverrides: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    await upsertNotificationPolicy(7, { cadenceOverrides: null });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).body).toBe(JSON.stringify({ cadenceOverrides: null }));
  });

  it("deleteNotificationPolicy DELETEs and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteNotificationPolicy(7)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/users/7/notification-policy");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
