/**
 * Unit tests for the ActivityWatch REST client.
 *
 * Follows `docs/testing.md` → "Transport — REST": undici's `MockAgent`
 * intercepts HTTP so no live `aw-server` is needed for the happy / non-2xx /
 * malformed paths, and `replyWithError` simulates a connection failure. The
 * client is driven with undici's `fetch` bound to the mock agent via its
 * `dispatcher` option (Node's global `fetch` does not honour the npm undici
 * package's global dispatcher, so per-request injection is both correct and
 * leak-free across tests). The deterministic timeout path uses an injected
 * `fetch` that honours the abort signal, avoiding a flaky delayed reply.
 */
import { MockAgent, fetch as undiciFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivityWatchClient,
  ActivityWatchParseError,
  ActivityWatchRequestError,
  ActivityWatchUnreachableError,
  type ActivityWatchClientOptions,
  type ActivityWatchLogger,
  type FetchLike,
} from "../../../src/transport/activitywatch/index.js";

const BASE_URL = "http://localhost:5600";
const START = new Date("2024-01-01T00:00:00.000Z");
const END = new Date("2024-01-01T01:00:00.000Z");

/** A JSON reply with the content-type `Response.json()` expects. */
const JSON_HEADERS = { headers: { "content-type": "application/json" } } as const;

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
});

afterEach(async () => {
  await agent.close();
});

/** undici `fetch` bound to the per-test mock agent — satisfies `FetchLike`. */
function mockFetch(): FetchLike {
  return (input, init) => undiciFetch(input, { ...init, dispatcher: agent });
}

/** A client whose fetch is routed through the mock agent. */
function makeClient(extra: Partial<Omit<ActivityWatchClientOptions, "baseUrl">> = {}) {
  return new ActivityWatchClient({ baseUrl: BASE_URL, fetch: mockFetch(), ...extra });
}

function spyLogger(): ActivityWatchLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe("ActivityWatchClient construction", () => {
  it("strips a trailing slash from the base URL", () => {
    const client = new ActivityWatchClient({ baseUrl: "http://localhost:5600///" });
    expect(client.baseUrl).toBe("http://localhost:5600");
  });
});

describe("getInfo", () => {
  it("returns parsed server info on the happy path", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/api/0/info", method: "GET" })
      .reply(
        200,
        { hostname: "kid-laptop", version: "aw-server 0.13", testing: false, device_id: "abc" },
        JSON_HEADERS,
      );

    await expect(makeClient().getInfo()).resolves.toEqual({
      hostname: "kid-laptop",
      version: "aw-server 0.13",
      testing: false,
      device_id: "abc",
    });
    agent.assertNoPendingInterceptors();
  });

  it("rejects a malformed info body with a parse error carrying the zod issue", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/api/0/info", method: "GET" })
      .reply(200, { hostname: "kid-laptop" }, JSON_HEADERS); // missing version/testing

    const error = await makeClient()
      .getInfo()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActivityWatchParseError);
    expect((error as ActivityWatchParseError).zodError).toBeDefined();
  });
});

describe("listBuckets", () => {
  it("returns the parsed buckets and coerces timestamps to Date", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/api/0/buckets/", method: "GET" })
      .reply(
        200,
        {
          "aw-watcher-window_host": {
            id: "aw-watcher-window_host",
            created: "2024-01-01T00:00:00.000Z",
            name: null,
            type: "currentwindow",
            client: "aw-watcher-window",
            hostname: "host",
            last_updated: "2024-01-02T00:00:00.000Z",
          },
        },
        JSON_HEADERS,
      );

    const buckets = await makeClient().listBuckets();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.type).toBe("currentwindow");
    expect(buckets[0]?.created).toBeInstanceOf(Date);
  });

  it("skips a malformed bucket entry, keeps the rest, and warns", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/api/0/buckets/", method: "GET" })
      .reply(
        200,
        {
          good: {
            id: "good",
            created: "2024-01-01T00:00:00.000Z",
            type: "afkstatus",
            client: "aw-watcher-afk",
            hostname: "host",
          },
          bad: { id: 123 }, // id must be a string; whole entry is malformed
        },
        JSON_HEADERS,
      );

    const logger = spyLogger();
    const buckets = await makeClient({ logger }).listBuckets();
    expect(buckets.map((b) => b.id)).toEqual(["good"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-object buckets body with a parse error", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/api/0/buckets/", method: "GET" })
      .reply(200, JSON.stringify(42), JSON_HEADERS);

    await expect(makeClient().listBuckets()).rejects.toBeInstanceOf(ActivityWatchParseError);
  });
});

