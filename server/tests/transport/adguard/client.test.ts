/**
 * Unit tests for the AdGuard Home REST client.
 *
 * Follows `docs/testing.md` → "Transport — REST": undici's `MockAgent`
 * intercepts HTTP so no live AdGuard instance is needed for the happy / auth /
 * non-2xx / malformed paths, and `replyWithError` simulates a connection
 * failure. The client is driven with undici's `fetch` bound to the mock agent
 * via its `dispatcher` option (Node's global `fetch` does not honour the npm
 * undici package's global dispatcher, so per-request injection is both correct
 * and leak-free across tests). The deterministic timeout path uses an injected
 * `fetch` that honours the abort signal, avoiding a flaky delayed reply. The
 * `pct:`-prefix guard is proven with a `fetch` that throws if reached.
 */
import { MockAgent, fetch as undiciFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdGuardAuthError,
  AdGuardHomeClient,
  AdGuardParseError,
  AdGuardRequestError,
  AdGuardScopeError,
  AdGuardUnreachableError,
  DEFAULT_CLIENT_PREFIX,
  type AdGuardClientOptions,
  type FetchLike,
} from "../../../src/transport/adguard/index.js";

const BASE_URL = "http://adguard.lan";

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
function makeClient(extra: Partial<Omit<AdGuardClientOptions, "baseUrl">> = {}): AdGuardHomeClient {
  return new AdGuardHomeClient({ baseUrl: BASE_URL, fetch: mockFetch(), ...extra });
}

/** A fetch that fails the test if it is ever called (proves a pre-request guard fired). */
const explodingFetch: FetchLike = () => {
  throw new Error("fetch should not have been called");
};

describe("AdGuardHomeClient construction", () => {
  it("strips trailing slashes from the base URL", () => {
    const client = new AdGuardHomeClient({ baseUrl: "http://adguard.lan///" });
    expect(client.baseUrl).toBe("http://adguard.lan");
  });

  it("defaults the managed-client prefix to pct:", () => {
    expect(makeClient().clientPrefix).toBe(DEFAULT_CLIENT_PREFIX);
    expect(DEFAULT_CLIENT_PREFIX).toBe("pct:");
  });

  it("honours a custom client prefix", () => {
    expect(makeClient({ clientPrefix: "home:" }).clientPrefix).toBe("home:");
  });
});

describe("authentication header", () => {
  it("sends HTTP Basic auth for basic credentials", async () => {
    let seen: Record<string, unknown> | undefined;
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/status", method: "GET" })
      .reply(
        200,
        (opts) => {
          seen = opts.headers as Record<string, unknown>;
          return { version: "v0.107.0", running: true, protection_enabled: true };
        },
        JSON_HEADERS,
      );

    await makeClient({ auth: { kind: "basic", username: "pct", password: "s3cret" } }).getStatus();

    const expected = `Basic ${Buffer.from("pct:s3cret").toString("base64")}`;
    expect(seen?.authorization).toBe(expected);
    expect(seen?.accept).toBe("application/json");
  });

  it("sends a Bearer token for bearer credentials", async () => {
    let seen: Record<string, unknown> | undefined;
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/status", method: "GET" })
      .reply(
        200,
        (opts) => {
          seen = opts.headers as Record<string, unknown>;
          return { version: "v0.107.0", running: true, protection_enabled: true };
        },
        JSON_HEADERS,
      );

    await makeClient({ auth: { kind: "bearer", token: "tok-123" } }).getStatus();

    expect(seen?.authorization).toBe("Bearer tok-123");
  });

  it("sends no authorization header when no credentials are configured", async () => {
    let seen: Record<string, unknown> | undefined;
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/status", method: "GET" })
      .reply(
        200,
        (opts) => {
          seen = opts.headers as Record<string, unknown>;
          return { version: "v0.107.0", running: true, protection_enabled: true };
        },
        JSON_HEADERS,
      );

    await makeClient().getStatus();

    expect(seen?.authorization).toBeUndefined();
  });
});

