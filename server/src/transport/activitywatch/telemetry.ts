/**
 * Phase-5 telemetry pull: open an SSH port-forward to each enrolled client's
 * `aw-server` and run a consumer against the tunnelled REST endpoint, on a
 * croner schedule.
 *
 * This module owns the **transport window** half of the data flow
 * (`docs/architecture.md` → "Inbound (client → server) — telemetry pull",
 * #86): for each reachable client it borrows a loopback port-forward from the
 * SSH facade ({@link SshTransport.withPortForward}, #82) and hands the local
 * base URL to a {@link TelemetryConsumer}. The default consumer is a liveness
 * probe via the REST-only ActivityWatch client (#87); the event fetch +
 * `UsageSample` normalisation plugs into the same seam in #88.
 *
 * License boundary: `aw-server` is reached only over its HTTP REST API,
 * through a server-initiated SSH tunnel bound to loopback (its API is
 * unauthenticated and must never be network-exposed). No ActivityWatch source
 * is linked in process and no GPL binary is added to the image.
 */
import { Cron, type CronOptions } from "croner";

import { mapWithConcurrency } from "../../util/concurrency.js";
import {
  SshUnreachableError,
  targetFromClient,
  type SshCredentials,
  type SshTransport,
} from "../ssh/index.js";
import { ActivityWatchClient } from "./client.js";

/** Default `aw-server` port on the client (its documented loopback bind). */
const DEFAULT_AW_PORT = 5600;

/** Default number of clients pulled concurrently in one pass. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Structured logger the pull and schedule emit through (a subset of pino).
 * The dashboard passes `app.log.child({ component })`; tests pass a spy.
 */
export interface TelemetryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** The minimal enrolled-client shape the pull targets (a `clients` row subset). */
export interface TelemetryClient {
  /** Policy-store id, for log correlation. */
  id: number;
  /** Hostname the SSH facade connects to. */
  hostname: string;
  /** The `pct-agent` login the dashboard connects as. */
  sshUser: string;
}

/** Context handed to a {@link TelemetryConsumer} once the tunnel is open. */
export interface TelemetryConsumeContext {
  /** The client whose `aw-server` the tunnel reaches. */
  client: TelemetryClient;
  /** Loopback base URL of the tunnelled `aw-server`, e.g. `http://127.0.0.1:54321`. */
  baseUrl: string;
  /** Logger scoped to the pull. */
  logger: TelemetryLogger;
}

/**
 * What to do with the tunnel while it is open. Defaults to
 * {@link probeAwServer} (a liveness check); the #88 normalisation replaces it
 * with an event fetch without the pull/schedule code changing.
 */
export type TelemetryConsumer = (context: TelemetryConsumeContext) => Promise<void>;

/** Inputs for one {@link runTelemetryPull} pass. */
export interface TelemetryPullDeps {
  /** SSH transport providing the loopback port-forward window. */
  transport: Pick<SshTransport, "withPortForward">;
  /** The dashboard's SSH credentials (the server keypair). */
  credentials: SshCredentials;
  /** Enrolled clients to pull from this pass. */
  clients: readonly TelemetryClient[];
  /** Logger for the pass. */
  logger: TelemetryLogger;
  /** Max clients tunnelled concurrently. Defaults to 4. */
  concurrency?: number;
  /** `aw-server` port on the client. Defaults to 5600. */
  awPort?: number;
  /** Consumer run against each open tunnel. Defaults to {@link probeAwServer}. */
  consume?: TelemetryConsumer;
}

/** Outcome summary of one pull pass (logged + returned for diagnostics/tests). */
export interface TelemetryPullResult {
  /** Clients in the pass. */
  attempted: number;
  /** Clients whose tunnel opened and consumer completed. */
  succeeded: number;
  /** Clients skipped because they were unreachable (a non-punitive gap). */
  skippedOffline: number;
  /** Clients whose tunnel opened but the consumer (or forward) errored. */
  failed: number;
}

/**
 * Default consumer: confirm the tunnelled `aw-server` answers `GET /api/0/info`.
 * This proves the transport window end-to-end (#86) without doing #88's work.
 */