describe("getEvents", () => {
  it("serializes the window as start/end/limit query params", async () => {
    let capturedPath = "";
    agent
      .get(BASE_URL)
      .intercept({
        method: "GET",
        path: (p) => {
          capturedPath = p;
          return p.startsWith("/api/0/buckets/");
        },
      })
      .reply(200, [], JSON_HEADERS);

    await makeClient().getEvents("aw-watcher-window_host", { start: START, end: END, limit: 100 });

    expect(capturedPath).toContain("/api/0/buckets/aw-watcher-window_host/events?");
    expect(capturedPath).toContain("start=2024-01-01T00%3A00%3A00.000Z");
    expect(capturedPath).toContain("end=2024-01-01T01%3A00%3A00.000Z");
    expect(capturedPath).toContain("limit=100");
  });

  it("omits the limit param when not supplied and returns an empty list for an empty bucket", async () => {
    let capturedPath = "";
    agent
      .get(BASE_URL)
      .intercept({
        method: "GET",
        path: (p) => {
          capturedPath = p;
          return p.startsWith("/api/0/buckets/");
        },
      })
      .reply(200, [], JSON_HEADERS);

    await expect(makeClient().getEvents("b", { start: START, end: END })).resolves.toEqual([]);
    expect(capturedPath).not.toContain("limit=");
  });

  it("skips a malformed event, keeps the valid ones, and warns", async () => {
    agent
      .get(BASE_URL)
      .intercept({ method: "GET", path: (p) => p.startsWith("/api/0/buckets/") })
      .reply(
        200,
        [
          { id: 1, timestamp: "2024-01-01T00:10:00.000Z", duration: 60, data: { app: "firefox" } },
          { id: 2, timestamp: "not-a-date", duration: 60, data: {} }, // bad timestamp
          { id: 3, timestamp: "2024-01-01T00:20:00.000Z", duration: -5, data: {} }, // negative duration
        ],
        JSON_HEADERS,
      );

    const logger = spyLogger();
    const events = await makeClient({ logger }).getEvents("b", { start: START, end: END });
    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBeInstanceOf(Date);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-array events body with a parse error", async () => {
    agent
      .get(BASE_URL)
      .intercept({ method: "GET", path: (p) => p.startsWith("/api/0/buckets/") })
      .reply(200, { not: "an array" }, JSON_HEADERS);

    await expect(makeClient().getEvents("b", { start: START, end: END })).rejects.toBeInstanceOf(
      ActivityWatchParseError,
    );
  });

  it("rejects an inverted window before issuing any request", async () => {
    // No interceptor registered: if a request were made, disableNetConnect
    // would surface a different error. A RangeError proves we never sent one.
    await expect(makeClient().getEvents("b", { start: END, end: START })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe("getWindowEvents / getAfkEvents", () => {
  function bucketsBody(): Record<string, unknown> {
    return {
      "aw-watcher-window_host": {
        id: "aw-watcher-window_host",
        created: "2024-01-01T00:00:00.000Z",
        type: "currentwindow",
        client: "aw-watcher-window",
        hostname: "host",
      },
      "aw-watcher-afk_host": {
        id: "aw-watcher-afk_host",
        created: "2024-01-01T00:00:00.000Z",
        type: "afkstatus",
        client: "aw-watcher-afk",
        hostname: "host",
      },
    };
  }

  it("projects window events and skips events whose data is not window-shaped", async () => {
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: "/api/0/buckets/", method: "GET" })
      .reply(200, bucketsBody(), JSON_HEADERS);
    pool
      .intercept({
        method: "GET",
        path: (p) => p.startsWith("/api/0/buckets/aw-watcher-window_host/events"),
      })
      .reply(
        200,
        [
          {
            id: 1,
            timestamp: "2024-01-01T00:10:00.000Z",
            duration: 60,
            data: { app: "firefox", title: "ActivityWatch" },
          },
          { id: 2, timestamp: "2024-01-01T00:11:00.000Z", duration: 30, data: { status: "afk" } },
        ],
        JSON_HEADERS,
      );

    const logger = spyLogger();
    const events = await makeClient({ logger }).getWindowEvents({ start: START, end: END });
    expect(events).toEqual([
      {
        bucketId: "aw-watcher-window_host",
        timestamp: new Date("2024-01-01T00:10:00.000Z"),
        durationSeconds: 60,
        app: "firefox",
        title: "ActivityWatch",
      },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("projects afk events from the afkstatus bucket", async () => {
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: "/api/0/buckets/", method: "GET" })
      .reply(200, bucketsBody(), JSON_HEADERS);
    pool
      .intercept({
        method: "GET",
        path: (p) => p.startsWith("/api/0/buckets/aw-watcher-afk_host/events"),
      })
      .reply(
        200,
        [{ id: 1, timestamp: "2024-01-01T00:10:00.000Z", duration: 600, data: { status: "afk" } }],
        JSON_HEADERS,
      );

    const events = await makeClient().getAfkEvents({ start: START, end: END });
    expect(events).toEqual([
      {
        bucketId: "aw-watcher-afk_host",
        timestamp: new Date("2024-01-01T00:10:00.000Z"),
        durationSeconds: 600,
        status: "afk",
      },
    ]);
  });

  it("skips afk-bucket events whose data is not afk-shaped and warns", async () => {
    const pool = agent.get(BASE_URL);
    pool
      .intercept({ path: "/api/0/buckets/", method: "GET" })
      .reply(200, bucketsBody(), JSON_HEADERS);
    pool
      .intercept({
        method: "GET",
        path: (p) => p.startsWith("/api/0/buckets/aw-watcher-afk_host/events"),
      })
      .reply(
        200,
        [
          { id: 1, timestamp: "2024-01-01T00:10:00.000Z", duration: 600, data: { status: "afk" } },
          {
            id: 2,
            timestamp: "2024-01-01T00:20:00.000Z",
            duration: 30,
            data: { app: "firefox", title: "x" }, // window data in an afk bucket
          },
        ],
        JSON_HEADERS,
      );

    const logger = spyLogger();
    const events = await makeClient({ logger }).getAfkEvents({ start: START, end: END });
    expect(events.map((e) => e.status)).toEqual(["afk"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when no bucket of the requested type exists", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/api/0/buckets/", method: "GET" })
      .reply(
        200,
        {
          "aw-watcher-afk_host": {
            id: "aw-watcher-afk_host",
            created: "2024-01-01T00:00:00.000Z",
            type: "afkstatus",
            client: "aw-watcher-afk",
            hostname: "host",
          },
        },
        JSON_HEADERS,
      );

    await expect(makeClient().getWindowEvents({ start: START, end: END })).resolves.toEqual([]);
  });
});

describe("error taxonomy", () => {
  it("maps a non-2xx status to a request error that preserves the status code", async () => {
    agent.get(BASE_URL).intercept({ path: "/api/0/info", method: "GET" }).reply(503, "unavailable");

    const error = await makeClient()
      .getInfo()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActivityWatchRequestError);
    expect((error as ActivityWatchRequestError).statusCode).toBe(503);
  });

  it("maps a 404 (e.g. unknown bucket) to a request error preserving the status", async () => {
    agent
      .get(BASE_URL)
      .intercept({ method: "GET", path: (p) => p.startsWith("/api/0/buckets/") })
      .reply(404, "no such bucket");

    const error = await makeClient()
      .getEvents("missing", { start: START, end: END })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActivityWatchRequestError);
    expect((error as ActivityWatchRequestError).statusCode).toBe(404);
  });

  it("maps a connection failure to an unreachable error (not timed out)", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/api/0/info", method: "GET" })
      .replyWithError(new Error("connect ECONNREFUSED 127.0.0.1:5600"));

    const error = await makeClient()
      .getInfo()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActivityWatchUnreachableError);
    expect((error as ActivityWatchUnreachableError).timedOut).toBe(false);
    expect((error as ActivityWatchUnreachableError).cause).toBeInstanceOf(Error);
  });

  it("maps a per-request timeout to an unreachable error flagged timedOut", async () => {
    // Injected fetch that never resolves until the abort signal fires, so the
    // 5ms timeout deterministically rejects with the signal's TimeoutError.
    const hangingFetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(signal.reason);
          });
        }
      });

    const client = new ActivityWatchClient({
      baseUrl: BASE_URL,
      timeoutMs: 5,
      fetch: hangingFetch,
    });
    const error = await client.getInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActivityWatchUnreachableError);
    expect((error as ActivityWatchUnreachableError).timedOut).toBe(true);
  });

  it("maps a non-JSON body to a parse error with no zod issue", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/api/0/info", method: "GET" })
      .reply(200, "<<not json>>", JSON_HEADERS);

    const error = await makeClient()
      .getInfo()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActivityWatchParseError);
    expect((error as ActivityWatchParseError).zodError).toBeUndefined();
  });

  it("uses the noop logger by default when an entry is skipped", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/api/0/buckets/", method: "GET" })
      .reply(200, { bad: { id: 7 } }, JSON_HEADERS);

    // No logger injected: exercises the default noop path without throwing.
    await expect(makeClient().listBuckets()).resolves.toEqual([]);
  });
});