describe("getStatus", () => {
  it("returns parsed status on the happy path", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/status", method: "GET" })
      .reply(
        200,
        {
          version: "v0.107.52",
          running: true,
          protection_enabled: false,
          dns_addresses: ["192.168.1.2"],
          dns_port: 53,
          extra_field_we_ignore: 42,
        },
        JSON_HEADERS,
      );

    const status = await makeClient().getStatus();

    expect(status.version).toBe("v0.107.52");
    expect(status.running).toBe(true);
    expect(status.protection_enabled).toBe(false);
    expect(status.dns_addresses).toEqual(["192.168.1.2"]);
  });

  it("rejects a schema-mismatched body with AdGuardParseError", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/status", method: "GET" })
      .reply(200, { running: true }, JSON_HEADERS); // missing version + protection_enabled

    await expect(makeClient().getStatus()).rejects.toBeInstanceOf(AdGuardParseError);
  });

  it("rejects a non-JSON body with AdGuardParseError", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/status", method: "GET" })
      .reply(200, "not json", { headers: { "content-type": "text/plain" } });

    const error = await makeClient()
      .getStatus()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdGuardParseError);
    expect((error as AdGuardParseError).zodError).toBeUndefined();
  });
});

describe("listClients / listManagedClients", () => {
  const body = {
    clients: [
      { name: "pct:alice-laptop", ids: ["192.168.1.10"], filtering_enabled: true },
      { name: "household-tv", ids: ["192.168.1.20"] },
      { name: "pct:bob-desktop", ids: ["AA:BB:CC:DD:EE:FF"], blocked_services: ["youtube"] },
    ],
    auto_clients: [{ name: "auto", ip: "192.168.1.99" }],
    supported_tags: ["device_phone"],
  };

  it("returns every persistent client", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/clients", method: "GET" })
      .reply(200, body, JSON_HEADERS);

    const clients = await makeClient().listClients();
    expect(clients.map((c) => c.name)).toEqual([
      "pct:alice-laptop",
      "household-tv",
      "pct:bob-desktop",
    ]);
    expect(clients[2]?.blocked_services).toEqual(["youtube"]);
  });

  it("filters managed clients to the pct: prefix", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/clients", method: "GET" })
      .reply(200, body, JSON_HEADERS);

    const managed = await makeClient().listManagedClients();
    expect(managed.map((c) => c.name)).toEqual(["pct:alice-laptop", "pct:bob-desktop"]);
  });

  it("treats a missing clients key as an empty list", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/clients", method: "GET" })
      .reply(200, {}, JSON_HEADERS);

    expect(await makeClient().listClients()).toEqual([]);
  });

  it("rejects a non-object body with AdGuardParseError", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/clients", method: "GET" })
      .reply(200, [], JSON_HEADERS);

    await expect(makeClient().listClients()).rejects.toBeInstanceOf(AdGuardParseError);
  });
});

