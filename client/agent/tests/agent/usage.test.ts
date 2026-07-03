import { describe, expect, it } from "vitest";

import { OVERALL_BUDGET_KEY } from "../../src/agent/budget.js";
import { AwUsageSource, dayTimeperiod, type FetchLike } from "../../src/agent/usage.js";

/** A fetch stub returning a scripted response, recording the request. */
function fakeFetch(
  response: { ok: boolean; status: number; json: () => Promise<unknown> } | Error,
): { fetchFn: FetchLike; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, body: init.body });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
  return { fetchFn, calls };
}

const json = (value: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(value),
});

describe("dayTimeperiod", () => {
  it("spans local midnight to the next local midnight", () => {
    const tp = dayTimeperiod(new Date(2026, 6, 3, 14, 30, 0));
    const [start, end] = tp.split("/");
    if (start === undefined || end === undefined) throw new Error("expected start/end");
    expect(new Date(end).getTime() - new Date(start).getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("AwUsageSource", () => {
  const now = () => new Date(2026, 6, 3, 12, 0, 0);

  it("queries aw-server and maps the summed duration to the overall budget", async () => {
    const { fetchFn, calls } = fakeFetch(json([5400.7]));
    const source = new AwUsageSource({ baseUrl: "http://127.0.0.1:5600/", fetchFn, now });

    const used = await source.usedSeconds();

    expect(used.get(OVERALL_BUDGET_KEY)).toBe(5400); // floored
    expect(calls[0]?.url).toBe("http://127.0.0.1:5600/api/0/query/");
    expect(calls[0]?.body).toContain("aw-watcher-afk_");
    expect(calls[0]?.body).toContain("not-afk");
  });

  it("returns an empty map on a non-2xx response", async () => {
    const { fetchFn } = fakeFetch({ ok: false, status: 500, json: () => Promise.resolve(null) });
    const used = await new AwUsageSource({
      baseUrl: "http://127.0.0.1:5600",
      fetchFn,
      now,
    }).usedSeconds();
    expect(used.size).toBe(0);
  });

  it("returns an empty map when the response shape is invalid", async () => {
    const { fetchFn } = fakeFetch(json({ not: "an array" }));
    const used = await new AwUsageSource({
      baseUrl: "http://127.0.0.1:5600",
      fetchFn,
      now,
    }).usedSeconds();
    expect(used.size).toBe(0);
  });

  it("returns an empty map when aw-server is unreachable", async () => {
    const { fetchFn } = fakeFetch(new Error("ECONNREFUSED"));
    const used = await new AwUsageSource({
      baseUrl: "http://127.0.0.1:5600",
      fetchFn,
      now,
    }).usedSeconds();
    expect(used.size).toBe(0);
  });

  it("clamps a negative duration to zero", async () => {
    const { fetchFn } = fakeFetch(json([-10]));
    const used = await new AwUsageSource({
      baseUrl: "http://127.0.0.1:5600",
      fetchFn,
      now,
    }).usedSeconds();
    expect(used.get(OVERALL_BUDGET_KEY)).toBe(0);
  });
});
