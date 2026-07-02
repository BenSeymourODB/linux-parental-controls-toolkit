/**
 * Periodic re-apply (tamper-reversion) scheduler (#93).
 *
 * A croner job (`CLAUDE.md` → "Scheduling: croner for in-process periodic
 * jobs … Ansible re-apply") that, each tick, re-runs the configured Phase-6
 * playbooks against the enrolled client fleet so unauthorised local edits drift
 * back to the policy-derived desired state (`docs/architecture.md` → "Tamper
 * attempt on client"; `docs/roadmap.md` → Phase 6). Each re-apply is recorded
 * in the transport audit log (#85); offline clients are skipped (their drift is
 * reconciled on a later pass once reachable); a client whose re-apply fails is
 * backed off with exponential delay so a persistently broken host doesn't
 * thrash the schedule.
 *
 * This is config **reconciliation**, not an anti-tamper arms race — squarely
 * within the bounded posture (`CLAUDE.md` → "Tamper resistance is deliberately
 * bounded", `docs/client-install.md`). A determined root user defeating it is a
 * parent-child conversation, not a defect.
 *
 * **Platform gate (#325).** The fleet is Linux today but need not be forever
 * (`docs/windows-client-support.md` item 6; `Client.platform`, #229). Like the
 * live policy-push path's platform seam (#232), the pass reconciles a client
 * only if its {@link ReapplyTarget.platform} is one this Ansible re-apply runner
 * **serves** ({@link DEFAULT_REAPPLY_PLATFORMS}, `linux` today). Selection is
 * exact-match: a client on an unserved platform is **skipped, not coerced** onto
 * the Linux playbooks. This is modelled as a served-*platforms* set rather than
 * #232's per-platform runner registry because the re-apply path is a *single*
 * Ansible reconciler (the playbooks are Linux Ansible YAML); a non-Linux client
 * is reconciled by an entirely different mechanism, not a second Ansible runner,
 * so the honest question here is "does this reconciler serve that platform" —
 * and the answer for anything but Linux is "no, somebody else does". Since
 * `Client.platform` is `NOT NULL DEFAULT 'linux'`, every real client today is
 * served and behaviour is unchanged.
 *
 * The {@link ClientLoader}, {@link ReachabilityProbe}, {@link AnsibleRunner},
 * and {@link AuditSink} are all **injected** — the runner execs
 * `ansible-playbook` out of the first-run venv (#39) and the playbooks
 * themselves (#90/#91/#92) do not exist yet, so — exactly like
 * `startOfflineQueueDrainer` (`transport/queue/scheduler.ts`) — this scheduler
 * is wired by its caller once those land, not started inside `buildApp`. That
 * keeps the module free of any GPL/transport coupling here.
 *
 * License boundary: none touched — croner (MIT) + the injected seams. The real
 * reconciliation still execs `ansible-playbook` as a subprocess via the merged
 * `transport/ansible` runner; nothing links, imports, or vendors Ansible.
 */
import { performance } from "node:perf_hooks";

import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";

import type { AuditOutcome, Platform } from "../../policy/enums.js";
import {
  AnsiblePlaybookFailedError,
  AnsibleUnreachableError,
  type AnsibleRunner,
} from "../ansible/index.js";
import { redactArgv, type AuditSink } from "../audit/index.js";
import type { ClientLoader, ReachabilityProbe, ReapplyTarget } from "./types.js";

/**
 * Default cadence: re-apply hourly. Drift reversion is not latency-critical (a
 * local edit being reverted within the hour is ample for a household), and a
 * tighter cadence would needlessly dial every client more often.
 */
export const DEFAULT_REAPPLY_PATTERN = "0 * * * *";

/** The pino `component` tag every scheduler log line carries (#11). */
export const REAPPLY_LOG_COMPONENT = "transport/reapply";

/** The `reason` recorded on every re-apply audit entry (a stable query key). */
export const REAPPLY_AUDIT_REASON = "periodic-reapply";

/**
 * The client platforms this Ansible re-apply reconciler serves (#325). A client
 * whose {@link ReapplyTarget.platform} is not in this set is skipped — the
 * Phase-6 playbooks are Linux Ansible YAML, so `linux` is the only served
 * platform today. Injectable via {@link PeriodicReapplyOptions.reapplyPlatforms}
 * for tests / a future non-Linux reconciler; the default keeps behaviour
 * unchanged (every real client is `linux`).
 */
export const DEFAULT_REAPPLY_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["linux"]);

/** Default SSH port recorded in the audit target (clients carry no port column). */
const DEFAULT_SSH_PORT = 22;

/** Max length of a recorded error message; longer messages are truncated. */
const MAX_ERROR_MESSAGE = 2000;

