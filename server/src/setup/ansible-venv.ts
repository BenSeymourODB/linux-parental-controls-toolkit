/**
 * Ansible venv bootstrap (the Phase-6 first-run step of #39).
 *
 * The `transport/ansible` runner (#130) execs `ansible-playbook` from an
 * isolated venv in the data volume (`<ansibleDir>/venv/bin/ansible-playbook`)
 * and throws `AnsibleUnavailableError` until that venv exists. Something has to
 * *create* it on first run — this module does, and it runs **in-process at
 * boot** (`main.ts`), mirroring the migrate-on-boot (#49) and SSH-keygen (#205)
 * precedents so the runtime image needs no Ansible binary baked in (the image
 * ships only a stock `python3-venv`, used solely here).
 *
 * It spawns `python3 -m venv` and `pip install ansible-core==<pinned>` as
 * **subprocesses** (`node:child_process`) and copies playbook *files* — it never
 * imports or links Ansible in-process (`CLAUDE.md` → "License boundaries"). That
 * boundary is identical whether this runs from the shell entrypoint or from
 * Node; running it from Node buys testability and a status the admin UI can
 * surface, without collapsing anything.
 *
 * `bootstrap()` never throws: a network-less first run (no PyPI) leaves the
 * dashboard starting with Ansible `unavailable` and the reason surfaced via
 * `GET /api/system/ansible` (`docs/server-deployment.md` → "First-run setup"),
 * rather than crashing the process.
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Lifecycle state of the venv bootstrap.
 *
 * - `idle` — built but not yet run (the state a freshly constructed supervisor
 *   reports, so building the app spawns nothing — tests and the boot path that
 *   hasn't fired `bootstrap()` yet both see this).
 * - `bootstrapping` — a `bootstrap()` call is in flight.
 * - `ready` — `ansible-playbook` is present at the expected path with the
 *   pinned `ansible-core` installed; the runner can exec it.
 * - `unavailable` — the venv could not be created/installed (e.g. no network);
 *   the runner stays disabled and `detail` says why.
 */
export type AnsibleVenvState = "idle" | "bootstrapping" | "ready" | "unavailable";

/** An immutable snapshot of the venv bootstrap's last-observed state. */
export interface AnsibleVenvStatus {
  /** Lifecycle state (see {@link AnsibleVenvState}). */
  readonly state: AnsibleVenvState;
  /** The `ansible-playbook` path the runner will exec. */
  readonly binaryPath: string;
  /** Directory the runner resolves playbooks from. */
  readonly playbooksDir: string;
  /** The pinned `ansible-core` version targeted. */
  readonly coreVersion: string;
  /** ISO-8601 timestamp of the last `bootstrap()`, or `null` if never run. */
  readonly checkedAt: string | null;
  /** Human-readable reason when not `ready`, else `null`. */
  readonly detail: string | null;
}

/**
 * Minimal structural logger {@link AnsibleVenvSupervisor.bootstrap} uses. Fastify's
 * `app.log` (pino) satisfies it without a cast; a test can pass a recording fake.
 */
export interface AnsibleVenvLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Result of running a subprocess. */
export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

/** Spawns a subprocess and resolves with its captured output (rejects on failure). */
export type RunCommand = (file: string, args: string[]) => Promise<RunCommandResult>;

