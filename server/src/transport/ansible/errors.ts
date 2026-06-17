/**
 * Error taxonomy for the Ansible transport.
 *
 * `runPlaybook` surfaces every failure as one of these typed errors so callers
 * can branch without parsing prose. The split mirrors how `ansible-playbook`
 * itself reports trouble, and feeds later phases:
 *
 * - {@link AnsibleUnavailableError} — the venv / `ansible-playbook` binary is
 *   absent (the first-run bootstrap of #39 has not happened yet). Distinct
 *   from a playbook that ran and failed.
 * - {@link AnsibleUnreachableError} — one or more target hosts were
 *   unreachable. This is the retryable category the Phase-4 offline-queue
 *   (#84) keys on, the same way the SSH transport distinguishes "host
 *   unreachable" from "command failed".
 * - {@link AnsiblePlaybookFailedError} — the binary ran and exited non-zero
 *   for any other reason (a task failed, a syntax/parse error, bad CLI).
 * - {@link AnsibleInventoryError} — a `Client` record could not be rendered
 *   into a safe inventory line (rejected before any subprocess is spawned).
 *
 * License boundary: plain TypeScript error classes; nothing links Ansible
 * in-process. See `docs/licensing-analysis.md`.
 */

/** Base class for every error the Ansible transport raises. */
export class AnsibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnsibleError";
  }
}

/**
 * The `ansible-playbook` binary could not be spawned — typically because the
 * first-run venv (`<ansibleDir>/venv`, bootstrapped by #39) does not exist
 * yet. Carries the path we tried to execute.
 */
export class AnsibleUnavailableError extends AnsibleError {
  readonly binaryPath: string;

  constructor(binaryPath: string, cause?: unknown) {
    super(
      `ansible-playbook is not available at ${binaryPath} — has the first-run ` +
        `Ansible venv been bootstrapped? (see docs/server-deployment.md → First-run setup)`,
    );
    this.name = "AnsibleUnavailableError";
    this.binaryPath = binaryPath;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * One or more target hosts were unreachable (Ansible exit code with the `4`
 * bit set). Retryable: the run should be queued and replayed when the client
 * is next reachable (#84).
 */
export class AnsibleUnreachableError extends AnsibleError {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, stderr: string) {
    super(`ansible-playbook reported unreachable host(s) (exit code ${exitCode})`);
    this.name = "AnsibleUnreachableError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * The playbook ran but exited non-zero for a reason other than an unreachable
 * host (a failed task, a parse error, a bad invocation). Not automatically
 * retryable — the admin needs to see what failed.
 */
export class AnsiblePlaybookFailedError extends AnsibleError {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, stderr: string) {
    super(`ansible-playbook failed (exit code ${exitCode})`);
    this.name = "AnsiblePlaybookFailedError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * A `Client` record (or a playbook name) could not be turned into a safe
 * argument — e.g. a hostname containing characters that would inject extra
 * tokens into the inventory file. Raised before any subprocess is spawned.
 */
export class AnsibleInventoryError extends AnsibleError {
  constructor(message: string) {
    super(message);
    this.name = "AnsibleInventoryError";
  }
}