/** Per-client exponential backoff bounds after a failed re-apply. */
export interface ReapplyBackoff {
  /** Delay after the first failure; doubles each consecutive failure. */
  readonly baseMs: number;
  /** Ceiling the doubling is clamped to. */
  readonly maxMs: number;
}

/** Default backoff: 5 min after the first failure, doubling up to 6 hours. */
export const DEFAULT_REAPPLY_BACKOFF: ReapplyBackoff = {
  baseMs: 5 * 60 * 1000,
  maxMs: 6 * 60 * 60 * 1000,
};

/** Wiring for {@link startPeriodicReapply}. */
export interface PeriodicReapplyOptions {
  /** Loads the clients to reconcile this pass (injected; wraps `listClients`). */
  readonly loadClients: ClientLoader;
  /** Whether a client is reachable right now (injected; SSH probe in prod). */
  readonly probe: ReachabilityProbe;
  /** Runs one playbook against given hosts (injected; the Phase-6 runner). */
  readonly runner: AnsibleRunner;
  /**
   * Playbook file names to re-apply, in order, against each reachable client.
   * Empty (the default until #90/#91/#92 land) makes every tick a no-op.
   */
  readonly playbooks: readonly string[];
  /** Append-only audit sink; one entry recorded per (client, playbook) run. */
  readonly audit: AuditSink;
  /** Base logger; a `transport/reapply` child is derived for the job's lines. */
  readonly log: FastifyBaseLogger;
  /** croner pattern; defaults to {@link DEFAULT_REAPPLY_PATTERN}. */
  readonly pattern?: string;
  /** Per-client backoff bounds; defaults to {@link DEFAULT_REAPPLY_BACKOFF}. */
  readonly backoff?: ReapplyBackoff;
  /** Clock seam for backoff scheduling; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * The client platforms this reconciler serves (#325). A client whose
   * `platform` is not in the set is skipped (not coerced onto the Linux
   * playbooks). Defaults to {@link DEFAULT_REAPPLY_PLATFORMS} (`{ linux }`).
   */
  readonly reapplyPlatforms?: ReadonlySet<Platform>;
}

/** A running scheduler the caller can kick manually or stop on shutdown. */
export interface PeriodicReapplyHandle {
  /** Run one re-apply pass now (also what each cron tick invokes). */
  tick(): Promise<void>;
  /** Stop the schedule permanently (e.g. on `app.close()`). */
  stop(): void;
}

/** In-memory per-client backoff bookkeeping (lost on restart — acceptable). */
interface BackoffState {
  /** Consecutive failed passes (drives the exponential delay). */
  failures: number;
  /** Epoch ms before which this client is skipped. */
  nextEligibleAt: number;
}

