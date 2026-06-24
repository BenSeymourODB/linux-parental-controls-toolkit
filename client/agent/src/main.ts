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

  await bridge.start();
}

void main();