/** Injectable seams so tests never spawn `python3`/`pip` or read real PyPI. */
export interface AnsibleVenvSupervisorDeps {
  /** Subprocess runner; defaults to a promisified `execFile`. */
  runCommand?: RunCommand;
  /** Existence check; defaults to `node:fs` `existsSync`. */
  fileExists?: (path: string) => boolean;
  /** Read the recorded `ansible-core` version, or `null` if absent/unreadable. */
  readSentinel?: (path: string) => string | null;
  /** Record the installed `ansible-core` version. */
  writeSentinel?: (path: string, value: string) => void;
  /** Recursively create a directory (and parents). */
  makeDir?: (path: string) => void;
  /**
   * Copy `sourceDir` into `destDir`; returns `true` if a copy happened, `false`
   * if the source did not exist (a no-op). Defaults to a recursive `cpSync`.
   */
  syncPlaybooks?: (sourceDir: string, destDir: string) => boolean;
  /** Clock for `checkedAt`; defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Configuration the supervisor needs (a slice of {@link Settings}). */
export interface AnsibleVenvSupervisorConfig {
  /** Root of the data-volume Ansible directory (`<root>/venv`, `<root>/playbooks`). */
  ansibleDir: string;
  /** Pinned `ansible-core` version to install. */
  coreVersion: string;
  /** Read-only, in-image directory playbooks are synced from. */
  playbookSourceDir: string;
  /** `python3` interpreter to create the venv with. Defaults to `"python3"`. */
  pythonBin?: string;
}

/** Filename of the version sentinel written inside the venv. */
const VERSION_SENTINEL = ".pct-ansible-core-version";

/** Default recursive copy: copies `sourceDir`→`destDir`, or no-ops if absent. */
function defaultSyncPlaybooks(sourceDir: string, destDir: string): boolean {
  if (!existsSync(sourceDir)) return false;
  cpSync(sourceDir, destDir, { recursive: true });
  return true;
}

/** Default sentinel read: the trimmed file contents, or `null` if unreadable. */
function defaultReadSentinel(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Creates the Ansible venv on first run and holds the last-observed
 * {@link AnsibleVenvStatus}. Construct via {@link createAnsibleVenvSupervisor};
 * build once per app and decorate it onto Fastify so the status route reads the
 * same instance.
 */
export class AnsibleVenvSupervisor {
  readonly #config: Required<AnsibleVenvSupervisorConfig>;
  readonly #deps: Required<AnsibleVenvSupervisorDeps>;
  readonly #venvDir: string;
  readonly #binaryPath: string;
  readonly #pythonInVenv: string;
  readonly #sentinelPath: string;
  readonly #playbooksDir: string;
  #status: AnsibleVenvStatus;

  constructor(config: AnsibleVenvSupervisorConfig, deps: AnsibleVenvSupervisorDeps = {}) {
    this.#config = { pythonBin: "python3", ...config };
    this.#deps = {
      runCommand: deps.runCommand ?? ((file, args) => execFileAsync(file, args)),
      fileExists: deps.fileExists ?? existsSync,
      readSentinel: deps.readSentinel ?? defaultReadSentinel,
      writeSentinel: deps.writeSentinel ?? ((path, value) => writeFileSync(path, `${value}\n`)),
      makeDir: deps.makeDir ?? ((path) => void mkdirSync(path, { recursive: true })),
      syncPlaybooks: deps.syncPlaybooks ?? defaultSyncPlaybooks,
      now: deps.now ?? (() => new Date()),
    };

    this.#venvDir = join(this.#config.ansibleDir, "venv");
    this.#binaryPath = join(this.#venvDir, "bin", "ansible-playbook");
    this.#pythonInVenv = join(this.#venvDir, "bin", "python");
    this.#sentinelPath = join(this.#venvDir, VERSION_SENTINEL);
    this.#playbooksDir = join(this.#config.ansibleDir, "playbooks");

    this.#status = {
      state: "idle",
      binaryPath: this.#binaryPath,
      playbooksDir: this.#playbooksDir,
      coreVersion: this.#config.coreVersion,
      checkedAt: null,
      detail: null,
    };
  }

