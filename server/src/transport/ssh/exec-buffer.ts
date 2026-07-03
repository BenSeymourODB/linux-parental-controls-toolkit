/**
 * Buffers a single remote command's execution over an already-connected `ssh2`
 * session: capture stdout/stderr, resolve the exit status, enforce the per-exec
 * timeout, and translate the channel's terminal states into the SSH error
 * taxonomy (`./errors.ts`). Extracted from `SshTransport`'s exec path so the
 * facade is left focused on connection pooling + dispatch (#306).
 *
 * Deliberately **pool-agnostic**: it never touches the transport's connection
 * cache. Evicting a now-suspect pooled connection is the transport's concern —
 * it evicts whenever {@link ExecBuffer.run} rejects with an
 * {@link SshUnreachableError} (the two cases that mean the *session*, not just
 * the command, is dead) and leaves it pooled on an {@link SshExecTimeoutError}
 * (the host answered; only the command hung).
 *
 * License boundary: unchanged — plain orchestration over `ssh2`'s exec channel,
 * no GPL code linked in-process (`CLAUDE.md`, `./facade.ts`).
 */
import type { EventEmitter } from "node:events";

import { SshExecTimeoutError, SshUnreachableError, type SshTargetRef } from "./errors.js";
import type { ExecResult } from "./facade.js";

/**
 * The exec channel surface an {@link ExecBuffer} consumes — a subset of `ssh2`'s
 * `ClientChannel` (a `Duplex`, hence an `EventEmitter`) with its `stderr`
 * sub-stream and `destroy`. Declared structurally so the real channel satisfies
 * it and a test can pass a lightweight fake without an `as` cast (the same
 * pattern as `transport/health`'s `HealthProbeTransport`).
 */
export interface ExecChannel extends EventEmitter {
  readonly stderr: EventEmitter;
  destroy(): void;
}

/** The slice of an `ssh2` `Client` an {@link ExecBuffer} drives: a single `exec`. */
export interface ExecCapableClient {
  exec(command: string, callback: (err: Error | undefined, channel: ExecChannel) => void): unknown;
}

/** The immutable context an {@link ExecBuffer} needs to run and to raise errors. */
export interface ExecBufferOptions {
  /** Human-readable target ref for error messages (never carries credentials). */
  readonly ref: SshTargetRef;
  /** The argument vector, for {@link SshExecTimeoutError} diagnostics. */
  readonly argv: readonly string[];
  /** Abort the command after this many ms; `0` (or less) disables the timeout. */
  readonly timeoutMs: number;
}

/**
 * Runs one command on a connected {@link Client} and buffers its result.
 * Single-use: construct with the invocation's context, then call {@link run}
 * once with the session and shell-quoted command string.
 */
export class ExecBuffer {
  readonly #ref: SshTargetRef;
  readonly #argv: readonly string[];
  readonly #timeoutMs: number;

  constructor(options: ExecBufferOptions) {
    this.#ref = options.ref;
    this.#argv = options.argv;
    this.#timeoutMs = options.timeoutMs;
  }

  /**
   * Run `command` on `client` and resolve with the captured streams + exit
   * status — **without** treating a non-zero exit as an error (the caller
   * inspects {@link ExecResult.code}). Rejects with {@link SshUnreachableError}
   * if the channel never opens or the session drops mid-command, or
   * {@link SshExecTimeoutError} if the command outlives
   * {@link ExecBufferOptions.timeoutMs}.
   */
  run(client: ExecCapableClient, command: string): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        run();
      };

      client.exec(command, (err: Error | undefined, channel: ExecChannel) => {
        if (err !== undefined) {
          // The session could not carry our command — surface it as unreachable
          // (the offline-queue's retry signal); the transport evicts the pooled
          // connection so the next call reconnects.
          finish(() => reject(new SshUnreachableError(this.#ref, { cause: err })));
          return;
        }

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let exited = false;
        let code: number | null = null;
        let signal: string | null = null;

        channel.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        channel.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
        channel.on("exit", (exitCode: number | null, exitSignal?: string) => {
          exited = true;
          code = exitCode;
          signal = exitSignal ?? null;
        });
        channel.on("close", () => {
          if (!exited) {
            // The channel closed without the peer reporting an exit status — the
            // session dropped mid-command rather than the command finishing.
            // Surface it as unreachable (retriable) so it can't be mistaken for
            // a clean signal-kill (`code: null`); the transport then evicts the
            // (now-suspect) connection so the next call reconnects.
            finish(() => reject(new SshUnreachableError(this.#ref)));
            return;
          }
          finish(() =>
            resolve({
              stdout: Buffer.concat(stdoutChunks).toString("utf8"),
              stderr: Buffer.concat(stderrChunks).toString("utf8"),
              code,
              signal,
            }),
          );
        });

        if (this.#timeoutMs > 0) {
          timer = setTimeout(() => {
            finish(() => {
              // Tear down only the hung channel; the connection stays pooled
              // (the host is reachable — the command, not the session, hung).
              channel.destroy();
              reject(new SshExecTimeoutError(this.#ref, this.#argv, this.#timeoutMs));
            });
          }, this.#timeoutMs);
          timer.unref();
        }
      });
    });
  }
}
