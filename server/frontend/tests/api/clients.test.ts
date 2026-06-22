import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClient,
  deleteClient,
  listClients,
  mintEnrolmentToken,
  updateClient,
} from "../../src/lib/api/clients.js";

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

describe("clients API", () => {
  it("listClients GETs /api/clients", async () => {
    const rows = [
      {
        id: 1,
        hostname: "mint-01",
        sshUser: "pct-agent",
        enrolledAt: "2026-01-01T00:00:00.000Z",
        lastSeen: null,
      },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listClients();

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/clients");
  });

  it("createClient POSTs the body to /api/clients", async () => {
    const created = {
      id: 2,
      hostname: "mint-02",
      sshUser: "pct-agent",
      enrolledAt: "x",
      lastSeen: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await createClient({ hostname: "mint-02", sshUser: "pct-agent" });

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/clients");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ hostname: "mint-02", sshUser: "pct-agent" }),
    );
  });

  it("updateClient PATCHes /api/clients/:id", async () => {
    const updated = {
      id: 3,
      hostname: "mint-03",
      sshUser: "pct-agent",
      enrolledAt: "x",
      lastSeen: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await updateClient(3, { hostname: "mint-03" });

    expect(result).toEqual(updated);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/clients/3");
    expect((init as RequestInit).method).toBe("PATCH");
    expect((init as RequestInit).body).toBe(JSON.stringify({ hostname: "mint-03" }));
  });

  it("deleteClient DELETEs /api/clients/:id and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteClient(4)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/clients/4");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("mintEnrolmentToken POSTs the scoped request to /api/clients/enrolment-tokens", async () => {
    const minted = { id: 5, token: "PCT-9f2a-7c1e-d40b", expiresAt: "2026-01-01T01:00:00.000Z" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, minted));

    const request = {
      supervisedUsers: [{ userId: 1, linuxUsername: "chloe" }],
      ttlSeconds: 3600,
      hostname: "chloe-laptop",
    };
    const result = await mintEnrolmentToken(request);

    expect(result).toEqual(minted);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/clients/enrolment-tokens");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify(request));
  });
});
