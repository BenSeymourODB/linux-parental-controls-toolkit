/**
 * `AuditingTransport` (#85): a decorator over the SSH facade that records an
 * append-only audit entry for **every command issued**, with no per-call
 * boilerplate.
 *
 * It implements the same structural surface (`exec` / `execChecked` /
 * `execAndParse`) the `TimekprClient` already consumes ({@link TimekprTransport}),
 * so wrapping the shared `SshTransport` at bootstrap turns auditing on for the
 * whole transport — the timekpra setters, the health probe (#81), and the later
 * Ansible/enforcement call sites — without changing any of them.
 *
 * Attribution (which client/user, who triggered it) is carried as
 * {@link AuditContext}: {@link AuditingTransport.withContext} returns a
 * context-bound view sharing the inner transport and sink, so a per-client,
 * per-user `TimekprClient` records who it acted on while still reusing one
 * pooled connection underneath.
 *
 * License boundary: none touched — pure TypeScript over the existing SSH
 * subprocess boundary. The SSH error *classes* are our own (permissive); using
 * them to classify the outcome links no GPL code.
 */
import { performance } from "node:perf_hooks";

import type { ZodType } from "zod";

import type { AuditOutcome } from "../../policy/enums.js";
import {
  SshCommandError,
  SshExecTimeoutError,
  SshParseError,
  SshUnreachableError,
  type SshTargetRef,
} from "../ssh/errors.js";
import type { ExecOptions, ExecResult, SshTarget } from "../ssh/facade.js";
import type { AuditContext, AuditSink } from "./recorder.js";
import { redactArgv } from "./recorder.js";

/**
 * The slice of an SSH transport {@link AuditingTransport} wraps. The real
 * `SshTransport` satisfies it structurally, and `AuditingTransport` itself
 * implements it (so it is a drop-in for the timekpra client's transport).
 */
export interface AuditableTransport {
  exec(target: SshTarget, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  execChecked(
    target: SshTarget,
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
  execAndParse<T>(
    target: SshTarget,
    argv: readonly string[],
    schema: ZodType<T>,
    options?: ExecOptions,
  ): Promise<T>;
}

/** Max length of a recorded error message; longer messages are truncated. */
const MAX_ERROR_MESSAGE = 2000;

/** The outcome/exit fields an attempt resolves to, for the audit entry. */
interface AuditOutcomeFields {
  readonly outcome: AuditOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly errorMessage: string | null;
}

/** Truncate an error's message for storage, never throwing on a weird `err`. */
function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}…` : message;
}

/** Map a thrown transport error to its audit outcome + captured exit status. */
function fromError(err: unknown): AuditOutcomeFields {
  const message = errorMessage(err);
  if (err instanceof SshCommandError) {
    return { outcome: "failed", exitCode: err.code, signal: err.signal, errorMessage: message };
  }
  if (err instanceof SshUnreachableError) {
    return { outcome: "unreachable", exitCode: null, signal: null, errorMessage: message };
  }
  if (err instanceof SshExecTimeoutError) {
    return { outcome: "timeout", exitCode: null, signal: null, errorMessage: message };
  }
  if (err instanceof SshParseError) {
    return { outcome: "parse_error", exitCode: null, signal: null, errorMessage: message };
  }
  // An unexpected rejection (not from the SSH facade) is still a command that
  // did not succeed — record it as a failure rather than dropping it.
  return { outcome: "failed", exitCode: null, signal: null, errorMessage: message };
}

/** Reduce a target to the credential-free ref recorded in the audit entry. */
function targetRef(target: SshTarget): SshTargetRef {
  return { host: target.host, port: target.port ?? 22, username: target.username };
}

export class AuditingTransport implements AuditableTransport {
  readonly #inner: AuditableTransport;
  readonly #sink: AuditSink;
  readonly #context: AuditContext;

  /**
   * @param inner the transport to delegate to (an `SshTransport` or stand-in).
   * @param sink where audit entries are recorded.
   * @param context default attribution for commands run through this view.
   */
  constructor(inner: AuditableTransport, sink: AuditSink, context: AuditContext = {}) {
    this.#inner = inner;
    this.#sink = sink;
    this.#context = context;
  }

  /**
   * A context-bound view over the same inner transport and sink. The given
   * context is merged over this view's, so a per-client/per-user client can
   * attribute its commands while sharing one pooled connection underneath.
   */
  withContext(context: AuditContext): AuditingTransport {
    return new AuditingTransport(this.#inner, this.#sink, { ...this.#context, ...context });
  }

  async exec(
    target: SshTarget,
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return this.#run(target, argv, async () => {
      const result = await this.#inner.exec(target, argv, options);
      return {
        value: result,
        fields: {
          // exec() does not throw on a non-zero exit, so classify from the code.
          outcome: result.code === 0 ? "ok" : "failed",
          exitCode: result.code,
          signal: result.signal,
          errorMessage: null,
        },
      };
    });
  }

  async execChecked(
    target: SshTarget,
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return this.#run(target, argv, async () => {
      const result = await this.#inner.execChecked(target, argv, options);
      return {
        value: result,
        fields: { outcome: "ok", exitCode: result.code, signal: result.signal, errorMessage: null },
      };
    });
  }

  async execAndParse<T>(
    target: SshTarget,
    argv: readonly string[],
    schema: ZodType<T>,
    options?: ExecOptions,
  ): Promise<T> {
    return this.#run(target, argv, async () => {
      const value = await this.#inner.execAndParse(target, argv, schema, options);
      // execAndParse resolves only on a clean exit + successful parse.
      return { value, fields: { outcome: "ok", exitCode: 0, signal: null, errorMessage: null } };
    });
  }

  /**
   * Time `op`, record exactly one audit entry (success or failure), and return
   * or re-throw its result unchanged. Recording happens through the sink, whose
   * contract forbids throwing — so auditing can never alter the command's
   * outcome.
   */
  async #run<T>(
    target: SshTarget,
    argv: readonly string[],
    op: () => Promise<{ value: T; fields: AuditOutcomeFields }>,
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const { value, fields } = await op();
      this.#emit(target, argv, startedAt, fields);
      return value;
    } catch (err) {
      this.#emit(target, argv, startedAt, fromError(err));
      throw err;
    }
  }

  /** Build and record one audit entry for a settled attempt. */
  #emit(
    target: SshTarget,
    argv: readonly string[],
    startedAt: number,
    fields: AuditOutcomeFields,
  ): void {
    this.#sink.record({
      target: targetRef(target),
      command: redactArgv(argv),
      outcome: fields.outcome,
      exitCode: fields.exitCode,
      signal: fields.signal,
      durationMs: Math.round(performance.now() - startedAt),
      errorMessage: fields.errorMessage,
      context: this.#context,
    });
  }
}