describe("addClient", () => {
  it("POSTs the client body to /control/clients/add on a managed name", async () => {
    let seenBody: string | undefined;
    let seenContentType: unknown;
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/clients/add", method: "POST" })
      .reply(200, (opts) => {
        seenBody = opts.body as string;
        seenContentType = (opts.headers as Record<string, unknown>)["content-type"];
        return "";
      });

    const client = { name: "pct:alice-laptop", ids: ["192.168.1.10"], filtering_enabled: true };
    await makeClient().addClient(client);

    expect(JSON.parse(seenBody ?? "")).toEqual(client);
    expect(seenContentType).toBe("application/json");
  });

  it("refuses an unmanaged name without issuing a request", async () => {
    const client = makeClient({ fetch: explodingFetch });
    await expect(client.addClient({ name: "household-tv", ids: [] })).rejects.toBeInstanceOf(
      AdGuardScopeError,
    );
  });

  it("surfaces the offending name and required prefix on the scope error", async () => {
    const error = await makeClient({ fetch: explodingFetch })
      .addClient({ name: "tv", ids: [] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdGuardScopeError);
    expect((error as AdGuardScopeError).clientName).toBe("tv");
    expect((error as AdGuardScopeError).requiredPrefix).toBe("pct:");
  });
});

describe("updateClient", () => {
  it("POSTs { name, data } to /control/clients/update", async () => {
    let seenBody: string | undefined;
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/clients/update", method: "POST" })
      .reply(200, (opts) => {
        seenBody = opts.body as string;
        return "";
      });

    const data = { name: "pct:alice-laptop", ids: ["192.168.1.11"] };
    await makeClient().updateClient("pct:alice-laptop", data);

    expect(JSON.parse(seenBody ?? "")).toEqual({ name: "pct:alice-laptop", data });
  });

  it("refuses an unmanaged existing name", async () => {
    await expect(
      makeClient({ fetch: explodingFetch }).updateClient("tv", { name: "pct:tv", ids: [] }),
    ).rejects.toBeInstanceOf(AdGuardScopeError);
  });

  it("refuses renaming a managed client out of the namespace", async () => {
    await expect(
      makeClient({ fetch: explodingFetch }).updateClient("pct:alice", { name: "alice", ids: [] }),
    ).rejects.toBeInstanceOf(AdGuardScopeError);
  });
});

describe("deleteClient", () => {
  it("POSTs { name } to /control/clients/delete", async () => {
    let seenBody: string | undefined;
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/clients/delete", method: "POST" })
      .reply(200, (opts) => {
        seenBody = opts.body as string;
        return "";
      });

    await makeClient().deleteClient("pct:alice-laptop");
    expect(JSON.parse(seenBody ?? "")).toEqual({ name: "pct:alice-laptop" });
  });

  it("refuses an unmanaged name", async () => {
    await expect(
      makeClient({ fetch: explodingFetch }).deleteClient("household-tv"),
    ).rejects.toBeInstanceOf(AdGuardScopeError);
  });
});

describe("user rules", () => {
  it("getUserRules returns the user_rules list", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/filtering/status", method: "GET" })
      .reply(
        200,
        { enabled: true, interval: 24, user_rules: ["||ads.example^", "! note"] },
        JSON_HEADERS,
      );

    expect(await makeClient().getUserRules()).toEqual(["||ads.example^", "! note"]);
  });

  it("treats a missing user_rules key as empty", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/filtering/status", method: "GET" })
      .reply(200, { enabled: false }, JSON_HEADERS);

    expect(await makeClient().getUserRules()).toEqual([]);
  });

  it("setUserRules POSTs { rules } to /control/filtering/set_rules", async () => {
    let seenBody: string | undefined;
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/filtering/set_rules", method: "POST" })
      .reply(200, (opts) => {
        seenBody = opts.body as string;
        return "";
      });

    await makeClient().setUserRules(["||ads.example^"]);
    expect(JSON.parse(seenBody ?? "")).toEqual({ rules: ["||ads.example^"] });
  });
});

describe("error mapping", () => {
  it("maps 401 to AdGuardAuthError (a subclass of AdGuardRequestError)", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/status", method: "GET" })
      .reply(401, "Unauthorized");

    const error = await makeClient()
      .getStatus()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdGuardAuthError);
    expect(error).toBeInstanceOf(AdGuardRequestError);
    expect((error as AdGuardAuthError).statusCode).toBe(401);
  });

  it("maps 403 to AdGuardAuthError", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/status", method: "GET" })
      .reply(403, "Forbidden");
    await expect(makeClient().getStatus()).rejects.toBeInstanceOf(AdGuardAuthError);
  });

  it("maps other non-2xx to AdGuardRequestError (not auth)", async () => {
    agent.get(BASE_URL).intercept({ path: "/control/status", method: "GET" }).reply(500, "boom");

    const error = await makeClient()
      .getStatus()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdGuardRequestError);
    expect(error).not.toBeInstanceOf(AdGuardAuthError);
    expect((error as AdGuardRequestError).statusCode).toBe(500);
  });

  it("maps a non-2xx on a write to AdGuardRequestError", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/clients/add", method: "POST" })
      .reply(400, "bad client");

    await expect(makeClient().addClient({ name: "pct:x", ids: [] })).rejects.toBeInstanceOf(
      AdGuardRequestError,
    );
  });

  it("maps a thrown fetch (connection refused) to AdGuardUnreachableError", async () => {
    agent
      .get(BASE_URL)
      .intercept({ path: "/control/status", method: "GET" })
      .replyWithError(new Error("ECONNREFUSED"));

    const error = await makeClient()
      .getStatus()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdGuardUnreachableError);
    expect((error as AdGuardUnreachableError).timedOut).toBe(false);
  });

  it("maps the per-request abort timeout to AdGuardUnreachableError with timedOut", async () => {
    const hangingFetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "TimeoutError";
          reject(err);
        });
      });

    const error = await new AdGuardHomeClient({
      baseUrl: BASE_URL,
      fetch: hangingFetch,
      timeoutMs: 5,
    })
      .getStatus()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdGuardUnreachableError);
    expect((error as AdGuardUnreachableError).timedOut).toBe(true);
  });
});