/** Truncate a message for storage at {@link MAX_ERROR_MESSAGE}. */
function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}…` : message;
}

/** The audit fields a settled run resolves to, plus whether it is retryable. */
interface RunOutcome {
  readonly outcome: AuditOutcome;
  readonly exitCode: number | null;
  readonly errorMessage: string | null;
  /** `true` for an unreachable host — treated like offline, never a backoff. */
  readonly retriable: boolean;
}

const OK_OUTCOME: RunOutcome = {
  outcome: "ok",
  exitCode: 0,
  errorMessage: null,
  retriable: false,
};

/**
 * Map a thrown {@link AnsibleRunner} error onto an audit outcome. The runner's
 * error classes are our own (permissive) — branching on them links no GPL code.
 */
function classifyFailure(err: unknown): RunOutcome {
  const message = truncate(err instanceof Error ? err.message : String(err));
  if (err instanceof AnsibleUnreachableError) {
    return {
      outcome: "unreachable",
      exitCode: err.exitCode,
      errorMessage: message,
      retriable: true,
    };
  }
  if (err instanceof AnsiblePlaybookFailedError) {
    return { outcome: "failed", exitCode: err.exitCode, errorMessage: message, retriable: false };
  }
  // AnsibleUnavailableError (no venv yet), AnsibleInventoryError, or any
  // unexpected rejection: the playbook did not apply, so record it as a failure
  // the admin can see rather than dropping it.
  return { outcome: "failed", exitCode: null, errorMessage: message, retriable: false };
}

/**
 * Start the periodic re-apply scheduler and return a handle.
 *
 * Overlapping runs are suppressed (croner `protect`), so a slow fleet pass
 * can't stack up behind the schedule. One client's unexpected error is logged
 * and isolated so it never aborts the rest of the pass.
 */
export function startPeriodicReapply(options: PeriodicReapplyOptions): PeriodicReapplyHandle {
  const { loadClients, probe, runner, playbooks, audit, log } = options;
  const pattern = options.pattern ?? DEFAULT_REAPPLY_PATTERN;
  const backoff = options.backoff ?? DEFAULT_REAPPLY_BACKOFF;
  const now = options.now ?? Date.now;
  const reapplyPlatforms = options.reapplyPlatforms ?? DEFAULT_REAPPLY_PLATFORMS;
  const child = log.child({ component: REAPPLY_LOG_COMPONENT });

  /** Per-client failure/backoff state, keyed by client id. */
  const backoffByClient = new Map<number, BackoffState>();

  /** Push a client's next eligible time out after a failed pass. */
  function recordFailure(clientId: number): void {
    const failures = (backoffByClient.get(clientId)?.failures ?? 0) + 1;
    const delay = Math.min(backoff.baseMs * 2 ** (failures - 1), backoff.maxMs);
    backoffByClient.set(clientId, { failures, nextEligibleAt: now() + delay });
    child.warn({ clientId, failures, nextRetryMs: delay }, "re-apply failed; backing off client");
  }

  /** Run every configured playbook against one client; audit each attempt. */
  async function reapplyClient(client: ReapplyTarget): Promise<void> {
    const target = { host: client.hostname, port: DEFAULT_SSH_PORT, username: client.sshUser };
    const context = {
      clientId: client.id,
      userId: null,
      actor: "system",
      reason: REAPPLY_AUDIT_REASON,
    };

    let anyFailed = false;
    for (const playbook of playbooks) {
      const startedAt = performance.now();
      // A representative, normalised command for the audit row — not the
      // verbatim argv. The runner execs `ansible-playbook -i <tmp inventory>
      // <resolved path> --limit <host>`; the temp inventory path is ephemeral
      // and the resolved path is noise, so the audit records the playbook by
      // bare name plus the host it targeted. `redactArgv` is applied for
      // parity with the SSH audit path (these args carry no secret today).
      const command = redactArgv(["ansible-playbook", playbook, "--limit", client.hostname]);
      let result: RunOutcome;
      try {
        await runner.runPlaybook({ playbook, hosts: [client], limit: client.hostname });
        result = OK_OUTCOME;
      } catch (err) {
        result = classifyFailure(err);
      }

      audit.record({
        target,
        command,
        outcome: result.outcome,
        exitCode: result.exitCode,
        signal: null,
        durationMs: Math.round(performance.now() - startedAt),
        errorMessage: result.errorMessage,
        context,
      });

      if (result.retriable) {
        // The host dropped mid-pass — treat exactly like offline: leave backoff
        // untouched and let a later tick reconcile the rest. No point trying the
        // remaining playbooks against a host that's now unreachable.
        child.debug({ clientId: client.id, playbook }, "re-apply deferred: client unreachable");
        return;
      }
      if (result.outcome !== "ok") anyFailed = true;
    }

    if (anyFailed) {
      recordFailure(client.id);
      return;
    }
    // A clean full pass clears any prior backoff so the client returns to the
    // normal cadence.
    backoffByClient.delete(client.id);
    child.info({ clientId: client.id, playbooks: playbooks.length }, "re-apply pass succeeded");
  }

  const tick = async (): Promise<void> => {
    // Nothing to reconcile until at least one playbook is configured — skip the
    // fleet probe entirely so an unconfigured deployment is a true no-op.
    if (playbooks.length === 0) return;

    for (const client of loadClients()) {
      try {
        // Platform gate (#325): reconcile only clients this Ansible runner
        // serves. An unserved platform (a `windows` client today) is skipped
        // outright — never probed, reconciled, or backed off — rather than fed
        // to the Linux playbooks. `debug`, not `warn` like #232's one-shot push:
        // this is a periodic fleet sweep, so a per-tick warn would be log spam.
        if (!reapplyPlatforms.has(client.platform)) {
          child.debug(
            { clientId: client.id, platform: client.platform },
            "re-apply skipped: no re-apply runner for client platform",
          );
          continue;
        }
        const state = backoffByClient.get(client.id);
        if (state !== undefined && now() < state.nextEligibleAt) {
          child.debug({ clientId: client.id }, "re-apply skipped: client in backoff");
          continue;
        }
        if (!(await probe(client.id))) continue; // offline — reconcile later.
        await reapplyClient(client);
      } catch (error) {
        // One client's unexpected failure (e.g. a probe rejection) must not
        // abort the rest of the pass — log it and move on.
        child.error({ clientId: client.id, err: error }, "re-apply error");
      }
    }
  };

  const job = new Cron(pattern, { name: "periodic-reapply", protect: true }, tick);

  return {
    tick,
    stop: () => job.stop(),
  };
}
