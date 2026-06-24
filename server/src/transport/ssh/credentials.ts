/**
 * Load the dashboard's SSH credentials from the data volume (#201, Phase 4).
 *
 * The `transport/ssh` facade authenticates to enrolled clients with the server's
 * private key, generated on first run by the entrypoint's SSH-key bootstrap
 * (#39). Until that key exists the dashboard still starts — the live transport
 * is simply withheld and policy pushes fall back to logging (mirroring the
 * "absent ⇒ null, don't crash" posture of `loadServerSshPublicKey`, #77, and
 * `docs/server-deployment.md` → "start anyway, surface the error").
 *
 * License boundary: none touched — `node:fs` only; the key never leaves the
 * process except over the existing SSH subprocess boundary.
 */
import { readFileSync } from "node:fs";

import type { SshCredentials } from "./facade.js";

/** Whether an error is a "file does not exist" (`ENOENT`) error. */
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && Reflect.get(err, "code") === "ENOENT";
}

/**
 * Return the dashboard's {@link SshCredentials} read from the private key at
 * `privateKeyPath`, or `null` when the file is absent or empty (the key has not
 * been generated yet). Rethrows any other read error (e.g. a permissions
 * misconfiguration) — a real problem the operator must see, not a silent skip.
 */
export function loadSshCredentials(privateKeyPath: string): SshCredentials | null {
  let contents: string;
  try {
    contents = readFileSync(privateKeyPath, "utf8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  if (contents.trim().length === 0) return null;
  return { privateKey: contents };
}
