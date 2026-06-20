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
    expect(settings.defaultTz).toBe("UTC");
    expect(settings.logLevel).toBe("info");
    expect(settings.secretKey).toBeUndefined();
    expect(settings.ansibleDir).toBe("/data/ansible");
    expect(settings.adguard).toEqual({ mode: "disabled" });
    expect(settings.telemetry).toEqual({ pullCron: "*/5 * * * *", pullConcurrency: 4 });
    expect(settings.reapply).toEqual({ cron: "0 * * * *", playbooks: [] });
  });

  it("honours an explicit PCT_ANSIBLE_DIR", () => {
    expect(loadSettings({ PCT_ANSIBLE_DIR: "/srv/ansible" }).ansibleDir).toBe("/srv/ansible");
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

  // DATABASE_URL is accepted as a bare path or a libsql `file:` URL; both
  // must resolve to the same bare better-sqlite3 path so drizzle-kit (CI /
  // drizzle.config.ts) and the runtime connection never diverge. See #34.
  describe("DATABASE_URL normalization", () => {
    it("strips a file: scheme from an absolute path", () => {
      expect(loadSettings({ DATABASE_URL: "file:/data/policy.sqlite" }).databaseUrl).toBe(
        "/data/policy.sqlite",
      );
    });

    it("strips a file: scheme from a relative path (the CI form)", () => {
      expect(loadSettings({ DATABASE_URL: "file:./ci_migration_test.sqlite" }).databaseUrl).toBe(
        "./ci_migration_test.sqlite",
      );
    });

    it("leaves a bare path untouched", () => {
      expect(loadSettings({ DATABASE_URL: "/srv/policy.sqlite" }).databaseUrl).toBe(
        "/srv/policy.sqlite",
      );
    });

    it("normalizes the default the same way (bare, no scheme to strip)", () => {
      expect(loadSettings({}).databaseUrl).toBe("/data/policy.sqlite");
    });
  });

  it("rejects an invalid log level", () => {
    expect(() => loadSettings({ PCT_LOG_LEVEL: "verbose" })).toThrow(SettingsError);
  });

  describe("PCT_DEFAULT_TZ", () => {
    it("defaults to UTC when unset", () => {
      expect(loadSettings({}).defaultTz).toBe("UTC");
    });

    it("round-trips a valid IANA zone", () => {
      expect(loadSettings({ PCT_DEFAULT_TZ: "America/New_York" }).defaultTz).toBe(
        "America/New_York",
      );
    });

    it("rejects an invalid IANA zone with a readable error", () => {
      expect(() => loadSettings({ PCT_DEFAULT_TZ: "Mars/Olympus_Mons" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_DEFAULT_TZ: "Mars/Olympus_Mons" })).toThrow(
        /valid IANA timezone/,
      );
    });
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

  describe("PCT_TELEMETRY_*", () => {
    it("honours an explicit cron pattern and concurrency", () => {
      const settings = loadSettings({
        PCT_TELEMETRY_PULL_CRON: "0 */2 * * *",
        PCT_TELEMETRY_PULL_CONCURRENCY: "8",
      });

      expect(settings.telemetry).toEqual({ pullCron: "0 */2 * * *", pullConcurrency: 8 });
    });

    it("rejects an invalid cron pattern with a readable error", () => {
      expect(() => loadSettings({ PCT_TELEMETRY_PULL_CRON: "not a cron" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_TELEMETRY_PULL_CRON: "not a cron" })).toThrow(
        /valid cron pattern/,
      );
    });

    it("rejects a non-positive or non-numeric concurrency", () => {
      expect(() => loadSettings({ PCT_TELEMETRY_PULL_CONCURRENCY: "0" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_TELEMETRY_PULL_CONCURRENCY: "-3" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_TELEMETRY_PULL_CONCURRENCY: "many" })).toThrow(SettingsError);
    });
  });

  describe("PCT_REAPPLY_*", () => {
    it("honours an explicit cron and a comma-separated playbook list", () => {
      const settings = loadSettings({
        PCT_REAPPLY_CRON: "0 */6 * * *",
        PCT_REAPPLY_PLAYBOOKS: "e2guardian.yml, activitywatch.yml ,apparmor.yml",
      });

      expect(settings.reapply).toEqual({
        cron: "0 */6 * * *",
        // Whitespace around each entry is trimmed and empties dropped.
        playbooks: ["e2guardian.yml", "activitywatch.yml", "apparmor.yml"],
      });
    });

    it("rejects an invalid cron pattern with a readable error", () => {
      expect(() => loadSettings({ PCT_REAPPLY_CRON: "not a cron" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_REAPPLY_CRON: "not a cron" })).toThrow(/valid cron pattern/);
    });

    it("rejects a playbook name with path separators", () => {
      expect(() => loadSettings({ PCT_REAPPLY_PLAYBOOKS: "../escape.yml" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_REAPPLY_PLAYBOOKS: "ok.yml,sub/dir.yml" })).toThrow(
        /bare playbook file name/,
      );
    });
  });
});
