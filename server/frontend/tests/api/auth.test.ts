import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSession, login, logout } from "../../src/lib/api/auth.js";

/** Build a minimal `fetch`-style JSON response. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth API", () => {
  it("login POSTs credentials to /api/auth/login and returns the session", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { authenticated: true, username: "admin" }));

    const result = await login({ username: "admin", password: "hunter2" });

    expect(result).toEqual({ authenticated: true, username: "admin" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/login");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ username: "admin", password: "hunter2" }),
    );
  });

  it("logout POSTs to /api/auth/logout", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { authenticated: false }));

    const result = await logout();

    expect(result).toEqual({ authenticated: false });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/logout");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
  });

  it("fetchSession GETs /api/auth/session", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { authenticated: true, username: "admin" }));

    const result = await fetchSession();

    expect(result.authenticated).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/session");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method ?? "GET").toBe("GET");
  });
});
