/**
 * Shared configuration for the live SSH integration tests
 * (`tests/transport/ssh/ssh.int.test.ts`,
 * `tests/transport/timekpr/timekpr.int.test.ts`).
 *
 * These tests run against a real OpenSSH server with the stub `timekpra`
 * mounted (the `ssh-transport` job in `.github/workflows/integration.yml`, or
 * the local recipe in `docs/testing.md`). They are **env-gated**: when the
 * target isn't configured the suites `describe.skipIf` themselves out, so the
 * unit run (`npm test`, which never collects `*.int.test.ts`) and any
 * environment without the container stay green.
 *
 * Connection details come from the environment the integration job sets:
 * `SSH_TARGET_HOST`, `SSH_TARGET_PORT`, `SSH_TARGET_USER`, and the private key
 * via `SSH_TARGET_KEY_FILE` (a path) or `SSH_TARGET_KEY` (inline PEM).
 */
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import type { SshTarget } from "../../src/transport/ssh/facade.js";
import { SshTransport } from "../../src/transport/ssh/facade.js";

/** Absolute path of the stub `timekpra` inside the container (no PATH/sudo reliance). */
export const STUB_TIMEKPRA = "/usr/local/bin/timekpra";

/** Where the stub `timekpra` records its invocations (see `tests/stubs/timekpra`). */
export const STUB_INVOCATION_LOG = "/tmp/timekpra-invocations.log";

/** The private key for the live target, from a file path or inline PEM, if configured. */
function readPrivateKey(): string | undefined {
  const file = process.env.SSH_TARGET_KEY_FILE;
  if (file !== undefined && file.length > 0) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }
  const inline = process.env.SSH_TARGET_KEY;
  return inline !== undefined && inline.length > 0 ? inline : undefined;
}

const HOST = process.env.SSH_TARGET_HOST;
const PRIVATE_KEY = readPrivateKey();

/** Whether a live SSH target is configured; the int suites skip when false. */
export const liveSshEnabled = HOST !== undefined && HOST.length > 0 && PRIVATE_KEY !== undefined;

/**
 * The configured live SSH target. Call only when {@link liveSshEnabled} — i.e.
 * from inside an active (non-skipped) suite's hooks — so a missing config
 * throws clearly rather than producing a half-built target.
 */
export function liveSshTarget(): SshTarget {
  if (HOST === undefined || PRIVATE_KEY === undefined) {
    throw new Error(
      "live SSH target not configured (set SSH_TARGET_HOST and SSH_TARGET_KEY_FILE or SSH_TARGET_KEY)",
    );
  }
  const target: SshTarget = {
    host: HOST,
    username: process.env.SSH_TARGET_USER ?? "pctagent",
    privateKey: PRIVATE_KEY,
  };
  const port = process.env.SSH_TARGET_PORT;
  if (port !== undefined && port.length > 0) target.port = Number(port);
  return target;
}

/**
 * Poll the target with a trivial `exec` until it accepts one, so the suite
 * doesn't flake while the container finishes provisioning the SSH user's
 * `authorized_keys` after the port opens. Rejects if it never becomes ready.
 */
export async function waitForSshReady(
  transport: SshTransport,
  target: SshTarget,
  attempts = 20,
  delayMs = 1500,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await transport.exec(target, ["/bin/echo", "ready"], { timeoutMs: 5000 });
      return;
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }
  throw new Error(`SSH target never became ready after ${attempts} attempts: ${String(lastError)}`);
}
