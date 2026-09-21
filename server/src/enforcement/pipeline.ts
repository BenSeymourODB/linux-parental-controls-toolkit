/**
 * The Phase-8 enforcement pipeline (#327): the one place the Phase-5 telemetry
 * pull, the #88 usage normaliser, and the per-activity enforcement sweep are
 * composed into a single running loop for production.
 *
 * On each cron tick it:
 *   1. pulls window/afk events from every reachable client's `aw-server` over a
 *      loopback SSH port-forward and normalises them into `UsageSample` rows
 *      ({@link createUsageTelemetryConsumer}); then
 *   2. drives the enforcement sweep once ({@link EnforcementSweepHandle.tick})
 *      so it reads the usage this pass just wrote — one timer, so enforcement
 *      never races the rollup on a separate schedule.
 *
 * The single long-lived {@link ForceCloseTrigger} is built once here (its
 * in-flight grace timers de-dup across passes). Every I/O boundary — the SSH
 * transport, the AW event source, the client loader, the clock — is injectable,
 * so the pipeline unit-tests with fakes and no live SSH or `aw-server`.
 *
 * Like the other schedulers (`scheduleTelemetryPull`, the re-apply scheduler,
 * the offline-queue drainer), `buildApp` **constructs** this but does not start
 * the timer; `main.ts` calls {@link EnforcementPipelineHandle.start} after
 * `listen`, and `buildApp`'s `onClose` hook calls `stop()`. When the dashboard
 * has no SSH private key yet (dev/CI/tests/pre-keygen) there is no way to reach
 * a client, so {@link createEnforcementPipeline} returns `null` and boot wiring
 * is a no-op — mirroring the policy-push transport's logging fallback.
 *
 * License boundary: none touched — `aw-server` over its REST API through the
 * server-initiated loopback SSH tunnel, and `pkill`/`timekpra` as exec-over-SSH
 * subprocesses. No GPL source is linked in-process and no GPL binary is added
 * to the image.
 */
