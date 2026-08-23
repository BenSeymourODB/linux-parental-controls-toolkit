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
    expect(settings.trustProxy).toBe(false);
    expect(settings.secretKey).toBeUndefined();
    expect(settings.ansibleDir).toBe("/data/ansible");
    expect(settings.ansibleCoreVersion).toBe("2.18.1");
    expect(settings.ansiblePlaybookSourceDir).toBe("/app/ansible/playbooks");
    expect(settings.sshPublicKeyPath).toBe("/data/secrets/ssh/id_ed25519.pub");
    expect(settings.sshPrivateKeyPath).toBe("/data/secrets/ssh/id_ed25519");
    expect(settings.adguard).toEqual({ mode: "disabled" });
    expect(settings.timekprMirror).toEqual({ mode: "disabled" });
    expect(settings.telemetry).toEqual({ pullCron: "*/5 * * * *", pullConcurrency: 4 });
    expect(settings.enforcement).toEqual({ cooldownSeconds: 300, initialLookbackSeconds: 900 });
    expect(settings.retention).toEqual({ defaultDays: 365 });
    expect(settings.reapply).toEqual({ cron: "0 * * * *", playbooks: [] });
    expect(settings.exceptionPush).toEqual({ cron: "*/15 * * * *" });
    expect(settings.clientHealth).toEqual({ probeConcurrency: 4, probeDeadlineMs: 15000 });
    expect(settings.preMigrationBackup).toEqual({ enabled: true, retain: 5 });
    expect(settings.serverVersion).toBeUndefined();
    expect(settings.protocolCompatWindow).toBe(1);
  });

  describe("version drift settings (#352)", () => {
    it("reads PCT_SERVER_VERSION verbatim", () => {
      expect(loadSettings({ PCT_SERVER_VERSION: "0.1.0-alpha.5" }).serverVersion).toBe(
        "0.1.0-alpha.5",
      );
    });

    it("treats an empty/whitespace PCT_SERVER_VERSION as unset (the no-build-arg image)", () => {
      // `docker build` with no --build-arg sets ENV PCT_SERVER_VERSION="" — present
      // but empty. It must degrade to "no verdict", not crash startup on .min(1).
      expect(loadSettings({ PCT_SERVER_VERSION: "" }).serverVersion).toBeUndefined();
      expect(loadSettings({ PCT_SERVER_VERSION: "   " }).serverVersion).toBeUndefined();
    });

    it("coerces PCT_PROTOCOL_COMPAT_WINDOW and rejects non-positive / non-integer values", () => {
      expect(loadSettings({ PCT_PROTOCOL_COMPAT_WINDOW: "2" }).protocolCompatWindow).toBe(2);
      expect(() => loadSettings({ PCT_PROTOCOL_COMPAT_WINDOW: "0" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_PROTOCOL_COMPAT_WINDOW: "-1" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_PROTOCOL_COMPAT_WINDOW: "1.5" })).toThrow(SettingsError);
    });
  });

  describe("pre-migration backup (#166)", () => {
    it("defaults to enabled with retain 5 and no explicit dir", () => {
      const { preMigrationBackup } = loadSettings({});
      expect(preMigrationBackup).toEqual({ enabled: true, retain: 5 });
      expect(preMigrationBackup.dir).toBeUndefined();
    });

    it("honours explicit overrides", () => {
      const { preMigrationBackup } = loadSettings({
        PCT_PRE_MIGRATION_BACKUP: "false",
        PCT_PRE_MIGRATION_BACKUP_DIR: "/srv/backups",
        PCT_PRE_MIGRATION_BACKUP_RETAIN: "3",
      });
      expect(preMigrationBackup).toEqual({ enabled: false, dir: "/srv/backups", retain: 3 });
    });

    it("rejects a non-positive retain count", () => {
      expect(() => loadSettings({ PCT_PRE_MIGRATION_BACKUP_RETAIN: "0" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_PRE_MIGRATION_BACKUP_RETAIN: "-1" })).toThrow(SettingsError);
    });

    it("rejects a non-numeric retain count", () => {
      expect(() => loadSettings({ PCT_PRE_MIGRATION_BACKUP_RETAIN: "lots" })).toThrow(
        SettingsError,
      );
    });
  });

  it("honours an explicit PCT_ANSIBLE_DIR", () => {
    expect(loadSettings({ PCT_ANSIBLE_DIR: "/srv/ansible" }).ansibleDir).toBe("/srv/ansible");
  });

  describe("PCT_RETENTION_DEFAULT_DAYS", () => {
    it("coerces an explicit day count", () => {
      expect(loadSettings({ PCT_RETENTION_DEFAULT_DAYS: "30" }).retention.defaultDays).toBe(30);
    });

    it("rejects zero / negative windows", () => {
      expect(() => loadSettings({ PCT_RETENTION_DEFAULT_DAYS: "0" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_RETENTION_DEFAULT_DAYS: "-5" })).toThrow(SettingsError);
    });

    it("rejects a non-integer window", () => {
      expect(() => loadSettings({ PCT_RETENTION_DEFAULT_DAYS: "12.5" })).toThrow(SettingsError);
    });

    it("rejects an absurdly large window (use keep-forever instead)", () => {
      expect(() => loadSettings({ PCT_RETENTION_DEFAULT_DAYS: "99999999" })).toThrow(SettingsError);
    });
  });

  it("honours explicit Ansible venv bootstrap settings", () => {
    const settings = loadSettings({
      PCT_ANSIBLE_CORE_VERSION: "2.17.6",
      PCT_ANSIBLE_PLAYBOOK_SRC: "/opt/playbooks",
    });
    expect(settings.ansibleCoreVersion).toBe("2.17.6");
    expect(settings.ansiblePlaybookSourceDir).toBe("/opt/playbooks");
  });

  it("rejects a non-version PCT_ANSIBLE_CORE_VERSION", () => {
    expect(() => loadSettings({ PCT_ANSIBLE_CORE_VERSION: "latest; rm -rf /" })).toThrow(
      /bare version/,
    );
  });

  it("honours explicit SSH key paths", () => {
    const settings = loadSettings({
      PCT_SSH_PUBLIC_KEY_PATH: "/keys/server.pub",
      PCT_SSH_PRIVATE_KEY_PATH: "/keys/server",
    });
    expect(settings.sshPublicKeyPath).toBe("/keys/server.pub");
    expect(settings.sshPrivateKeyPath).toBe("/keys/server");
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
    it("defaults bind address, admin port, and data dir (version unset)", () => {
      const settings = loadSettings({ PCT_ADGUARD_MODE: "managed" });

      expect(settings.adguard).toEqual({
        mode: "managed",
        bindAddr: "0.0.0.0:53",
        adminPort: 3000,
        dataDir: "/data/adguard",
      });
    });

    it("honours an explicit data dir and pinned version", () => {
      const settings = loadSettings({
        PCT_ADGUARD_MODE: "managed",
        PCT_ADGUARD_DATA_DIR: "/srv/adguard",
        PCT_ADGUARD_VERSION: "v0.107.65",
      });

      expect(settings.adguard).toMatchObject({
        dataDir: "/srv/adguard",
        version: "v0.107.65",
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

  describe("PCT_TIMEKPR_MIRROR (#391)", () => {
    it("rejects an unknown mirror mode with a readable error", () => {
      try {
        loadSettings({ PCT_TIMEKPR_MIRROR: "on" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SettingsError);
        expect((err as SettingsError).message).toContain("Invalid configuration");
        expect((err as SettingsError).message).toContain("mode");
      }
    });

    it("ignores other mirror vars when disabled (default mode strips them)", () => {
      const settings = loadSettings({
        PCT_TIMEKPR_MIRROR: "disabled",
        PCT_TIMEKPR_MIRROR_URL: "https://apt.lan/timekpr",
        PCT_TIMEKPR_MIRROR_DIR: "/srv/apt/timekpr",
        PCT_TIMEKPR_MIRROR_PACKAGE: "timekpr-next-beta",
        PCT_TIMEKPR_MIRROR_VERSION: "0.5.5",
      });

      expect(settings.timekprMirror).toEqual({ mode: "disabled" });
    });

    describe("external mode", () => {
      it("parses the apt repo url", () => {
        const settings = loadSettings({
          PCT_TIMEKPR_MIRROR: "external",
          PCT_TIMEKPR_MIRROR_URL: "https://apt.lan/timekpr",
        });

        expect(settings.timekprMirror).toEqual({
          mode: "external",
          url: "https://apt.lan/timekpr",
        });
      });

      it("requires a url, naming the field", () => {
        try {
          loadSettings({ PCT_TIMEKPR_MIRROR: "external" });
          expect.unreachable("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(SettingsError);
          // Fails fast at startup naming the offending field, not a raw stack.
          expect((err as SettingsError).message).toContain("url");
        }
      });

      it("requires a valid url", () => {
        expect(() =>
          loadSettings({
            PCT_TIMEKPR_MIRROR: "external",
            PCT_TIMEKPR_MIRROR_URL: "not-a-url",
          }),
        ).toThrow(SettingsError);
      });
    });

    describe("managed mode", () => {
      it("defaults the data dir and package (version unset)", () => {
        const settings = loadSettings({ PCT_TIMEKPR_MIRROR: "managed" });

        expect(settings.timekprMirror).toEqual({
          mode: "managed",
          dataDir: "/data/apt/timekpr",
          package: "timekpr-next",
        });
      });

      it("honours an explicit dir, pinned version, and beta channel", () => {
        const settings = loadSettings({
          PCT_TIMEKPR_MIRROR: "managed",
          PCT_TIMEKPR_MIRROR_DIR: "/srv/apt/timekpr",
          PCT_TIMEKPR_MIRROR_PACKAGE: "timekpr-next-beta",
          PCT_TIMEKPR_MIRROR_VERSION: "0.5.5",
        });

        expect(settings.timekprMirror).toEqual({
          mode: "managed",
          dataDir: "/srv/apt/timekpr",
          package: "timekpr-next-beta",
          version: "0.5.5",
        });
      });

      it("rejects an unknown package/channel", () => {
        expect(() =>
          loadSettings({
            PCT_TIMEKPR_MIRROR: "managed",
            PCT_TIMEKPR_MIRROR_PACKAGE: "timekpr-nope",
          }),
        ).toThrow(SettingsError);
      });
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

  describe("PCT_ENFORCEMENT_*", () => {
    it("honours explicit cool-down and initial-lookback seconds", () => {
      const settings = loadSettings({
        PCT_ENFORCEMENT_COOLDOWN_SECONDS: "120",
        PCT_ENFORCEMENT_INITIAL_LOOKBACK_SECONDS: "600",
      });
      expect(settings.enforcement).toEqual({ cooldownSeconds: 120, initialLookbackSeconds: 600 });
    });

    it("rejects a non-positive or non-numeric cool-down", () => {
      expect(() => loadSettings({ PCT_ENFORCEMENT_COOLDOWN_SECONDS: "0" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_ENFORCEMENT_COOLDOWN_SECONDS: "-1" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_ENFORCEMENT_COOLDOWN_SECONDS: "soon" })).toThrow(
        SettingsError,
      );
    });

    it("rejects a non-positive or non-numeric initial lookback", () => {
      expect(() => loadSettings({ PCT_ENFORCEMENT_INITIAL_LOOKBACK_SECONDS: "0" })).toThrow(
        SettingsError,
      );
      expect(() => loadSettings({ PCT_ENFORCEMENT_INITIAL_LOOKBACK_SECONDS: "nope" })).toThrow(
        SettingsError,
      );
    });
  });

  describe("PCT_CLIENT_HEALTH_*", () => {
    it("honours explicit probe concurrency and deadline", () => {
      const settings = loadSettings({
        PCT_CLIENT_HEALTH_PROBE_CONCURRENCY: "8",
        PCT_CLIENT_HEALTH_PROBE_DEADLINE_MS: "5000",
      });
      expect(settings.clientHealth).toEqual({ probeConcurrency: 8, probeDeadlineMs: 5000 });
    });

    it("accepts a deadline of 0 to disable the per-list deadline", () => {
      expect(loadSettings({ PCT_CLIENT_HEALTH_PROBE_DEADLINE_MS: "0" }).clientHealth).toEqual({
        probeConcurrency: 4,
        probeDeadlineMs: 0,
      });
    });

    it("rejects a non-positive or non-numeric concurrency", () => {
      expect(() => loadSettings({ PCT_CLIENT_HEALTH_PROBE_CONCURRENCY: "0" })).toThrow(
        SettingsError,
      );
      expect(() => loadSettings({ PCT_CLIENT_HEALTH_PROBE_CONCURRENCY: "-1" })).toThrow(
        SettingsError,
      );
      expect(() => loadSettings({ PCT_CLIENT_HEALTH_PROBE_CONCURRENCY: "lots" })).toThrow(
        SettingsError,
      );
    });

    it("rejects a negative deadline", () => {
      expect(() => loadSettings({ PCT_CLIENT_HEALTH_PROBE_DEADLINE_MS: "-1" })).toThrow(
        SettingsError,
      );
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

    it("honours PCT_EXCEPTION_PUSH_CRON and rejects an invalid pattern", () => {
      expect(loadSettings({ PCT_EXCEPTION_PUSH_CRON: "*/5 * * * *" }).exceptionPush).toEqual({
        cron: "*/5 * * * *",
      });
      expect(() => loadSettings({ PCT_EXCEPTION_PUSH_CRON: "not a cron" })).toThrow(SettingsError);
      expect(() => loadSettings({ PCT_EXCEPTION_PUSH_CRON: "not a cron" })).toThrow(
        /valid cron pattern/,
      );
    });
  });

  // PCT_TRUST_PROXY parses into Fastify's `trustProxy` shape (#235). Default
  // off so a LAN deployment never trusts X-Forwarded-* from a direct caller.
  describe("PCT_TRUST_PROXY", () => {
    it("defaults to false when unset, empty, or whitespace-only", () => {
      expect(loadSettings({}).trustProxy).toBe(false);
      expect(loadSettings({ PCT_TRUST_PROXY: "" }).trustProxy).toBe(false);
      expect(loadSettings({ PCT_TRUST_PROXY: "   " }).trustProxy).toBe(false);
    });

    it("parses boolean word-forms (case-insensitive)", () => {
      for (const truthy of ["true", "TRUE", "yes", "On"]) {
        expect(loadSettings({ PCT_TRUST_PROXY: truthy }).trustProxy).toBe(true);
      }
      for (const falsy of ["false", "FALSE", "no", "Off"]) {
        expect(loadSettings({ PCT_TRUST_PROXY: falsy }).trustProxy).toBe(false);
      }
    });

    it("parses a bare integer as a hop count (not a boolean), trimming whitespace", () => {
      expect(loadSettings({ PCT_TRUST_PROXY: "2" }).trustProxy).toBe(2);
      expect(loadSettings({ PCT_TRUST_PROXY: "0" }).trustProxy).toBe(0);
      expect(loadSettings({ PCT_TRUST_PROXY: "  2  " }).trustProxy).toBe(2);
    });

    // Only bare non-negative integers are hop counts; anything else (e.g. a
    // negative or mixed token) falls through to the allowlist branch, where
    // Fastify/proxy-addr is the authority on whether it is a valid subnet. This
    // pins the contract so the precedence can't silently change.
    it("treats a non-bare-integer token as a single-entry allowlist", () => {
      expect(loadSettings({ PCT_TRUST_PROXY: "-1" }).trustProxy).toEqual(["-1"]);
    });

    it("parses a comma-separated IP/CIDR/keyword allowlist, trimming entries", () => {
      expect(loadSettings({ PCT_TRUST_PROXY: "127.0.0.1, 10.0.0.0/8" }).trustProxy).toEqual([
        "127.0.0.1",
        "10.0.0.0/8",
      ]);
      expect(loadSettings({ PCT_TRUST_PROXY: "loopback" }).trustProxy).toEqual(["loopback"]);
    });

    it("falls back to false for an allowlist that is empty after trimming", () => {
      expect(loadSettings({ PCT_TRUST_PROXY: ", ," }).trustProxy).toBe(false);
    });
  });
});
