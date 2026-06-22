/**
 * Resolve the dedicated AdGuard account's credentials from the configured
 * secret files into the {@link AdGuardAuth} the REST client takes (#95).
 *
 * The config layer (`src/config.ts`) validates *which* `PCT_ADGUARD_*` vars are
 * present (a discriminated union keyed on `PCT_ADGUARD_MODE`, with `external`
 * requiring a password or token file — and a username alongside a password).
 * This module performs the *runtime* read of the referenced file, deliberately
 * separated so the secret never enters the typed settings object: the config
 * carries only the file *path*, and the plaintext is read here, at the last
 * moment, when the client is built.
 *
 * The Docker secret-file convention writes the value with a trailing newline,
 * so we strip a single trailing newline (CRLF or LF). We do not `trim()` — an
 * admin-chosen password could legitimately contain leading/trailing spaces.
 *
 * License boundary: none touched — plain Node `fs` reads; no AdGuard code
 * linked (`docs/licensing-analysis.md`).
 */
import { readFile } from "node:fs/promises";

import type { Settings } from "../../config.js";
import type { AdGuardAuth } from "./client.js";
import { AdGuardConfigError } from "./errors.js";

/** The external-mode branch of the validated AdGuard settings. */
export type ExternalAdGuardSettings = Extract<Settings["adguard"], { mode: "external" }>;

/** Reads a credential file's contents as UTF-8. Injectable for tests. */
export type ReadSecretFile = (path: string) => Promise<string>;

const defaultReadSecretFile: ReadSecretFile = (path) => readFile(path, "utf8");

/** Strip a single trailing newline (CRLF or LF) — the Docker secret-file convention. */
function stripTrailingNewline(content: string): string {
  return content.replace(/\r?\n$/, "");
}

/** Read a secret file, mapping any read failure to {@link AdGuardConfigError}. */
async function readSecret(read: ReadSecretFile, path: string): Promise<string> {
  try {
    return stripTrailingNewline(await read(path));
  } catch (cause) {
    throw new AdGuardConfigError(
      path,
      `could not read AdGuard credential file ${JSON.stringify(path)}`,
      cause,
    );
  }
}

/** Options for {@link resolveAdGuardAuth}. */
export interface ResolveAdGuardAuthDeps {
  /** Override the file read (tests inject an in-memory map). */
  readSecretFile?: ReadSecretFile;
}

/**
 * Resolve credentials for the dedicated AdGuard account, or `undefined` when
 * the mode needs none.
 *
 * - `external` + `apiTokenFile` → `{ kind: "bearer", token }`.
 * - `external` + `passwordFile` (+ `username`, guaranteed by config) →
 *   `{ kind: "basic", username, password }`.
 * - `disabled` / `managed` → `undefined` (no REST credentials to resolve here;
 *   `managed` credentials are owned by the supervisor, #96).
 *
 * A token file takes precedence over a password file if both are somehow set
 * (config does not forbid it, and a bearer token is the stronger credential).
 */
export async function resolveAdGuardAuth(
  adguard: Settings["adguard"],
  deps: ResolveAdGuardAuthDeps = {},
): Promise<AdGuardAuth | undefined> {
  if (adguard.mode !== "external") return undefined;
  const read = deps.readSecretFile ?? defaultReadSecretFile;

  if (adguard.apiTokenFile !== undefined) {
    return { kind: "bearer", token: await readSecret(read, adguard.apiTokenFile) };
  }

  if (adguard.passwordFile !== undefined) {
    // config.ts's superRefine guarantees a username alongside a password file;
    // the guard keeps this total without an unchecked assertion.
    if (adguard.username === undefined) {
      throw new AdGuardConfigError(
        adguard.passwordFile,
        "PCT_ADGUARD_PASSWORD_FILE requires PCT_ADGUARD_USERNAME (AdGuard uses HTTP basic auth)",
      );
    }
    return {
      kind: "basic",
      username: adguard.username,
      password: await readSecret(read, adguard.passwordFile),
    };
  }

  // config.ts guarantees external mode has one of the two files; if neither is
  // present the instance is treated as unauthenticated (the preflight will then
  // surface a 401 as auth_failed rather than guessing).
  return undefined;
}
