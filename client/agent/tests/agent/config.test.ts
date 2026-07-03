import { describe, expect, it } from "vitest";

import {
  agentConfigSchema,
  AgentConfigError,
  DEFAULT_AW_BASE_URL,
  DEFAULT_GRACE_SECONDS,
  DEFAULT_SOUND_PROFILE,
  defaultNotificationPrefs,
  loadConfigFromEnv,
} from "../../src/agent/config.js";

describe("agentConfigSchema", () => {
  it("applies defaults for the optional fields", () => {
    const cfg = agentConfigSchema.parse({ userId: 7, socketPath: "/run/pct/1001.sock" });
    expect(cfg.awBaseUrl).toBe(DEFAULT_AW_BASE_URL);
    expect(cfg.backoff).toEqual({ baseMs: 1_000, maxMs: 60_000 });
    expect(cfg.tickIntervalMs).toBe(1_000);
    expect(cfg.notifications).toEqual({
      enabled: true,
      soundProfile: DEFAULT_SOUND_PROFILE,
      graceSeconds: DEFAULT_GRACE_SECONDS,
      cadenceOverrides: null,
    });
  });

  it("requires a positive userId and a non-empty socketPath", () => {
    expect(agentConfigSchema.safeParse({ userId: 0, socketPath: "/s" }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ userId: 7, socketPath: "" }).success).toBe(false);
  });

  it("rejects a backoff where maxMs < baseMs", () => {
    const r = agentConfigSchema.safeParse({
      userId: 7,
      socketPath: "/s",
      backoff: { baseMs: 5_000, maxMs: 1_000 },
    });
    expect(r.success).toBe(false);
  });

  it("bounds graceSeconds to 0..60 and validates the sound profile", () => {
    const base = { userId: 7, socketPath: "/s" };
    expect(
      agentConfigSchema.safeParse({ ...base, notifications: { graceSeconds: 61 } }).success,
    ).toBe(false);
    expect(
      agentConfigSchema.safeParse({ ...base, notifications: { soundProfile: "loud" } }).success,
    ).toBe(false);
    expect(
      agentConfigSchema.safeParse({ ...base, notifications: { soundProfile: "prominent" } })
        .success,
    ).toBe(true);
  });
});

describe("defaultNotificationPrefs", () => {
  it("returns the documented defaults", () => {
    expect(defaultNotificationPrefs()).toEqual({
      enabled: true,
      soundProfile: "subtle",
      graceSeconds: 15,
      cadenceOverrides: null,
    });
  });
});

describe("loadConfigFromEnv", () => {
  it("builds a config from the minimal required environment", () => {
    const cfg = loadConfigFromEnv({
      PCT_AGENT_USER_ID: "7",
      PCT_AGENT_SOCKET: "/run/pct/1001.sock",
    });
    expect(cfg.userId).toBe(7);
    expect(cfg.socketPath).toBe("/run/pct/1001.sock");
    expect(cfg.awBaseUrl).toBe(DEFAULT_AW_BASE_URL);
  });

  it("reads optional overrides", () => {
    const cfg = loadConfigFromEnv({
      PCT_AGENT_USER_ID: "7",
      PCT_AGENT_SOCKET: "/s",
      PCT_AGENT_AW_URL: "http://127.0.0.1:5666",
      PCT_AGENT_TICK_MS: "500",
      PCT_AGENT_SIGKILL_MS: "8000",
      PCT_AGENT_BACKOFF_BASE_MS: "250",
      PCT_AGENT_BACKOFF_MAX_MS: "5000",
    });
    expect(cfg.awBaseUrl).toBe("http://127.0.0.1:5666");
    expect(cfg.tickIntervalMs).toBe(500);
    expect(cfg.sigkillEscalationMs).toBe(8000);
    expect(cfg.backoff).toEqual({ baseMs: 250, maxMs: 5000 });
  });

  it("treats blank optional overrides as absent (keeps defaults)", () => {
    const cfg = loadConfigFromEnv({
      PCT_AGENT_USER_ID: "7",
      PCT_AGENT_SOCKET: "/s",
      PCT_AGENT_TICK_MS: "  ",
    });
    expect(cfg.tickIntervalMs).toBe(1_000);
  });

  it("throws AgentConfigError when a required value is missing", () => {
    expect(() => loadConfigFromEnv({ PCT_AGENT_SOCKET: "/s" })).toThrow(AgentConfigError);
    expect(() => loadConfigFromEnv({ PCT_AGENT_USER_ID: "7" })).toThrow(AgentConfigError);
  });

  it("throws AgentConfigError on a non-numeric userId", () => {
    expect(() => loadConfigFromEnv({ PCT_AGENT_USER_ID: "nope", PCT_AGENT_SOCKET: "/s" })).toThrow(
      AgentConfigError,
    );
  });
});
