import { describe, expect, it } from "vitest";

import {
  bridgeConfigSchema,
  ConfigError,
  DEFAULT_SOCKET_DIR,
  DEFAULT_SOCKET_MODE,
  loadConfigFromEnv,
  socketPathForUid,
  type BridgeConfig,
  type BridgeEnv,
} from "../../src/bridge/config.js";

const VALID_ENV: BridgeEnv = {
  PCT_BRIDGE_SERVER_URL: "wss://dash.example/api/events/stream",
  PCT_BRIDGE_TOKEN: "tok_abc123",
  PCT_BRIDGE_USERS: JSON.stringify([{ userId: 7, linuxUid: 1001 }]),
};

describe("bridgeConfigSchema", () => {
  it("applies defaults for socketDir, socketMode, and backoff", () => {
    const parsed = bridgeConfigSchema.parse({
      serverUrl: "wss://d/api/events/stream",
      token: "t",
      users: [{ userId: 1, linuxUid: 1000 }],
    });
    expect(parsed.socketDir).toBe(DEFAULT_SOCKET_DIR);
    expect(parsed.socketMode).toBe(DEFAULT_SOCKET_MODE);
    expect(parsed.backoff).toEqual({ baseMs: 1_000, maxMs: 60_000 });
  });

  it("accepts ws:// and wss:// but rejects other schemes", () => {
    const base = { token: "t", users: [{ userId: 1, linuxUid: 1000 }] };
    expect(bridgeConfigSchema.safeParse({ ...base, serverUrl: "ws://d/s" }).success).toBe(true);
    expect(bridgeConfigSchema.safeParse({ ...base, serverUrl: "wss://d/s" }).success).toBe(true);
    expect(bridgeConfigSchema.safeParse({ ...base, serverUrl: "https://d/s" }).success).toBe(false);
  });

  it("requires at least one user", () => {
    expect(
      bridgeConfigSchema.safeParse({ serverUrl: "wss://d/s", token: "t", users: [] }).success,
    ).toBe(false);
  });

  it("rejects duplicate userId or linuxUid", () => {
    const dupUser = bridgeConfigSchema.safeParse({
      serverUrl: "wss://d/s",
      token: "t",
      users: [
        { userId: 1, linuxUid: 1000 },
        { userId: 1, linuxUid: 1001 },
      ],
    });
    expect(dupUser.success).toBe(false);

    const dupUid = bridgeConfigSchema.safeParse({
      serverUrl: "wss://d/s",
      token: "t",
      users: [
        { userId: 1, linuxUid: 1000 },
        { userId: 2, linuxUid: 1000 },
      ],
    });
    expect(dupUid.success).toBe(false);
  });

  it("rejects a backoff where maxMs < baseMs", () => {
    const r = bridgeConfigSchema.safeParse({
      serverUrl: "wss://d/s",
      token: "t",
      users: [{ userId: 1, linuxUid: 1000 }],
      backoff: { baseMs: 5_000, maxMs: 1_000 },
    });
    expect(r.success).toBe(false);
  });
});

describe("socketPathForUid", () => {
  const cfg: BridgeConfig = bridgeConfigSchema.parse({
    serverUrl: "wss://d/api/events/stream",
    token: "t",
    users: [{ userId: 1, linuxUid: 1000 }],
  });

  it("builds /run/pct/<uid>.sock under the default dir", () => {
    expect(socketPathForUid(cfg, 1001)).toBe("/run/pct/1001.sock");
  });

  it("normalises a trailing slash on socketDir", () => {
    const withSlash = { ...cfg, socketDir: "/tmp/pct/" };
    expect(socketPathForUid(withSlash, 5)).toBe("/tmp/pct/5.sock");
  });
});

describe("loadConfigFromEnv", () => {
  it("builds a config from a valid environment", () => {
    const cfg = loadConfigFromEnv(VALID_ENV);
    expect(cfg.serverUrl).toBe(VALID_ENV.PCT_BRIDGE_SERVER_URL);
    expect(cfg.token).toBe("tok_abc123");
    expect(cfg.users).toEqual([{ userId: 7, linuxUid: 1001 }]);
  });

  it("reads optional socketDir, octal socketMode, and backoff overrides", () => {
    const cfg = loadConfigFromEnv({
      ...VALID_ENV,
      PCT_BRIDGE_SOCKET_DIR: "/tmp/pct",
      PCT_BRIDGE_SOCKET_MODE: "0o660",
      PCT_BRIDGE_BACKOFF_BASE_MS: "500",
      PCT_BRIDGE_BACKOFF_MAX_MS: "5000",
    });
    expect(cfg.socketDir).toBe("/tmp/pct");
    expect(cfg.socketMode).toBe(0o660);
    expect(cfg.backoff).toEqual({ baseMs: 500, maxMs: 5000 });
  });

  it("throws ConfigError on malformed PCT_BRIDGE_USERS JSON", () => {
    expect(() => loadConfigFromEnv({ ...VALID_ENV, PCT_BRIDGE_USERS: "{bad" })).toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError when a required value is missing", () => {
    const noToken: BridgeEnv = { ...VALID_ENV };
    delete noToken.PCT_BRIDGE_TOKEN;
    expect(() => loadConfigFromEnv(noToken)).toThrow(ConfigError);
  });

  it("throws ConfigError on a non-numeric socketMode", () => {
    expect(() => loadConfigFromEnv({ ...VALID_ENV, PCT_BRIDGE_SOCKET_MODE: "nope" })).toThrow(
      /PCT_BRIDGE_SOCKET_MODE is not a number/,
    );
  });

  it("rejects an empty/whitespace socketMode rather than coercing it to 0", () => {
    // `Number("")` is 0, which would yield an unusable 0o000 socket; reject it.
    expect(() => loadConfigFromEnv({ ...VALID_ENV, PCT_BRIDGE_SOCKET_MODE: "  " })).toThrow(
      /PCT_BRIDGE_SOCKET_MODE is empty/,
    );
  });
});
