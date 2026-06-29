/**
 * Transport-audit barrel (#85): the append-only record of every command the
 * dashboard issues to a client.
 *
 * "Command" here means an admin-intent action (a `timekpra` push, a same-day
 * adjustment). Read-only **health probes** (the `systemctl is-active` liveness
 * checks, #81) are deliberately **not** audited — they run over the raw SSH
 * facade, not the {@link AuditingTransport} wrapper, so a fleet-wide probe on
 * every Clients-page load can't drown the real commands in the trail.
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
