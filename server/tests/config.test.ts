/**
 * Settings loader: env round-trip plus the failure paths.
 *
 * loadSettings() takes an explicit env map, so these tests never touch the
 * real process.env.
 */
import { describe, expect, it } from "vitest";
import { loadSettings, SettingsError } from "../src/config.js";

describe("loadSettings", () => {
  it("applies defaults for an empty environment", () => {
    const settings = loadSettings({});

    expect(settings.databaseUrl).toBe("/data/policy.sqlite");
    expect(settings.logLevel).toBe("info");
    expect(settings.secretKey).toBeUndefined();
    expect(settings.adguard).toEqual({ mode: "disabled" });
  });

  it("round-trips explicit base values", () => {
    const settings = loadSettings({
      DATABASE_URL: "/srv/policy.sqlite",
      PCT_LOG_LEVEL: "debug",
      PCT_SECRET_KEY: "s3cret",
      PCT_ADGUARD_MODE: "disabled",
    });

    expect(settings.databaseUrl).toBe("/srv/policy.sqlite");
    expect(settings.logLevel).toBe("debug");
    expect(settings.secretKey).toBe("s3cret");
  });

  it("rejects an invalid log level", () => {
    expect(() => loadSettings({ PCT_LOG_LEVEL: "verbose" })).toThrow(SettingsError);
  });

  it("rejects an unknown AdGuard mode with a readable error", () => {
    try {
      loadSettings({ PCT_ADGUARD_MODE: "enabled" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SettingsError);
      expect((err as SettingsError).message).toContain("Invalid configuration");
      // The formatted issue names the offending field, not a raw stack.
      expect((err as SettingsError).message).toContain("mode");
    }
  });

  describe("external mode", () => {
    it("parses url and credential file", () => {
      const settings = loadSettings({
        PCT_ADGUARD_MODE: "external",
        PCT_ADGUARD_URL: "https://adguard.lan",
        PCT_ADGUARD_USERNAME: "parental-controls",
        PCT_ADGUARD_PASSWORD_FILE: "/run/secrets/adguard_password",
      });

      expect(settings.adguard).toEqual({
        mode: "external",
        url: "https://adguard.lan",
        username: "parental-controls",
        passwordFile: "/run/secrets/adguard_password",
      });
    });

    it("accepts an API token file instead of a password", () => {
      const settings = loadSettings({
        PCT_ADGUARD_MODE: "external",
        PCT_ADGUARD_URL: "https://adguard.lan",
        PCT_ADGUARD_API_TOKEN_FILE: "/run/secrets/adguard_token",
      });

      expect(settings.adguard.mode).toBe("external");
    });

    it("requires a valid url", () => {
      expect(() =>
        loadSettings({
          PCT_ADGUARD_MODE: "external",
          PCT_ADGUARD_URL: "not-a-url",
          PCT_ADGUARD_PASSWORD_FILE: "/run/secrets/adguard_password",
        }),
      ).toThrow(SettingsError);
    });

    it("requires a password file or api token file", () => {
      expect(() =>
        loadSettings({
          PCT_ADGUARD_MODE: "external",
          PCT_ADGUARD_URL: "https://adguard.lan",
        }),
      ).toThrow(/PCT_ADGUARD_PASSWORD_FILE or PCT_ADGUARD_API_TOKEN_FILE/);
    });

    it("requires a username when a password file is set (HTTP basic auth)", () => {
      expect(() =>
        loadSettings({
          PCT_ADGUARD_MODE: "external",
          PCT_ADGUARD_URL: "https://adguard.lan",
          PCT_ADGUARD_PASSWORD_FILE: "/run/secrets/adguard_password",
        }),
      ).toThrow(/PCT_ADGUARD_PASSWORD_FILE requires PCT_ADGUARD_USERNAME/);
    });
  });

  describe("managed mode", () => {
    it("defaults bind address and admin port", () => {
      const settings = loadSettings({ PCT_ADGUARD_MODE: "managed" });

      expect(settings.adguard).toEqual({
        mode: "managed",
        bindAddr: "0.0.0.0:53",
        adminPort: 3000,
      });
    });

    it("coerces the admin port from a string", () => {
      const settings = loadSettings({
        PCT_ADGUARD_MODE: "managed",
        PCT_ADGUARD_BIND_ADDR: "127.0.0.1:5353",
        PCT_ADGUARD_ADMIN_PORT: "8080",
      });

      expect(settings.adguard).toMatchObject({
        bindAddr: "127.0.0.1:5353",
        adminPort: 8080,
      });
    });

    it("rejects a non-numeric admin port", () => {
      expect(() =>
        loadSettings({
          PCT_ADGUARD_MODE: "managed",
          PCT_ADGUARD_ADMIN_PORT: "not-a-port",
        }),
      ).toThrow(SettingsError);
    });
  });
});
