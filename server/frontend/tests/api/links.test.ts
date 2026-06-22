import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteLink, listUserLinks, upsertLink } from "../../src/lib/api/links.js";

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

describe("links API", () => {
  it("listUserLinks GETs the nested /api/users/:userId/clients collection", async () => {
    const rows = [{ userId: 1, clientId: 2, osUsername: "alice", osUserRef: "1001" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, rows));

    const result = await listUserLinks(1);

    expect(result).toEqual(rows);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/users/1/clients");
  });

  it("upsertLink PUTs the body to /api/users/:userId/clients/:clientId", async () => {
    const body = { osUsername: "alice", osUserRef: "1001" };
    const created = { userId: 1, clientId: 2, ...body };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, created));

    const result = await upsertLink(1, 2, body);

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/users/1/clients/2");
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).body).toBe(JSON.stringify(body));
  });

  it("deleteLink DELETEs /api/users/:userId/clients/:clientId and resolves on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(204, undefined));

    await expect(deleteLink(1, 2)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/users/1/clients/2");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
