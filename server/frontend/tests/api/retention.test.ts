import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearRetentionOverride,
  fetchRetention,
  setRetentionOverride,
} from "../../src/lib/api/retention.js";

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

describe("retention API", () => {
  it("fetchRetention GETs /api/retention", async () => {
    const config = {
      defaultDays: 365,
      categories: [
        { category: "usage_samples", source: "default", keepForever: false, days: 365, updatedAt: null },
      ],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, config));

    const result = await fetchRetention();

    expect(result).toEqual(config);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/retention");
    expect((init as RequestInit).method).toBe("GET");
  });

  it("setRetentionOverride PUTs a custom day count", async () => {
    const entry = {
      category: "audit_log",
      source: "override",
      keepForever: false,
      days: 30,
      updatedAt: "2026-08-07T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, entry));

    const body = { keepForever: false as const, days: 30 };
    const result = await setRetentionOverride("audit_log", body);

    expect(result).toEqual(entry);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/retention/audit_log");
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).body).toBe(JSON.stringify(body));
  });

  it("setRetentionOverride PUTs keep-forever without a day count", async () => {
    const entry = {
      category: "grant_ledger",
      source: "override",
      keepForever: true,
      days: null,
      updatedAt: "2026-08-07T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, entry));

    const body = { keepForever: true as const };
    const result = await setRetentionOverride("grant_ledger", body);

    expect(result).toEqual(entry);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/retention/grant_ledger");
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).body).toBe(JSON.stringify(body));
  });

  it("clearRetentionOverride DELETEs /api/retention/:category and returns the default entry", async () => {
    const reverted = {
      category: "date_overrides",
      source: "default",
      keepForever: false,
      days: 365,
      updatedAt: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, reverted));

    const result = await clearRetentionOverride("date_overrides");

    expect(result).toEqual(reverted);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/retention/date_overrides");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
