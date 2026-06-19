/**
 * The Drizzle-backed {@link AuditSink} (#85): persists transport audit entries
 * to the `audit_log` table.
 *
 * better-sqlite3 is synchronous, so `record` inserts inline — no async seam for
 * the command path to await. Honouring the {@link AuditSink} contract, a failed
 * insert is **swallowed and logged**, never thrown: a wedged audit write must
 * not break the command that triggered it.
 *
 * License boundary: none touched — Drizzle (Apache-2.0) + better-sqlite3 (MIT),
 * both linked freely; no GPL component is involved.
 */
import type { PolicyDb } from "../../policy/db.js";
import { auditLog } from "../../policy/schema.js";
import type { AuditEntry, AuditSink } from "./recorder.js";

/** The minimal logger the sink needs to report a swallowed write failure. */
export interface AuditSinkLogger {
  error(obj: object, msg: string): void;
}

/** Default `actor` recorded when a command carries no attribution. */
export const DEFAULT_ACTOR = "system";

/** An {@link AuditSink} that appends entries to the policy store's `audit_log`. */
export class DrizzleAuditSink implements AuditSink {
  readonly #db: PolicyDb;
  readonly #log: AuditSinkLogger | undefined;

  /**
   * @param db the policy database to insert into.
   * @param log optional logger; a swallowed insert failure is reported here.
   */
  constructor(db: PolicyDb, log?: AuditSinkLogger) {
    this.#db = db;
    this.#log = log;
  }

  record(entry: AuditEntry): void {
    try {
      this.#db
        .insert(auditLog)
        .values({
          targetHost: entry.target.host,
          targetPort: entry.target.port,
          targetUser: entry.target.username,
          clientId: entry.context.clientId ?? null,
          userId: entry.context.userId ?? null,
          actor: entry.context.actor ?? DEFAULT_ACTOR,
          reason: entry.context.reason ?? null,
          command: [...entry.command],
          outcome: entry.outcome,
          exitCode: entry.exitCode,
          signal: entry.signal,
          durationMs: entry.durationMs,
          errorMessage: entry.errorMessage,
        })
        .run();
    } catch (err) {
      // Contract: never throw out of record(). An audit write that fails is
      // itself notable, so surface it in the log — but the command path that
      // triggered it must continue regardless.
      this.#log?.error(
        { err, event: "audit_record_failed", target: entry.target, outcome: entry.outcome },
        "failed to record transport audit entry",
      );
    }
  }
}
