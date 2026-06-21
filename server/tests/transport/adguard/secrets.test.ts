/**
 * Unit tests for the AdGuard credential resolver (#95).
 *
 * The file read is injected (no real filesystem) for the mode→auth mapping, the
 * trailing-newline strip, the token-over-password precedence, and the
 * {@link AdGuardConfigError} mapping for an unreadable file; one case exercises
 * the default on-disk reader against a real temp file.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadSettings, type Settings } from "../../../src/config.js";
import { AdGuardConfigError } from "../../../src/transport/adguard/errors.js";
import { resolveAdGuardAuth, type ReadSecretFile } from "../../../src/transport/adguard/secrets.js";

/** A reader backed by an in-memory path→contents map; throws for unknown paths. */
function fileReader(files: Record<string, string>): ReadSecretFile {
  return (path) => {
    const content = files[path];
    if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
    return Promise.resolve(content);
  };
}

describe("resolveAdGuardAuth", () => {
  it("returns undefined for disabled mode (no network creds)", async () => {
    const settings = loadSettings({ PCT_ADGUARD_MODE: "disabled" });
    await expect(resolveAdGuardAuth(settings.adguard)).resolves.toBeUndefined();
  });

  it("returns undefined for managed mode (creds owned by the supervisor, #96)", async () => {
    const settings = loadSettings({ PCT_ADGUARD_MODE: "managed" });
    await expect(resolveAdGuardAuth(settings.adguard)).resolves.toBeUndefined();
  });

  it("resolves a bearer token from the api-token file, stripping the trailing newline", async () => {
    const settings = loadSettings({
      PCT_ADGUARD_MODE: "external",
      PCT_ADGUARD_URL: "http://adguard.lan",
      PCT_ADGUARD_API_TOKEN_FILE: "/run/secrets/token",
    });
    const readSecretFile = fileReader({ "/run/secrets/token": "s3cr3t-token\n" });
    await expect(resolveAdGuardAuth(settings.adguard, { readSecretFile })).resolves.toEqual({
      kind: "bearer",
      token: "s3cr3t-token",
    });
  });

  it("resolves basic auth from the password file + username, stripping a CRLF newline", async () => {
    const settings = loadSettings({
      PCT_ADGUARD_MODE: "external",
      PCT_ADGUARD_URL: "http://adguard.lan",
      PCT_ADGUARD_USERNAME: "parental-controls",
      PCT_ADGUARD_PASSWORD_FILE: "/run/secrets/password",
    });
    const readSecretFile = fileReader({ "/run/secrets/password": "p@ss word\r\n" });
    await expect(resolveAdGuardAuth(settings.adguard, { readSecretFile })).resolves.toEqual({
      kind: "basic",
      username: "parental-controls",
      // Only the single trailing newline is stripped — an internal space is kept.
      password: "p@ss word",
    });
  });

  it("prefers a bearer token over a password when both files are configured", async () => {
    const settings = loadSettings({
      PCT_ADGUARD_MODE: "external",
      PCT_ADGUARD_URL: "http://adguard.lan",
      PCT_ADGUARD_USERNAME: "parental-controls",
      PCT_ADGUARD_PASSWORD_FILE: "/run/secrets/password",
      PCT_ADGUARD_API_TOKEN_FILE: "/run/secrets/token",
    });
    const readSecretFile = fileReader({
      "/run/secrets/token": "tok",
      "/run/secrets/password": "pw",
    });
    await expect(resolveAdGuardAuth(settings.adguard, { readSecretFile })).resolves.toEqual({
      kind: "bearer",
      token: "tok",
    });
  });

  it("maps an unreadable credential file to AdGuardConfigError carrying the path + cause", async () => {
    const settings = loadSettings({
      PCT_ADGUARD_MODE: "external",
      PCT_ADGUARD_URL: "http://adguard.lan",
      PCT_ADGUARD_API_TOKEN_FILE: "/run/secrets/missing",
    });
    const readSecretFile = fileReader({}); // every read rejects
    const err = await resolveAdGuardAuth(settings.adguard, { readSecretFile }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdGuardConfigError);
    expect((err as AdGuardConfigError).path).toBe("/run/secrets/missing");
    expect((err as AdGuardConfigError).cause).toBeInstanceOf(Error);
  });

  it("throws AdGuardConfigError if a password file has no username (defensive — config forbids this)", async () => {
    // Construct the settings shape directly: loadSettings would reject this via
    // its superRefine, so we exercise the resolver's own defensive guard.
    const adguard = {
      mode: "external",
      url: "http://adguard.lan",
      passwordFile: "/run/secrets/password",
    } satisfies Settings["adguard"];
    const readSecretFile = vi.fn<ReadSecretFile>();
    const err = await resolveAdGuardAuth(adguard, { readSecretFile }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdGuardConfigError);
    // The guard fires before any read.
    expect(readSecretFile).not.toHaveBeenCalled();
  });

  it("returns undefined for an external instance with no credential files (unauthenticated)", async () => {
    // Again bypassing loadSettings (which requires a file for external mode) to
    // prove the resolver treats no-creds as unauthenticated rather than erroring.
    const adguard = { mode: "external", url: "http://adguard.lan" } satisfies Settings["adguard"];
    await expect(resolveAdGuardAuth(adguard)).resolves.toBeUndefined();
  });

  describe("default on-disk reader", () => {
    let dir: string;
    let tokenPath: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "pct-adguard-"));
      tokenPath = join(dir, "token");
      await writeFile(tokenPath, "disk-token\n", "utf8");
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads the credential file from disk when no reader is injected", async () => {
      const settings = loadSettings({
        PCT_ADGUARD_MODE: "external",
        PCT_ADGUARD_URL: "http://adguard.lan",
        PCT_ADGUARD_API_TOKEN_FILE: tokenPath,
      });
      await expect(resolveAdGuardAuth(settings.adguard)).resolves.toEqual({
        kind: "bearer",
        token: "disk-token",
      });
    });
  });
});
