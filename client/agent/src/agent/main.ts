/**
 * `pct-client-agent` entry point (#103, Phase 8b).
 *
 * The thin per-user process bootstrap (`systemd --user`): read the
 * configuration from the environment, build the logger + effect implementations
 * + the {@link Agent}, start it, and wire a graceful shutdown on
 * `SIGTERM`/`SIGINT`. An {@link AgentConfigError} on a misconfigured unit exits
 * non-zero with a readable message.
 *
 * Untested by design (excluded from the coverage gate, like the bridge's
 * `src/main.ts`): its only logic is process-lifecycle wiring. Everything it
 * composes — config, cadence, budgets, effects, force-close, socket intake — is
 * covered through {@link Agent} and the module tests.
 *
 * The budget cache seeds empty and force-close PID resolution is degraded
 * (`[]`) here: both are fed by the server's client-side policy push, which is a
 * tracked follow-up. The agent still renders every server event and runs the
 * local cadence/force-close machinery against whatever budgets it is given.
 *
 * License boundary: none touched — composes the agent modules + `node:process`.
 */
import process from "node:process";

import { StreamLogger } from "../bridge/logger.js";
import { Agent } from "./agent.js";
import { BudgetCache } from "./budget.js";
import { AgentConfigError, loadConfigFromEnv } from "./config.js";
import {
  CanberraSoundPlayer,
  DesktopNotifier,
  OsProcessSignaller,
  SpawnCommandRunner,
} from "./effects.js";
import { ForceCloseController } from "./force-close.js";
import { SystemScheduler } from "./scheduler.js";
import { AwUsageSource } from "./usage.js";

function main(): void {
  const logger = new StreamLogger({ component: "pct-client-agent" });

  let agent: Agent;
  try {
    const config = loadConfigFromEnv();
    const scheduler = new SystemScheduler();
    const runner = new SpawnCommandRunner();
    const notifier = new DesktopNotifier({ runner, logger });
    const soundPlayer = new CanberraSoundPlayer({ runner, logger });
    // The sound player is omitted entirely when the profile is `off`, so the
    // force-close path can't play a bell against an opted-out policy.
    const soundEnabled = config.notifications.soundProfile !== "off";
    const forceClose = new ForceCloseController({
      notifier,
      signaller: new OsProcessSignaller(),
      scheduler,
      // Degraded until client-side activity matchers land (tracked follow-up, #381).
      resolvePids: () => Promise.resolve([]),
      graceSeconds: config.notifications.graceSeconds,
      sigkillEscalationMs: config.sigkillEscalationMs,
      renderToasts: config.notifications.enabled,
      ...(soundEnabled ? { soundPlayer } : {}),
      logger,
    });
    agent = new Agent({
      config,
      budgets: new BudgetCache(),
      usage: new AwUsageSource({ baseUrl: config.awBaseUrl, logger }),
      notifier,
      soundPlayer,
      forceClose,
      scheduler,
      logger,
    });
  } catch (err) {
    if (err instanceof AgentConfigError) {
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
    agent.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  agent.start();
}

try {
  main();
} catch (err) {
  process.stderr.write(`pct-client-agent: fatal: ${String(err)}\n`);
  process.exit(1);
}
