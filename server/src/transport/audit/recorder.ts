/**
 * Transport-audit recorder primitives (#85).
 *
 * The audit layer records an append-only entry for every command the dashboard
 * issues to a client. This module defines the data shapes and the sink
 * contract; {@link ./sink.ts} persists entries to the policy store and
 * {@link ./transport.ts} produces them automatically by wrapping the SSH facade.
 *
 * License boundary: none touched — plain TypeScript over the existing SSH
 * subprocess boundary. No GPL code is linked and no GPL binary is added.
 */
import type { AuditOutcome } from "../../policy/enums.js";
import type { SshTargetRef } from "../ssh/errors.js";

/**
 * Caller-supplied attribution for a command: which enrolled client / supervised
 * user it concerned, who/what triggered it, and an optional short reason. All
 * optional — an un-attributed internal command records `actor = "system"` and
 * null client/user (the host/user are still captured from the target).
 */
export interface AuditContext {
  /** Enrolled client the command targeted, when known. */
  readonly clientId?: number | null;
  /** Supervised user the command concerned, when known. */
  readonly userId?: number | null;
  /** Who/what triggered it: `system` (default), `admin`, `integration:<name>`. */
  readonly actor?: string;
  /** Optional short categorisation of why the command was issued. */
  readonly reason?: string | null;
}

/** A fully-formed audit entry the sink persists verbatim. */
export interface AuditEntry {
  /** The target the command was aimed at (host/port/user, no credentials). */
  readonly target: SshTargetRef;
  /** The command vector, already redacted of any secret-bearing argument. */
  readonly command: readonly string[];
  /** Outcome derived from the SSH facade's error taxonomy. */
  readonly outcome: AuditOutcome;
  /** Process exit code, or `null` (signal-killed, or never ran). */
  readonly exitCode: number | null;
  /** Terminating signal name, or `null`. */
  readonly signal: string | null;
  /** Wall-clock duration of the attempt in milliseconds (`>= 0`). */
  readonly durationMs: number;
  /** Truncated error summary for a non-`ok` outcome; `null` on success. */
  readonly errorMessage: string | null;
  /** Attribution supplied by the caller (see {@link AuditContext}). */
  readonly context: AuditContext;
}

/**
 * Append-only sink for transport audit entries.
 *
 * **Contract: `record` MUST NOT throw.** Auditing is a side effect of issuing a
 * command and must never break the command path — an implementation that can
 * fail (a DB write) swallows and logs its own errors. See
 * {@link ./sink.ts}'s `DrizzleAuditSink`.
 */
export interface AuditSink {
  record(entry: AuditEntry): void;
}

/** Flags whose following value (or `=value`) is masked in a recorded command. */
const SENSITIVE_FLAG = /^--?(?:password|passphrase|secret|token|api[-_]?key)$/i;

/** The placeholder a redacted argument is replaced with. */
export const REDACTED = "[redacted]";

/**
 * Defensively mask secret-bearing arguments in a command vector before it is
 * recorded. No credential is expected in argv (the SSH key lives in the target,
 * timekpra args carry none) — this guards future call sites (Ansible, ad-hoc
 * commands) so a secret can never leak into the audit log. Handles both
 * `--flag value` and `--flag=value` forms.
 */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const eq = arg.indexOf("=");
    if (eq > 0 && SENSITIVE_FLAG.test(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=${REDACTED}`);
      continue;
    }
    out.push(arg);
    if (SENSITIVE_FLAG.test(arg) && i + 1 < argv.length) {
      out.push(REDACTED);
      i += 1;
    }
  }
  return out;
}
