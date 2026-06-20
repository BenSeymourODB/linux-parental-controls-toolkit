import { describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch } from "../../src/lib/api/client.js";

/** Build a minimal `fetch`-style response for the fields {@link apiFetch} reads. */
function fakeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

/**
 * A `fetch`-typed mock so `mock.calls` carries the `[input, init]` tuple shape
 * (a bare `vi.fn(async () => …)` would infer a zero-arg signature).
 */
function mockFetch(response: Response) {
  return vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(response));
}

describe("apiFetch", () => {
  it("GETs from the /api prefix with same-origin credentials and returns parsed JSON", async () => {
    const fetchImpl = mockFetch(fakeResponse(200, JSON.stringify([{ id: 1 }])));

    const result = await apiFetch<{ id: number }[]>("/users", { fetchImpl });

    expect(result).toEqual([{ id: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/users");
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin" });
    expect((init as RequestInit).headers).toMatchObject({ Accept: "application/json" });
    // No body → no Content-Type.
    expect((init as RequestInit).body).toBeUndefined();
  });

  it("serializes a body as JSON and sets Content-Type on writes", async () => {
    const fetchImpl = mockFetch(fakeResponse(201, JSON.stringify({ id: 7 })));

    const result = await apiFetch<{ id: number }>("/users", {
      method: "POST",
      body: { displayName: "Alice" },
      fetchImpl,
    });

    expect(result).toEqual({ id: 7 });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify({ displayName: "Alice" }));
    expect((init as RequestInit).headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("resolves to undefined for a 204 / empty body (typed as void)", async () => {
    const fetchImpl = mockFetch(fakeResponse(204, ""));

    const result = await apiFetch<void>("/users/1", { method: "DELETE", fetchImpl });

    expect(result).toBeUndefined();
  });

  it("decodes the shared error envelope into a typed ApiError", async () => {
    const envelope = {
      error: {
        code: "validation_error",
        message: "Request body failed validation",
        details: [{ path: "displayName", message: "Required", code: "invalid_type" }],
      },
    };
    const fetchImpl = mockFetch(fakeResponse(400, JSON.stringify(envelope)));

    const err = await apiFetch("/users", { method: "POST", body: {}, fetchImpl }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(400);
    expect(apiErr.code).toBe("validation_error");
    expect(apiErr.message).toBe("Request body failed validation");
    expect(apiErr.details).toEqual(envelope.error.details);
    expect(apiErr.unauthorized).toBe(false);
  });

  it("flags a 401 as unauthorized so the shell can show the login view", async () => {
    const envelope = { error: { code: "unauthorized", message: "Login required" } };
    const fetchImpl = mockFetch(fakeResponse(401, JSON.stringify(envelope)));

    const err = (await apiFetch("/users", { fetchImpl }).catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.unauthorized).toBe(true);
    expect(err.details).toEqual([]);
  });

  it("synthesises an http_error when a failure has no JSON envelope", async () => {
    const fetchImpl = mockFetch(fakeResponse(502, "<html>bad gateway</html>"));

    const err = (await apiFetch("/users", { fetchImpl }).catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(502);
    expect(err.code).toBe("http_error");
  });

  it("tolerates a malformed JSON body on a success response", async () => {
    const fetchImpl = mockFetch(fakeResponse(200, "not json"));

    const result = await apiFetch<unknown>("/users", { fetchImpl });

    expect(result).toBeUndefined();
  });
});