export async function probeAwServer(context: TelemetryConsumeContext): Promise<void> {
  const client = new ActivityWatchClient({ baseUrl: context.baseUrl, logger: context.logger });
  const info = await client.getInfo();
  context.logger.info(
    { clientId: context.client.id, hostname: context.client.hostname, awVersion: info.version },
    "aw-server reachable through telemetry tunnel",
  );
}

/**
 * Open a port-forward to each client's `aw-server` and run `consume` against
 * it, with bounded concurrency. Unreachable clients are skipped as a telemetry
 * gap (never a failure — gaps are acceptable per the failure-modes section); a
 * consumer/forward error for one client is isolated and counted, never
 * aborting the rest of the pass.
 */
export async function runTelemetryPull(deps: TelemetryPullDeps): Promise<TelemetryPullResult> {
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const awPort = deps.awPort ?? DEFAULT_AW_PORT;
  const consume = deps.consume ?? probeAwServer;

  const result: TelemetryPullResult = {
    attempted: deps.clients.length,
    succeeded: 0,
    skippedOffline: 0,
    failed: 0,
  };

  await mapWithConcurrency(deps.clients, concurrency, async (client) => {
    const target = targetFromClient(client, deps.credentials);
    try {
      await deps.transport.withPortForward(target, { port: awPort }, async (local) => {
        await consume({
          client,
          baseUrl: `http://${local.host}:${local.port}`,
          logger: deps.logger,
        });
      });
      result.succeeded += 1;
    } catch (error) {
      if (error instanceof SshUnreachableError) {
        result.skippedOffline += 1;
        deps.logger.warn(
          { clientId: client.id, hostname: client.hostname },
          "client unreachable; skipping telemetry pull (gap)",
        );
        return;
      }
      result.failed += 1;
      deps.logger.error(
        { clientId: client.id, hostname: client.hostname, error: errorMessage(error) },
        "telemetry pull failed for client",
      );
    }
  });

  // Spread into a fresh object: a TS interface has no implicit index
  // signature, so `result` itself isn't assignable to the logger's
  // Record<string, unknown> parameter.
  deps.logger.info({ ...result }, "telemetry pull pass complete");
  return result;
}

/** Options for {@link scheduleTelemetryPull}. */
export interface TelemetryScheduleOptions {
  /** croner pattern (e.g. every five minutes). Validate with {@link isValidCronPattern}. */
  pattern: string;
  /** IANA timezone the pattern is interpreted in. Defaults to the host's. */
  timezone?: string;
}

/**
 * Schedule `run` on a croner cron. Overlap-protected (`protect`) so a slow
 * pass can't stack on the next tick, and `catch`-guarded so a thrown pass logs
 * rather than killing the scheduler. Returns the {@link Cron} handle so the
 * caller can `.stop()` it on shutdown.
 */
export function scheduleTelemetryPull(
  run: () => Promise<unknown>,
  options: TelemetryScheduleOptions,
  logger: TelemetryLogger,
): Cron {
  const cronOptions: CronOptions = {
    protect: true,
    catch: (error: unknown) =>
      logger.error({ error: errorMessage(error) }, "telemetry pull tick threw"),
  };
  if (options.timezone !== undefined) cronOptions.timezone = options.timezone;

  // Await the pass inside the handler so croner sees the async work: `protect`
  // then spans the whole run (no overlap), and a rejection routes to `catch`
  // above rather than escaping as an unhandled rejection.
  return new Cron(options.pattern, cronOptions, async () => {
    await run();
  });
}

/**
 * Whether `pattern` is a valid croner cron pattern. Used by the config loader
 * to fail fast on a typo (mirrors `policy/budget-window` → `isValidTimeZone`).
 */
export function isValidCronPattern(pattern: string): boolean {
  try {
    // Construct paused so no tick fires, then stop so nothing lingers — this
    // only exercises croner's pattern parser, which throws on a bad pattern.
    new Cron(pattern, { paused: true }).stop();
    return true;
  } catch {
    return false;
  }
}

/** A safe, loggable message for an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
