/**
 * `pct-client-bridge` entry point (#101, Phase 8b).
 *
 * The thin process bootstrap: read the configuration from the environment
 * (the `systemd` unit supplies it), build the logger and {@link Bridge}, start
 * it, and wire a graceful shutdown on `SIGTERM`/`SIGINT` so the per-user
 * sockets are unlinked on stop. A {@link ConfigError} on a misconfigured unit
 * exits non-zero with a readable message rather than crashing into the void.
 *
 * This file is deliberately untested (excluded from the coverage gate, like
 * `server/src/main.ts`): its only logic is process-lifecycle wiring that cannot
 * run under the unit harness. Everything it composes — config loading, the
 * dispatcher, the WebSocket client — is covered through {@link Bridge} and the
 * module tests.
 *
 * License boundary: none touched — composes the bridge modules + `node:process`.
 */
import process from "node:process";

import { Bridge } from "./bridge/bridge.js";
import { ConfigError, loadConfigFromEnv } from "./bridge/config.js";
import { StreamLogger } from "./bridge/logger.js";

async function main(): Promise<void> {
  const logger = new StreamLogger();

  let bridge: Bridge;
  try {
    const config = loadConfigFromEnv();
    bridge = new Bridge(config, { logger });
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error({ err }, "invalid configuration; refusing to start");
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw err;
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    void bridge
      .stop()
      .catch((err: unknown) => logger.error({ err }, "error during shutdown"))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await bridge.start();
  } catch (err) {
    // A bind failure (EACCES/ENOENT under /run/pct, or a live peer on the
    // path) must surface as a logged, non-zero exit — not a swallowed
    // unhandled rejection. Dispatcher.start() has already rolled back any
    // sockets it bound, but stop() the bridge defensively in case the WS
    // client started.
    logger.error({ err }, "failed to start; shutting down");
    await bridge.stop().catch(() => undefined);
    process.exitCode = 1;
  }
}

// Backstop: a rejection main() does not handle itself (e.g. a non-ConfigError
// thrown while building the bridge) must still exit non-zero, never a silent
// unhandled rejection.
main().catch((err: unknown) => {
  process.stderr.write(`pct-client-bridge: fatal: ${String(err)}\n`);
  process.exit(1);
});
