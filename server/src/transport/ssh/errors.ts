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
 * Why an {@link SshUnreachableError} happened — a *diagnostic* classification of
 * the four+ root causes the single "host unreachable" string used to collapse
 * (#353), each with a different operator fix:
 *
 * - `dns` — the hostname doesn't resolve (`getaddrinfo ENOTFOUND` / `EAI_AGAIN`):
 *   fix container DNS or enrol by IP.
 * - `connection_refused` — nothing is listening on the SSH port (`ECONNREFUSED`):
 *   sshd is down — re-run the installer.
 * - `timeout` — the host never answered (`ETIMEDOUT` / ssh2 `client-timeout`):
 *   a firewall or a stale/changed address.
 * - `auth` — the box answered but rejected our key (ssh2 `client-authentication`,
 *   "All configured authentication methods failed"): the dashboard key isn't
 *   authorized on the client.
 * - `handshake` — the transport connected but the SSH handshake/key-exchange
 *   failed (ssh2 `protocol`): an SSH version/config mismatch.
 * - `unknown` — no `ssh2` error was available to classify (e.g. a mid-session
 *   channel drop) or it matched none of the above.
 *
 * This is metadata only: it does **not** change the retriable/queue taxonomy —
 * an `SshUnreachableError` stays retriable regardless of reason.
 */
export const sshUnreachableReasonValues = [
  "dns",
  "connection_refused",
  "timeout",
  "auth",
  "handshake",
  "unknown",
] as const;

/** One classified root cause for an {@link SshUnreachableError}. */
export type SshUnreachableReason = (typeof sshUnreachableReasonValues)[number];

/**
 * Flatten an error's `cause` chain into one lowercased signature string built
 * from each link's `code`, `level`, `syscall`, and `message`. `ssh2` surfaces
 * the discriminating detail across these fields (and sometimes on a wrapped
 * `cause`), so matching against the whole chain is more robust than reading a
 * single property. Bounded depth guards against a self-referential chain.
 */
function errorSignature(cause: unknown): string {
  const parts: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; current !== null && current !== undefined && depth < 8; depth += 1) {
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const record = current as Record<string, unknown>;
    for (const key of ["code", "level", "syscall", "message"] as const) {
      const value = record[key];
      if (typeof value === "string") parts.push(value);
    }
    current = record["cause"];
  }
  return parts.join(" | ").toLowerCase();
}

/**
 * Classify the `ssh2`/socket error behind a connection failure into an
 * {@link SshUnreachableReason}. Pure and side-effect-free so it is unit-testable
 * against representative error fixtures without a live socket.
 *
 * Order matters: `timeout` is matched before `handshake` because ssh2's connect
 * timeout reads "Timed out while waiting for handshake" — that is a timeout, not
 * a handshake failure. `undefined`/`null` (no captured cause) → `"unknown"`.
 */
export function classifySshUnreachableReason(cause: unknown): SshUnreachableReason {
  if (cause === undefined || cause === null) return "unknown";
  const sig = errorSignature(cause);
  if (/enotfound|eai_again|getaddrinfo/.test(sig)) return "dns";
  if (/econnrefused/.test(sig)) return "connection_refused";
  // `EHOSTUNREACH`/`ENETUNREACH` (no route to host / network down) are the same
  // "the box didn't answer" class as a connect timeout for the admin's purposes.
  if (/etimedout|ehostunreach|enetunreach|client-timeout|timed out/.test(sig)) return "timeout";
  if (/client-authentication|authentication methods failed|authentication failed/.test(sig)) {
    return "auth";
  }
  // Match ssh2's handshake/protocol phrasing. `kex` alone is too short a token to
  // match against free-text (it can appear inside a hostname), so require the
  // fuller "key exchange".
  if (/handshake|key exchange|protocol/.test(sig)) return "handshake";
  return "unknown";
}

/**
 * The host could not be reached or the SSH session never became ready
 * (connection refused, DNS failure, handshake/auth failure, or connect
 * timeout). Retriable — feeds the offline-queue.
 *
 * Carries a classified {@link reason} (#353) derived from the underlying `ssh2`
 * error so the health probe, the audit log, and the offline-queue drainer can
 * report *which* failure it was instead of one catch-all string. The reason is
 * diagnostic only — it does not affect {@link retriable}.
 */
export class SshUnreachableError extends SshError {
  readonly retriable = true;
  /** The classified root cause, from the `ssh2` error passed as `options.cause`. */
  readonly reason: SshUnreachableReason;

  constructor(target: SshTargetRef, options?: { cause?: unknown }) {
    super(`SSH host unreachable: ${formatTarget(target)}`, target, options);
    this.reason = classifySshUnreachableReason(options?.cause);
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
