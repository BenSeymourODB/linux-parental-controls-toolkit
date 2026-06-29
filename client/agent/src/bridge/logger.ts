/**
 * Minimal structured logger for the bridge daemon (#101, Phase 8b).
 *
 * The bridge runs as a `systemd` unit, so its stdout/stderr are captured by the
 * journal; structured one-line JSON keeps `journalctl` greppable. This is a
 * deliberately tiny logger (the dashboard's pino is a heavier dependency than a
 * single daemon needs) writing straight to the streams — which is also why
 * `no-console` is enforced in `src/`: log output is a named concern that flows
 * through here, never an ad-hoc `console.log`.
 *
 * License boundary: none touched — plain TypeScript + `node:process`.
 */
import process from "node:process";

/** Severity levels, ordered; `warn`/`error` go to stderr, the rest to stdout. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured fields attached to a log line. Values must be JSON-serialisable. */
export type LogFields = Record<string, unknown>;

/** The logging surface the bridge modules depend on (injectable in tests). */
export interface Logger {
  debug(fields: LogFields, msg: string): void;
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
}

/** Where a {@link StreamLogger} writes; defaults to the process streams. */
export interface LogSinks {
  out: { write(chunk: string): void };
  err: { write(chunk: string): void };
}

/**
 * A {@link Logger} that emits one JSON object per line. `at` is filled from the
 * injected `now` (defaults to `Date.now`) so tests can pin the timestamp.
 * Non-serialisable field values are dropped by `JSON.stringify`; an `Error`
 * value is reduced to its message + name so a thrown cause logs usefully.
 */
export class StreamLogger implements Logger {
  readonly #sinks: LogSinks;
  readonly #now: () => number;
  readonly #component: string;

  constructor(
    options: {
      component?: string;
      sinks?: LogSinks;
      now?: () => number;
    } = {},
  ) {
    this.#component = options.component ?? "pct-client-bridge";
    this.#sinks = options.sinks ?? {
      out: { write: (chunk) => void process.stdout.write(chunk) },
      err: { write: (chunk) => void process.stderr.write(chunk) },
    };
    this.#now = options.now ?? Date.now;
  }

  debug(fields: LogFields, msg: string): void {
    this.#emit("debug", fields, msg);
  }
  info(fields: LogFields, msg: string): void {
    this.#emit("info", fields, msg);
  }
  warn(fields: LogFields, msg: string): void {
    this.#emit("warn", fields, msg);
  }
  error(fields: LogFields, msg: string): void {
    this.#emit("error", fields, msg);
  }

  #emit(level: LogLevel, fields: LogFields, msg: string): void {
    const line =
      JSON.stringify({
        at: new Date(this.#now()).toISOString(),
        level,
        component: this.#component,
        msg,
        ...normaliseFields(fields),
      }) + "\n";
    const sink = level === "warn" || level === "error" ? this.#sinks.err : this.#sinks.out;
    sink.write(line);
  }
}

/** Reduce non-JSON-friendly field values (notably `Error`) to loggable shapes. */
function normaliseFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message } : value;
  }
  return out;
}
