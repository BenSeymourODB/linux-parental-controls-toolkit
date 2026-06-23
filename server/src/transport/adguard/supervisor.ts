/**
 * AdGuard Home managed-mode supervisor (#96).
 *
 * When `PCT_ADGUARD_MODE=managed`, this owns the lifecycle of a locally-run
 * AdGuard Home instance: acquire the binary on first run (`./acquire.ts`), seed
 * a minimal headless config (`./managed-config.ts`), spawn it as a **child
 * process**, and keep it running — restarting it with capped backoff on an
 * unexpected exit and stopping it gracefully on shutdown. It mirrors
 * `setup/ansible-venv.ts`: a never-throwing `bootstrap()` run in the background
 * after `listen`, an immutable `status` snapshot the admin UI reads, and every
 * side-effecting boundary injected so the whole class is unit-testable without
 * spawning a real process.
 *
 * Why a child process (not a sidecar container): recorded in
 * `docs/adr/0009-adguard-managed-supervisor.md`. It is what
 * `docs/server-deployment.md` already documents and matches the established
 * first-run subprocess pattern; the GPL-satisfying process boundary is identical
 * either way (`CLAUDE.md` → "License boundaries" rule 5;
 * `docs/licensing-analysis.md`). AdGuard Home is fetched at runtime and run
 * out-of-process — never linked, never baked into the image.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import { acquireAdGuardHome, type AcquireConfig, type AcquireResult } from "./acquire.js";
import { writeSeedConfigIfAbsent, type SeedConfigOptions } from "./managed-config.js";

/**
 * Lifecycle state of the managed AdGuard Home process.
 *
 * - `idle` — built but not yet bootstrapped (a freshly constructed supervisor;
 *   building the app spawns nothing).
 * - `fetching` — `bootstrap()` is acquiring the binary / seeding config.
 * - `starting` — the child process is being spawned.
 * - `running` — the child is up.
 * - `stopped` — stopped on purpose (graceful shutdown).
 * - `failed` — acquisition failed, the process could not be spawned, or it
 *   exited unexpectedly too many times; `detail` says why.
 */
export type AdGuardManagedState =
  | "idle"
  | "fetching"
  | "starting"
  | "running"
  | "stopped"
  | "failed";

/** An immutable snapshot of the supervisor's last-observed state. */
export interface AdGuardManagedStatus {
  /** Lifecycle state (see {@link AdGuardManagedState}). */
  readonly state: AdGuardManagedState;
  /** Path the AdGuard Home binary is run from. */
  readonly binaryPath: string;
  /** The release tag in use, or `null` before the first successful acquisition. */
  readonly version: string | null;
  /** The localhost REST/admin endpoint the dashboard targets the instance at. */
  readonly adminEndpoint: string;
  /** How many times the process has been restarted after an unexpected exit. */
  readonly restarts: number;
  /** ISO-8601 timestamp of the last state transition, or `null` if never run. */
  readonly checkedAt: string | null;
  /** Human-readable reason when not `running`, else `null`. */
  readonly detail: string | null;
}

/** Minimal structural logger the supervisor uses (Fastify's pino `app.log` fits). */
export interface AdGuardManagedLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * A spawned child as the supervisor needs it. Deliberately narrower than Node's
 * `ChildProcess` (typed per-event handlers, no event-name strings) so the
 * default adapter wraps `node:child_process` without an `as` cast and a test can
 * drive a fully-controllable fake.
 */
export interface ManagedProcess {
  /** OS process id, or `undefined` if the spawn failed synchronously. */
  readonly pid: number | undefined;
  /** Register the one-shot exit handler. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** Register the spawn-error handler (e.g. the binary is missing/not executable). */
  onError(listener: (err: Error) => void): void;
  /** Send a signal to the process. */
  kill(signal: NodeJS.Signals): void;
}

/** Spawns the AdGuard Home binary and returns a {@link ManagedProcess}. */
export type SpawnManaged = (command: string, args: string[]) => ManagedProcess;

/** Configuration the supervisor needs (the managed-mode slice of {@link Settings}). */
export interface AdGuardManagedConfig {
  /** Data-volume root for the binary + config (`PCT_ADGUARD_DATA_DIR`, e.g. `/data/adguard`). */
  dataDir: string;
  /** Pinned release tag (`PCT_ADGUARD_VERSION`); latest when omitted. */
  version?: string;
  /** `host:port` AdGuard's DNS server binds (`PCT_ADGUARD_BIND_ADDR`). */
  bindAddr: string;
  /** Port AdGuard's web/REST UI binds on localhost (`PCT_ADGUARD_ADMIN_PORT`). */
  adminPort: number;
}

