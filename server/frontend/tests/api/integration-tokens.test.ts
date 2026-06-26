import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createIntegrationToken,
  listIntegrationTokens,
  revokeIntegrationToken,
} from "../../src/lib/api/integration-tokens.js";

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

describe("integration tokens API", () => {
  it("listIntegrationTokens GETs /api/integrations/tokens", async () => {
    const rows = [
      {
        id: 1,
        name: "calendar",
        scopes: ["grants:write", "policy:read"],
        createdAt: "2026-06-01T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listIntegrationTokens();

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/integrations/tokens");
  });

  it("createIntegrationToken POSTs the body and returns the once-only secret", async () => {
    const created = {
      id: 2,
      name: "calendar",
      scopes: ["grants:write"],
      secret: "PCT-secret-9f2a",
      createdAt: "2026-06-02T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const request = { name: "calendar", scopes: ["grants:write" as const] };
    const result = await createIntegrationToken(request);

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/integrations/tokens");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify(request));
  });

  it("revokeIntegrationToken POSTs /api/integrations/tokens/:id/revoke", async () => {
    const revoked = {
      id: 3,
      name: "home-assistant",
      scopes: ["policy:read"],
      createdAt: "2026-05-20T00:00:00.000Z",
      lastUsedAt: "2026-06-01T00:00:00.000Z",
      revokedAt: "2026-06-03T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, revoked));

    const result = await revokeIntegrationToken(3);

    expect(result).toEqual(revoked);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/integrations/tokens/3/revoke");
    expect((init as RequestInit).method).toBe("POST");
  });
});
