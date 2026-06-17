/**
 * Ansible transport: runs `ansible-playbook` as a subprocess
 * (node:child_process), from the venv bootstrapped into the data volume.
 *
 * This is the structural license boundary for Ansible: we only ever **exec**
 * the `ansible-playbook` binary out of the isolated `/data` venv and parse its
 * exit code/output. Ansible (GPL-3.0) is never linked, imported, embedded, or
 * vendored — a Node process cannot import it, and that separation is the
 * point. See `CLAUDE.md` → "License boundaries" (rule 3) and
 * `docs/licensing-analysis.md`.
 *
 * The runner is the foundation the per-playbook issues (#90/#91/#92) build on.
 * It is deliberately thin: generate a dynamic inventory from the dashboard's
 * `Client` records, invoke one playbook against it, and surface the result
 * through a typed error taxonomy ({@link ./errors.ts}). Loading the real
 * `Client` rows (Phase-2 CRUD, #51), bootstrapping the venv (#39), persisting
 * an audit row per run (#85), and the playbooks themselves are separate
 * issues; this module takes injected hosts and logs a structured run record.
 */
import { execFile, type ExecFileException } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyBaseLogger } from "fastify";

import {
  AnsibleError,
  AnsiblePlaybookFailedError,
  AnsibleUnavailableError,
  AnsibleUnreachableError,
} from "./errors.js";
import { buildInventory, type AnsibleHost } from "./inventory.js";

export const moduleName = "transport/ansible";

export * from "./errors.js";
export { buildInventory, INVENTORY_GROUP, type AnsibleHost } from "./inventory.js";

/**
 * Ansible's `TaskQueueManager` encodes the run outcome as an OR-able bit set
 * in the process exit code: `2` = one or more hosts failed, `4` = one or more
 * hosts were unreachable. We single out the unreachable bit so the caller can
 * treat that case as retryable (offline-queue, #84).
 */
const UNREACHABLE_BIT = 4;

/** Generous cap so a verbose playbook run is not truncated mid-capture. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * A bare playbook file name — no directory separators, no `..` — so a caller
 * can never escape the `<ansibleDir>/playbooks/` directory.
 */
const PLAYBOOK_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Construction-time configuration for {@link createAnsibleRunner}. */
export interface AnsibleRunnerOptions {
  /**
   * Root of the data-volume Ansible directory (`PCT_ANSIBLE_DIR`, default
   * `/data/ansible`). The binary is resolved at `<ansibleDir>/venv/bin/
   * ansible-playbook` and playbooks at `<ansibleDir>/playbooks/`.
   */
  ansibleDir: string;
  /** Component child logger (`componentLogger(app, "transport/ansible")`). */
  logger: FastifyBaseLogger;
  /** Override the captured-output buffer cap (bytes). */
  maxBuffer?: number;
}

/** Arguments for a single {@link AnsibleRunner.runPlaybook} invocation. */
export interface RunPlaybookOptions {
  /** Playbook file name within `<ansibleDir>/playbooks/`. */
  playbook: string;
  /** Target clients; rendered into a per-run dynamic inventory. */
  hosts: readonly AnsibleHost[];
  /** Optional `--extra-vars`, passed to Ansible as a single JSON object. */
  extraVars?: Record<string, string | number | boolean>;
  /** Optional `--limit` host pattern to narrow the run within the inventory. */
  limit?: string;
}

/** The outcome of a successful run (exit code 0). */
export interface AnsibleRunResult {
  /** The playbook that was run. */
  playbook: string;
  /** Always `0` here — non-zero exits throw (see {@link ./errors.ts}). */
  exitCode: number;
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
}

/** The Ansible runner facade. */
export interface AnsibleRunner {
  /**
   * Run one playbook against the given hosts.
   *
   * @throws {AnsibleError} if the playbook name is unsafe.
   * @throws {AnsibleInventoryError} if a host cannot be rendered safely.
   * @throws {AnsibleUnavailableError} if the venv/binary is missing.
   * @throws {AnsibleUnreachableError} if any host was unreachable.
   * @throws {AnsiblePlaybookFailedError} on any other non-zero exit.
   */
  runPlaybook(options: RunPlaybookOptions): Promise<AnsibleRunResult>;
}

/** Resolve the `ansible-playbook` binary path inside the first-run venv. */
function binaryPathFor(ansibleDir: string): string {
  return join(ansibleDir, "venv", "bin", "ansible-playbook");
}

function assertSafePlaybookName(playbook: string): void {
  if (!PLAYBOOK_NAME_PATTERN.test(playbook) || playbook === "." || playbook === "..") {
    throw new AnsibleError(
      `refusing to run playbook ${JSON.stringify(playbook)}: the name must be a bare ` +
        `file under the playbooks directory (letters, digits, '.', '_', '-')`,
    );
  }
}

/** Wrap callback-style `execFile` so the outcome is awaitable in one place. */
function runProcess(
  binaryPath: string,
  args: string[],
  maxBuffer: number,
): Promise<{ error: ExecFileException | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(binaryPath, args, { encoding: "utf8", maxBuffer }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Map an `execFile` failure onto the transport's error taxonomy. `ENOENT`
 * means the binary itself is missing (venv not bootstrapped); a numeric exit
 * code is interpreted via Ansible's bit set; anything else is a generic
 * failure.
 */
function classifyFailure(
  binaryPath: string,
  error: ExecFileException,
  stderr: string,
): AnsibleError {
  if (error.code === "ENOENT") {
    return new AnsibleUnavailableError(binaryPath, error);
  }
  const exitCode = typeof error.code === "number" ? error.code : 1;
  if ((exitCode & UNREACHABLE_BIT) !== 0) {
    return new AnsibleUnreachableError(exitCode, stderr);
  }
  return new AnsiblePlaybookFailedError(exitCode, stderr);
}

/**
 * Create an {@link AnsibleRunner} bound to a data-volume Ansible directory and
 * a component logger.
 */
export function createAnsibleRunner(options: AnsibleRunnerOptions): AnsibleRunner {
  const { ansibleDir, logger } = options;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const binaryPath = binaryPathFor(ansibleDir);

  return {
    async runPlaybook({ playbook, hosts, extraVars, limit }) {
      assertSafePlaybookName(playbook);

      // Build (and validate) the inventory before touching the filesystem, so
      // a bad host record fails fast without leaving a temp directory behind.
      const inventory = buildInventory(hosts);
      const playbookPath = join(ansibleDir, "playbooks", playbook);

      const workDir = await mkdtemp(join(tmpdir(), "pct-ansible-"));
      const inventoryPath = join(workDir, "inventory.ini");
      try {
        await writeFile(inventoryPath, inventory, "utf8");

        const args = ["-i", inventoryPath, playbookPath];
        if (limit !== undefined) args.push("--limit", limit);
        if (extraVars !== undefined) args.push("--extra-vars", JSON.stringify(extraVars));

        logger.info({ playbook, hostCount: hosts.length, limit }, "running ansible-playbook");

        const { error, stdout, stderr } = await runProcess(binaryPath, args, maxBuffer);

        if (error === null) {
          logger.info({ playbook, exitCode: 0 }, "ansible-playbook run completed");
          return { playbook, exitCode: 0, stdout, stderr };
        }

        const failure = classifyFailure(binaryPath, error, stderr);
        logger.warn(
          { playbook, error: failure.name, message: failure.message },
          "ansible-playbook run failed",
        );
        throw failure;
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