/** Injectable seams + restart tuning so tests never spawn a process or wait on real time. */
export interface AdGuardManagedDeps {
  /** Acquire the binary; defaults to {@link acquireAdGuardHome}. */
  acquire?: (config: AcquireConfig) => Promise<AcquireResult>;
  /** Seed the headless config; defaults to {@link writeSeedConfigIfAbsent}. */
  writeSeedConfig?: (configPath: string, options: SeedConfigOptions) => boolean;
  /** Spawn the process; defaults to wrapping `node:child_process` `spawn`. */
  spawn?: SpawnManaged;
  /** Delay used for restart backoff + stop escalation; defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
  /** Clock for `checkedAt`; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Max consecutive restarts before giving up to `failed`. Defaults to 5. */
  maxRestarts?: number;
  /** Uptime (ms) after which a run is "stable" and the restart counter resets. Defaults to 60_000. */
  stableMs?: number;
  /** Grace (ms) after `SIGTERM` before escalating to `SIGKILL` on stop. Defaults to 10_000. */
  stopTimeoutMs?: number;
  /** Base backoff (ms) between restarts (doubles per attempt). Defaults to 1_000. */
  backoffBaseMs?: number;
  /** Backoff ceiling (ms). Defaults to 60_000. */
  backoffMaxMs?: number;
}

/** Default `spawn` adapter: detach stdio and surface only exit/error. */
const defaultSpawn: SpawnManaged = (command, args) => {
  const child = spawn(command, args, { stdio: "ignore" });
  return {
    pid: child.pid,
    onExit: (listener) => void child.on("exit", listener),
    onError: (listener) => void child.on("error", listener),
    kill: (signal) => void child.kill(signal),
  };
};

interface ResolvedDeps {
  acquire: (config: AcquireConfig) => Promise<AcquireResult>;
  writeSeedConfig: (configPath: string, options: SeedConfigOptions) => boolean;
  spawn: SpawnManaged;
  delay: (ms: number) => Promise<void>;
  now: () => Date;
  maxRestarts: number;
  stableMs: number;
  stopTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

/** Filename of the seed config under `<dataDir>/conf/`. */
const CONFIG_FILENAME = "AdGuardHome.yaml";

/**
 * Owns the managed AdGuard Home child process. Construct via
 * {@link createAdGuardManagedSupervisor}; build once per app and decorate it onto
 * Fastify so the status route reads the same instance.
 */
export class AdGuardManagedSupervisor {
  readonly #config: AdGuardManagedConfig;
  readonly #deps: ResolvedDeps;
  readonly #binaryPath: string;
  readonly #configPath: string;
  readonly #workDir: string;
  readonly #adminEndpoint: string;

  #status: AdGuardManagedStatus;
  #version: string | null = null;
  #child: ManagedProcess | null = null;
  #stopping = false;
  #restarts = 0;
  #startedAt: number | null = null;
  #logger: AdGuardManagedLogger | undefined;
  /** Resolvers awaiting the current child's exit (used by {@link stop}). */
  #exitWaiters: (() => void)[] = [];

  constructor(config: AdGuardManagedConfig, deps: AdGuardManagedDeps = {}) {
    this.#config = config;
    this.#deps = {
      acquire: deps.acquire ?? acquireAdGuardHome,
      writeSeedConfig: deps.writeSeedConfig ?? writeSeedConfigIfAbsent,
      spawn: deps.spawn ?? defaultSpawn,
      delay: deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: deps.now ?? (() => new Date()),
      maxRestarts: deps.maxRestarts ?? 5,
      stableMs: deps.stableMs ?? 60_000,
      stopTimeoutMs: deps.stopTimeoutMs ?? 10_000,
      backoffBaseMs: deps.backoffBaseMs ?? 1_000,
      backoffMaxMs: deps.backoffMaxMs ?? 60_000,
    };

    this.#binaryPath = join(config.dataDir, "AdGuardHome");
    this.#configPath = join(config.dataDir, "conf", CONFIG_FILENAME);
    this.#workDir = join(config.dataDir, "work");
    this.#adminEndpoint = `http://127.0.0.1:${config.adminPort}`;

