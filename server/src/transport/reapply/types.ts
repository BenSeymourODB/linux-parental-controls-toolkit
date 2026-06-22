/**
 * Shared types for the periodic re-apply (tamper-reversion) scheduler (#93).
 *
 * The scheduler periodically re-runs the Phase-6 Ansible playbooks against the
 * enrolled client fleet so unauthorised local config edits drift back to the
 * policy-derived desired state (`docs/architecture.md` → "Tamper attempt on
 * client", Phase 6 in `docs/roadmap.md`). These types are the contract between
 * {@link ./scheduler.ts} and the seams it depends on, all of which are
 * **injected** so the scheduler stays decoupled from the DB and from the
 * Ansible/SSH subprocess boundary — exactly like the offline-queue scheduler
 * (`transport/queue/types.ts`).
 *
 * License boundary: none touched — plain TypeScript. The real reconciliation
 * still execs `ansible-playbook` as a subprocess via the merged
 * `transport/ansible` runner; this module only schedules and audits it.
 */
import type { AnsibleHost } from "../ansible/index.js";

/**
 * The slice of a `clients` row a re-apply pass needs: the id (for audit
 * attribution and per-client backoff) plus the {@link AnsibleHost} fields the
 * runner renders into a single-host inventory. A full Drizzle `clients` select
 * row is assignable to this shape, so the production loader can return DB rows
 * directly.
 */
export interface ReapplyTarget extends AnsibleHost {
  /** Enrolled client the playbooks are reconciled against. */
  readonly id: number;
}

/**
 * Loads the set of enrolled clients to reconcile on each pass. Injected (prod:
 * `() => listClients(db)`) so the scheduler needs no DB handle of its own and
 * is unit-testable with a plain array.
 */
export type ClientLoader = () => readonly ReapplyTarget[];

/**
 * Probes whether a client is currently reachable. Called before a re-apply so a
 * known-offline host isn't dialled (its drift is reconciled on a later pass,
 * once it is back). Same shape and purpose as the offline-queue's probe, but
 * declared locally to keep this module self-contained; injected for the same
 * reason — testability without a live client.
 */
export type ReachabilityProbe = (clientId: number) => Promise<boolean>;