  /** An immutable snapshot of the current status. */
  get status(): AnsibleVenvStatus {
    return { ...this.#status };
  }

  /**
   * Ensure the venv exists with the pinned `ansible-core`, syncing playbooks.
   *
   * Idempotent and safe to call unconditionally on every boot:
   * - playbooks are synced from the in-image source (a missing source is a
   *   logged no-op, so a not-yet-packaged image still bootstraps);
   * - the venv is created + `pip install`ed only when its `ansible-playbook` is
   *   absent, or reinstalled when the recorded version differs from the pinned
   *   one (so an image upgrade that bumps the pin reconciles the venv);
   * - when the binary is present and the version matches, it is a fast no-op.
   *
   * Never throws — every failure is caught, recorded as `unavailable` with a
   * `detail`, and logged at `error` level so startup is not blocked.
   */
  async bootstrap(logger?: AnsibleVenvLogger): Promise<AnsibleVenvStatus> {
    this.#status = { ...this.#status, state: "bootstrapping" };

    // Playbook sync is independent of the venv: a failure here must not stop the
    // venv work, and a missing source dir is expected before the playbooks are
    // packaged into the image (#39 follow-up).
    this.#syncPlaybooks(logger);

    try {
      const reason = this.#installNeeded();
      if (reason === null) {
        return this.#settle("ready", null, logger, "Ansible venv already present");
      }

      this.#deps.makeDir(this.#config.ansibleDir);
      if (reason === "missing") {
        await this.#deps.runCommand(this.#config.pythonBin, ["-m", "venv", this.#venvDir]);
      }
      await this.#deps.runCommand(this.#pythonInVenv, [
        "-m",
        "pip",
        "install",
        "--no-input",
        "--disable-pip-version-check",
        `ansible-core==${this.#config.coreVersion}`,
      ]);
      this.#deps.writeSentinel(this.#sentinelPath, this.#config.coreVersion);

      const msg =
        reason === "missing"
          ? "created Ansible venv and installed ansible-core (first run)"
          : "reconciled Ansible venv to the pinned ansible-core version";
      return this.#settle("ready", null, logger, msg);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Timestamp captured at completion (here, after the potentially
      // multi-minute pip install), so `checkedAt` means "last settled".
      this.#status = {
        ...this.#status,
        state: "unavailable",
        checkedAt: this.#deps.now().toISOString(),
        detail,
      };
      logger?.error(
        { event: "ansible_venv_bootstrap", state: "unavailable", err },
        `Ansible venv bootstrap failed; Ansible disabled: ${detail}`,
      );
      return this.status;
    }
  }

  /**
   * Whether (and why) `pip install` must run: `"missing"` when there is no
   * venv binary, `"drift"` when it exists but the recorded version differs from
   * the pin, or `null` when the venv is already at the pinned version.
   */
  #installNeeded(): "missing" | "drift" | null {
    if (!this.#deps.fileExists(this.#binaryPath)) return "missing";
    const recorded = this.#deps.readSentinel(this.#sentinelPath);
    return recorded === this.#config.coreVersion ? null : "drift";
  }

  #syncPlaybooks(logger?: AnsibleVenvLogger): void {
    try {
      const copied = this.#deps.syncPlaybooks(this.#config.playbookSourceDir, this.#playbooksDir);
      if (copied) {
        logger?.info(
          { event: "ansible_playbook_sync", source: this.#config.playbookSourceDir },
          "synced Ansible playbooks from the image",
        );
      } else {
        logger?.info(
          { event: "ansible_playbook_sync", source: this.#config.playbookSourceDir },
          "no in-image Ansible playbooks to sync (source absent)",
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger?.error(
        { event: "ansible_playbook_sync", err },
        `Ansible playbook sync failed (continuing): ${detail}`,
      );
    }
  }

  #settle(
    state: AnsibleVenvState,
    detail: string | null,
    logger: AnsibleVenvLogger | undefined,
    msg: string,
  ): AnsibleVenvStatus {
    // Timestamp captured at completion so `checkedAt` reflects when the
    // bootstrap settled, not when it began (pip install can take minutes).
    this.#status = { ...this.#status, state, checkedAt: this.#deps.now().toISOString(), detail };
    logger?.info({ event: "ansible_venv_bootstrap", state }, msg);
    return this.status;
  }
}

/** Build an {@link AnsibleVenvSupervisor} from the relevant settings. */
export function createAnsibleVenvSupervisor(
  config: AnsibleVenvSupervisorConfig,
  deps: AnsibleVenvSupervisorDeps = {},
): AnsibleVenvSupervisor {
  return new AnsibleVenvSupervisor(config, deps);
}