    this.#status = {
      state: "idle",
      binaryPath: this.#binaryPath,
      version: null,
      adminEndpoint: this.#adminEndpoint,
      restarts: 0,
      checkedAt: null,
      detail: null,
    };
  }

  /** An immutable snapshot of the current status. */
  get status(): AdGuardManagedStatus {
    return { ...this.#status };
  }

  /**
   * Acquire (if needed), seed the config, and start the process.
   *
   * Never throws — an acquisition or spawn failure is recorded as `failed` with
   * a `detail` and logged, so the caller (`main.ts`, after `listen`) can fire it
   * with a bare `void`. Idempotent acquisition means it is safe on every boot.
   */
  async bootstrap(logger?: AdGuardManagedLogger): Promise<AdGuardManagedStatus> {
    this.#logger = logger;
    this.#stopping = false;
    this.#settle("fetching", null, "acquiring AdGuard Home");
    try {
      const result = await this.#deps.acquire({
        dataDir: this.#config.dataDir,
        ...(this.#config.version !== undefined ? { version: this.#config.version } : {}),
      });
      this.#version = result.version;
      this.#deps.writeSeedConfig(this.#configPath, {
        adminPort: this.#config.adminPort,
        bindAddr: this.#config.bindAddr,
      });
      this.#spawnChild();
      return this.status;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#settle("failed", detail, `AdGuard Home managed bootstrap failed: ${detail}`, "error");
      return this.status;
    }
  }

  /**
   * Stop the managed process: send `SIGTERM`, then escalate to `SIGKILL` after
   * the stop grace. Used by the app's `onClose` hook. Safe to call when nothing
   * is running.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    if (child === null) {
      this.#settle("stopped", null, "AdGuard Home managed supervisor stopped (nothing running)");
      return;
    }

    const exited = new Promise<void>((resolve) => this.#exitWaiters.push(resolve));
    child.kill("SIGTERM");

    let escalated = false;
    await Promise.race([
      exited,
      this.#deps.delay(this.#deps.stopTimeoutMs).then(() => {
        escalated = true;
        child.kill("SIGKILL");
      }),
    ]);
    if (escalated) await exited;
  }

  /** Spawn the child and wire its exit/error handlers. */
  #spawnChild(): void {
    // A stop() that lands while bootstrap() was still awaiting the first-run
    // download (state `fetching`, no child yet) must not spawn an unsupervised
    // process the already-returned stop() can never reap.
    if (this.#stopping) return;

    this.#settle("starting", null, "starting AdGuard Home");
    const args = ["--no-check-update", "--config", this.#configPath, "--work-dir", this.#workDir];
    const child = this.#deps.spawn(this.#binaryPath, args);
    this.#child = child;
    this.#startedAt = this.#deps.now().getTime();

    // Capture `child` so a stale event from a previous process is ignored. Node
    // emits BOTH `error` and `exit` for a failed spawn; whichever fires first
    // nulls `#child`, so the second sees `#child !== child` and is a no-op —
    // preventing a spawn failure from also triggering a restart.
    child.onError((err) => this.#onSpawnError(child, err));
    child.onExit((code, signal) => this.#onExit(child, code, signal));

    this.#settle("running", null, `AdGuard Home running (pid ${String(child.pid ?? "unknown")})`);
  }

  #onSpawnError(child: ManagedProcess, err: Error): void {
    if (this.#child !== child) return;
    this.#child = null;
    this.#releaseExitWaiters();
    this.#settle("failed", err.message, `AdGuard Home failed to start: ${err.message}`, "error");
  }

  #onExit(child: ManagedProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child) return;
    this.#child = null;
    this.#releaseExitWaiters();

    if (this.#stopping) {
      this.#settle("stopped", null, "AdGuard Home stopped");
      return;
    }

    // Reset the consecutive-restart counter when the run was stable long enough,
    // so a single crash after days of uptime is not counted against the cap.
    const startedAt = this.#startedAt;
    if (startedAt !== null && this.#deps.now().getTime() - startedAt >= this.#deps.stableMs) {
      this.#restarts = 0;
    }

    const reason = `exited unexpectedly (code ${String(code)}, signal ${String(signal)})`;
    if (this.#restarts >= this.#deps.maxRestarts) {
      const detail = `${reason}; exceeded the restart cap (${this.#deps.maxRestarts})`;
      this.#settle("failed", detail, `AdGuard Home ${detail}`, "error");
      return;
    }

    this.#restarts += 1;
    const backoff = Math.min(
      this.#deps.backoffBaseMs * 2 ** (this.#restarts - 1),
      this.#deps.backoffMaxMs,
    );
    this.#logger?.warn(
      { event: "adguard_managed", restarts: this.#restarts, backoffMs: backoff },
      `AdGuard Home ${reason}; restarting in ${backoff}ms (attempt ${this.#restarts})`,
    );
    void this.#scheduleRestart(backoff);
  }

  async #scheduleRestart(backoffMs: number): Promise<void> {
    await this.#deps.delay(backoffMs);
    if (this.#stopping) return;
    this.#spawnChild();
  }

  /** Resolve and clear any promises awaiting the current child's exit. */
  #releaseExitWaiters(): void {
    const waiters = this.#exitWaiters;
    this.#exitWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #settle(
    state: AdGuardManagedState,
    detail: string | null,
    msg: string,
    level: "info" | "error" = "info",
  ): void {
    this.#status = {
      state,
      binaryPath: this.#binaryPath,
      version: this.#version,
      adminEndpoint: this.#adminEndpoint,
      restarts: this.#restarts,
      checkedAt: this.#deps.now().toISOString(),
      detail,
    };
    const fields = { event: "adguard_managed", state };
    if (level === "error") this.#logger?.error(fields, msg);
    else this.#logger?.info(fields, msg);
  }
}

/** Build an {@link AdGuardManagedSupervisor} from the managed-mode settings. */
export function createAdGuardManagedSupervisor(
  config: AdGuardManagedConfig,
  deps: AdGuardManagedDeps = {},
): AdGuardManagedSupervisor {
  return new AdGuardManagedSupervisor(config, deps);
}
