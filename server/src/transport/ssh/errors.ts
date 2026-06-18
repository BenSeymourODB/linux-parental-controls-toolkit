/**
 * Error taxonomy for the SSH transport facade.
 *
 * The split that matters to callers is **"host unreachable" vs "command
 * failed"** (issue #82): an unreachable host is a transient/topological
 * condition the Phase-4 offline-queue (#84) retries later, whereas a non-zero
 * exit means we reached the box and the *command* failed — replaying it
 * unchanged will fail again. Callers branch on the class (or the
 * {@link SshError.retriable} flag) rather than sniffing error message text.
 *
 * License boundary: none touched — plain TypeScript over `ssh2`'s exec
 * channel; no GPL code is linked in-process.
 */

/** Identifies an `SshTarget` in error messages without leaking credentials. */
export interface SshTargetRef {
  readonly host: string;
  readonly port: number;
  readonly username: string;
}

/** Render a target as `user@host:port` for human-readable error messages. */
export function formatTarget(target: SshTargetRef): string {
  return `${target.username}@${target.host}:${target.port}`;
}

/** Base class for every error the SSH facade raises. */
export abstract class SshError extends Error {
  /** The target the failed operation was aimed at. */
  readonly target: SshTargetRef;
  /**
   * Whether retrying the *same* operation later might succeed without
   * changing it. True for unreachable hosts (offline-queue territory), false
   * for a command that ran and failed or produced unparseable output.
   */
  abstract readonly retriable: boolean;

  constructor(message: string, target: SshTargetRef, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.target = target;
  }
}

/**
 * The host could not be reached or the SSH session never became ready
 * (connection refused, DNS failure, handshake/auth failure, or connect
 * timeout). Retriable — feeds the offline-queue.
 */
export class SshUnreachableError extends SshError {
  readonly retriable = true;

  constructor(target: SshTargetRef, options?: { cause?: unknown }) {
    super(`SSH host unreachable: ${formatTarget(target)}`, target, options);
  }
}

/**
 * A command was executed on a reachable host but exited non-zero (or was
 * killed by a signal). Not retriable as-is — the command itself failed.
 * Carries the captured streams and exit status for diagnosis.
 */
export class SshCommandError extends SshError {
  readonly retriable = false;
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    target: SshTargetRef,
    argv: readonly string[],
    result: { code: number | null; signal: string | null; stdout: string; stderr: string },
  ) {
    const status = result.code !== null ? `exit code ${result.code}` : `signal ${result.signal}`;
    super(`Remote command failed (${status}) on ${formatTarget(target)}: ${argv[0]}`, target);
    this.argv = argv;
    this.code = result.code;
    this.signal = result.signal;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/**
 * A command succeeded (exit 0) but its stdout did not match the zod schema the
 * caller expected. Not retriable — the remote tool's output shape is wrong, so
 * replaying won't help. Carries the raw stdout and the validation cause.
 */
export class SshParseError extends SshError {
  readonly retriable = false;
  readonly argv: readonly string[];
  readonly stdout: string;

  constructor(
    target: SshTargetRef,
    argv: readonly string[],
    stdout: string,
    options?: { cause?: unknown },
  ) {
    super(`Could not parse stdout of ${argv[0]} on ${formatTarget(target)}`, target, options);
    this.argv = argv;
    this.stdout = stdout;
  }
}

/**
 * A command exceeded its per-exec timeout and was aborted. Distinct from
 * unreachable (the host answered and accepted the channel) and from a clean
 * non-zero exit (the command never returned). Retriable — a hung invocation
 * may complete promptly on a later attempt.
 */
export class SshExecTimeoutError extends SshError {
  readonly retriable = true;
  readonly argv: readonly string[];
  readonly timeoutMs: number;

  constructor(target: SshTargetRef, argv: readonly string[], timeoutMs: number) {
    super(
      `Remote command timed out after ${timeoutMs}ms on ${formatTarget(target)}: ${argv[0]}`,
      target,
    );
    this.argv = argv;
    this.timeoutMs = timeoutMs;
  }
}
