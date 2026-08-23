import { afterEach, describe, expect, it, vi } from "vitest";

import { previewPolicyPush } from "../../src/lib/api/policy-preview.js";
import { ApiError } from "../../src/lib/api/client.js";
import type {
  PolicyPreviewRequest,
  PolicyPreviewResponse,
} from "../../src/lib/api/contract.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

const proposed: PolicyPreviewRequest = {
  budgets: [
    {
      id: 1,
      userId: 7,
      scope: "overall",
      targetId: null,
      window: "daily",
      secondsAllowed: 9000,
      recurrenceDays: null,
    },
  ],
  schedules: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("policy-preview API", () => {
  it("POSTs the proposed policy to /api/users/:id/policy-preview", async () => {
    const response: PolicyPreviewResponse = {
      userId: 7,
      hasChanges: true,
      changes: [
        {
          field: "daily-overall",
          kind: "changed",
          weekday: null,
          before: "2h",
          after: "2h 30m",
          summary: "Daily overall limit: 2h → 2h 30m",
        },
      ],
      affectedClients: [
        {
          clientId: 3,
          hostname: "mint-livingroom",
          lastSeen: null,
          pendingQueueDepth: 0,
          reachability: null,
          probedAt: null,
        },
      ],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, response));

    const result = await previewPolicyPush(7, proposed);

    expect(result).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/users/7/policy-preview");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify(proposed));
  });

  it("passes the opt-in probe flag through to the request body", async () => {
    const response: PolicyPreviewResponse = {
      userId: 7,
      hasChanges: false,
      changes: [],
      affectedClients: [
        {
          clientId: 3,
          hostname: "mint-livingroom",
          lastSeen: null,
          pendingQueueDepth: 0,
          reachability: "online",
          probedAt: "2026-06-17T12:00:05.000Z",
        },
      ],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, response));

    const withProbe: PolicyPreviewRequest = { ...proposed, probe: true };
    const result = await previewPolicyPush(7, withProbe);

    expect(result).toEqual(response);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).body).toBe(JSON.stringify(withProbe));
  });

  it("surfaces a 404 as an ApiError when the user does not exist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { error: { code: "not_found", message: "User 7 not found" } }),
    );

    await expect(previewPolicyPush(7, proposed)).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "not_found",
    });
    await expect(previewPolicyPush(7, proposed)).rejects.toBeInstanceOf(ApiError);
  });
});
