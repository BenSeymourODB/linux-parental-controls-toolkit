/**
 * Read the dashboard's own SSH public key to hand back at enrolment (#77).
 *
 * The enrol response includes the server's SSH public key so the client can
 * authorize it in `~pct-agent/.ssh/authorized_keys` (client step #78). The key
 * pair itself is generated server-side as a Phase-4 first-run step (#39); until
 * that lands the file legitimately does not exist, so a missing (or empty) file
 * resolves to `null` rather than failing enrolment — the client is simply told
 * "no key yet". A genuinely unexpected read error (e.g. a permissions
 * misconfiguration) is surfaced to the caller rather than masked.
 *
 * License boundary: none touched — `node:fs` only; no SSH library, no transport.
 */
import { readFileSync } from "node:fs";

/** Whether an error is a "file does not exist" (`ENOENT`) error. */
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && Reflect.get(err, "code") === "ENOENT";
}

/**
 * Return the trimmed contents of the server SSH public key at `path`, or `null`
 * when the file is absent or empty. Rethrows any other error.
 */
export function loadServerSshPublicKey(path: string): string | null {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const trimmed = contents.trim();
  return trimmed.length > 0 ? trimmed : null;
}
