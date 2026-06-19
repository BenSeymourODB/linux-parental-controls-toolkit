/**
 * Transport-audit barrel (#85): the append-only record of every command the
 * dashboard issues to a client.
 *
 * - {@link AuditingTransport} wraps the SSH facade so auditing is automatic.
 * - {@link DrizzleAuditSink} persists entries to the `audit_log` table.
 * - {@link listAuditEntries} reads them back for the admin audit view.
 */
export type { AuditContext, AuditEntry, AuditSink } from "./recorder.js";
export { redactArgv, REDACTED } from "./recorder.js";
export { DrizzleAuditSink, DEFAULT_ACTOR, type AuditSinkLogger } from "./sink.js";
export { AuditingTransport, type AuditableTransport } from "./transport.js";
export { listAuditEntries, type AuditEntryRow, type AuditQuery } from "./repository.js";