import type { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";

import type { PolicyDb } from "../policy/db.js";
import { clients } from "../policy/schema.js";
import { loadTelemetryCursors } from "../policy/telemetry-cursor.js";
import type { AuditSink } from "../transport/audit/index.js";
import {
  runTelemetryPull,
  scheduleTelemetryPull,
  type TelemetryClient,
  type TelemetryPullResult,
} from "../transport/activitywatch/index.js";
import {
  SshTransport,
  type ExecOptions,
  type ExecResult,
  type SshCredentials,
  type SshTarget,
} from "../transport/ssh/index.js";

import { createForceCloseDeps, type ForceCloseEventHub } from "./force-close-deps.js";
import { ForceCloseTrigger } from "./force-close.js";
import {
  loadSupervisedUsers,
  startEnforcementSweep,
  type EnforcementSweepResult,
} from "./sweep.js";
import { createUsageTelemetryConsumer, type AwEventSourceFactory } from "./telemetry-consumer.js";

/** Log component for the pipeline's own lines. */
export const ENFORCEMENT_PIPELINE_COMPONENT = "enforcement/pipeline";

/**
 * The SSH surface the pipeline needs: the loopback port-forward (telemetry) and
 * command exec (the `pkill` force-close fallback), plus pooled-connection
 * teardown. The real {@link SshTransport} satisfies it; tests inject a fake.
 */
export interface PipelineSshTransport {
  withPortForward: SshTransport["withPortForward"];
  exec(target: SshTarget, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  disposeAll(): void;
}

/** The outcome of one pipeline pass: the telemetry pull then the sweep it drove. */
export interface EnforcementPassResult {
  readonly pull: TelemetryPullResult;
  readonly sweep: EnforcementSweepResult;
}

/** A running pipeline the caller starts after `listen` and stops on shutdown. */
export interface EnforcementPipelineHandle {
  /** Start the telemetry cron that drives the pull + sweep. Idempotent. */
  start(): void;
  /**
   * Run one pass now — pull telemetry, then sweep enforcement over the usage it
   * wrote — returning both outcomes. This is exactly what each cron tick runs;
   * exposed so a pass can be kicked/observed without waiting on the schedule.
   */
  runOnce(): Promise<EnforcementPassResult>;
  /** Stop the cron + sweep and dispose owned SSH connections. */
  stop(): void;
}

/** Construction options for {@link createEnforcementPipeline}. */
export interface CreateEnforcementPipelineOptions {
  readonly db: PolicyDb;
  /** Event fan-out (#100) the force-close publishes `enforce.force_close` through. */
  readonly eventHub: ForceCloseEventHub;
  /** Transport audit sink (#85) the force-close records each attempt in. */
  readonly sink: AuditSink;
  /** Base logger; component children are derived per collaborator. */
  readonly log: FastifyBaseLogger;
  /** Server-default IANA timezone (`User.tz ?? this`, ADR 0001). */
  readonly defaultTz: string;
  /** The dashboard's SSH credentials, or `null` when no key exists yet. */
  readonly credentials: SshCredentials | null;
  /** croner pattern for the pull+sweep pass (`settings.telemetry.pullCron`). */
  readonly pullCron: string;
  /** Max clients tunnelled concurrently per pass (`settings.telemetry.pullConcurrency`). */
  readonly pullConcurrency: number;
  /** Cool-down seconds threaded to the decision core (`settings.enforcement.cooldownSeconds`). */
  readonly cooldownSeconds: number;
  /** First-pull lookback seconds when a client has no cursor (`settings.enforcement.initialLookbackSeconds`). */
  readonly initialLookbackSeconds: number;
  /** IANA timezone the cron pattern is interpreted in; defaults to the host's. */
  readonly timezone?: string;
  /** Clock seam for the pass instant; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** SSH transport; defaults to a fresh pooled {@link SshTransport} (disposed on stop). */
  readonly transport?: PipelineSshTransport;
  /** Enrolled-client loader; defaults to a query over the `clients` table. */
  readonly loadClients?: (db: PolicyDb) => TelemetryClient[];
  /** AW event source factory; defaults to a real {@link ActivityWatchClient}. */
  readonly createSource?: AwEventSourceFactory;
}

/** Production client loader: every enrolled client, as telemetry targets. */
export function loadTelemetryClients(db: PolicyDb): TelemetryClient[] {
  return db
    .select({
      id: clients.id,
      hostname: clients.hostname,
      sshUser: clients.sshUser,
      // Carry the SSH-target override (#406) so the telemetry pull dials the
      // same host as the rest of the transport, not the bare hostname.
      sshTarget: clients.sshTarget,
    })
    .from(clients)
    .all();
}

/**
 * Assemble the enforcement pipeline, or `null` when the SSH key is absent (no
 * client is reachable, so the loop would be a no-op — mirrors the policy-push
 * logging fallback). The returned handle constructs no timer until `start()`.
 */
export function createEnforcementPipeline(
  options: CreateEnforcementPipelineOptions,
): EnforcementPipelineHandle | null {
  const { credentials } = options;
  if (credentials === null) return null;
  // Bind the non-null credentials to a fresh const so the narrowing survives
  // into the `runPass` closure below (control-flow narrowing of the destructured
  // binding is not carried into nested functions).
  const creds: SshCredentials = credentials;

  const {
    db,
    eventHub,
    sink,
    log,
    defaultTz,
    pullCron,
    pullConcurrency,
    cooldownSeconds,
    initialLookbackSeconds,
  } = options;
  const now = options.now ?? ((): Date => new Date());
  const loadClients = options.loadClients ?? loadTelemetryClients;
  const transport = options.transport ?? new SshTransport();
  const ownsTransport = options.transport === undefined;
  const pipelineLog = log.child({ component: ENFORCEMENT_PIPELINE_COMPONENT });

  // One long-lived trigger so its in-flight grace timers de-dup across passes.
  const trigger = new ForceCloseTrigger(
    createForceCloseDeps({ db, eventHub, ssh: transport, credentials, sink, logger: pipelineLog }),
  );

  // The instant this pass rolls up to, pinned once at the top of `runPass` and
  // shared by both the telemetry window and the sweep — so enforcement
  // evaluates at exactly the boundary the samples were credited to, not a few
  // seconds later when the (awaited) pull returns.
  // Seed the per-client cursor from the durable column (#382) so a restart
  // resumes each client's pull where it left off; a client with no persisted
  // cursor is absent from the map and falls back to `initialLookback`.
  const cursor = loadTelemetryCursors(db);
  let currentPassEnd = now();

  // Caller-driven sweep (no internal cron): `tick()` runs after each rollup,
  // evaluating at the pinned pass instant.
  const sweep = startEnforcementSweep({
    db,
    loadSupervisedUsers: () => loadSupervisedUsers(db),
    trigger,
    log,
    defaultTz,
    cooldownSeconds,
    pattern: null,
    now: () => currentPassEnd,
  });

  const consume = createUsageTelemetryConsumer({
    db,
    cursor,
    passEnd: () => currentPassEnd,
    initialLookbackMs: initialLookbackSeconds * 1000,
    ...(options.createSource !== undefined ? { createSource: options.createSource } : {}),
  });

  async function runPass(): Promise<EnforcementPassResult> {
    currentPassEnd = now();
    const pull = await runTelemetryPull({
      transport,
      credentials: creds,
      clients: loadClients(db),
      logger: pipelineLog,
      concurrency: pullConcurrency,
      consume,
    });
    // Drive enforcement over the usage this pass just wrote.
    const sweepResult = sweep.tick();
    return { pull, sweep: sweepResult };
  }

  let cron: Cron | null = null;

  return {
    start(): void {
      if (cron !== null) return;
      cron = scheduleTelemetryPull(
        runPass,
        {
          pattern: pullCron,
          ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
        },
        pipelineLog,
      );
    },
    runOnce: runPass,
    stop(): void {
      cron?.stop();
      cron = null;
      sweep.stop();
      if (ownsTransport) transport.disposeAll();
    },
  };
}
