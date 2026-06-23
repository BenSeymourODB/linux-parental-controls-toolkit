/**
 * e2guardian per-UID web-filter enforcement (Phase 6, #90).
 *
 * Two halves, kept apart so the policy→plan derivation is hermetically
 * unit-testable (the `playbook-generation` tier in `docs/testing.md`) and the
 * subprocess dispatch is a thin, injected seam:
 *
 * 1. {@link buildE2guardianPlan} resolves a typed, validated **filter plan**
 *    from the policy store — for each supervised user on a client, the set of
 *    domains that are *always-on denied*, assigned a deterministic e2guardian
 *    filter group + listen port.
 * 2. {@link pushE2guardianFiltering} hands that plan to the existing
 *    {@link AnsibleRunner} as `--extra-vars` and records the run in the audit
 *    log. The playbook (`client/ansible/playbooks/e2guardian-filtering.yml`)
 *    writes the per-UID e2guardian config + banned-site lists and the paired
 *    iptables OUTPUT redirect, then reloads the daemon.
 *
 * License boundary: e2guardian is configured **only** by writing config files
 * and signalling a reload, driven by `ansible-playbook` as a subprocess. No
 * e2guardian or Ansible code is linked, imported, or vendored — the process
 * boundary is the point (`CLAUDE.md` → "License boundaries", rules 3 & 6;
 * `docs/licensing-analysis.md`).
 */
import { z } from "zod";

import {
  getActivity,
  listClientLinks,
  listGroupActivities,
  listUserSchedules,
} from "../../policy/repository.js";
import type { PolicyDb } from "../../policy/db.js";
import type { ScheduleRow } from "../../policy/repository.js";
import { redactArgv, type AuditEntry, type AuditSink } from "../audit/index.js";

import type { AnsibleHost, AnsibleRunner, AnsibleRunResult, ExtraVarValue } from "./index.js";
import { AnsibleError, AnsiblePlaybookFailedError, AnsibleUnreachableError } from "./errors.js";

/** The playbook the runner invokes (resolved under `<ansibleDir>/playbooks/`). */
export const E2GUARDIAN_PLAYBOOK = "e2guardian-filtering.yml";

/**
 * Default base port the permissive baseline filter group (group 1) listens on,
 * matching the Phase-3 baseline (`client/install-baseline-tools.sh`). Per-user
 * managed groups get distinct ports counting up from here.
 */
export const DEFAULT_PROXY_PORT = 8080;

/** First filter-group number a managed per-UID group may use; group 1 is the permissive baseline. */
const FIRST_MANAGED_FILTER_GROUP = 2;

/** The destination ports redirected to e2guardian (plain HTTP + HTTPS). */
const DEFAULT_REDIRECT_PORTS = [80, 443] as const;

/** Cap on a recorded error summary, so a verbose Ansible failure can't bloat the audit row. */
const MAX_AUDIT_ERROR_CHARS = 1000;

/** A single supervised user's resolved filter group on a client. */
export const e2guardianUserFilterSchema = z.object({
  /** The user's local login name on the client (`users_on_clients.os_username`). */
  osUsername: z.string().min(1),
  /**
   * The user's OS account reference (`users_on_clients.os_user_ref`) — a uid on
   * Linux, a SID on Windows (#230). e2guardian/iptables filtering is Linux-only,
   * so on a managed client this is the numeric uid the iptables `--uid-owner`
   * match keys on.
   */
  osUserRef: z.string().min(1),
  /** e2guardian filter-group number (>= 2; group 1 is the permissive baseline). */
  filterGroup: z.number().int().min(FIRST_MANAGED_FILTER_GROUP),
  /** TCP port this user's filter group listens on; the iptables redirect target. */
  listenPort: z.number().int().min(1).max(65535),
  /** Domains denied for this user, deduplicated and sorted (always-on denies only). */
  bannedSites: z.array(z.string().min(1)),
});
export type E2guardianUserFilter = z.infer<typeof e2guardianUserFilterSchema>;

/**
 * The `--extra-vars` contract handed to the playbook: everything the client
 * needs to render the per-UID filter groups and the iptables redirect, with no
 * dashboard-side state assumed.
 */
export const e2guardianPlanSchema = z.object({
  /** Base e2guardian listen port (group 1 / permissive baseline). */
  proxyPort: z.number().int().min(1).max(65535),
  /** Destination ports redirected into e2guardian (typically `[80, 443]`). */
  redirectPorts: z.array(z.number().int().min(1).max(65535)).min(1),
  /** Per-supervised-user filter groups; empty ⇒ nothing managed on this client. */
  users: z.array(e2guardianUserFilterSchema),
});
export type E2guardianPlan = z.infer<typeof e2guardianPlanSchema>;

/** Options for {@link buildE2guardianPlan}. */
export interface BuildE2guardianPlanOptions {
  /** Override the base proxy port (default {@link DEFAULT_PROXY_PORT}). */
  proxyPort?: number;
  /** Override the redirected destination ports (default `[80, 443]`). */
  redirectPorts?: readonly number[];
}

/**
 * A schedule is *always-on* — i.e. it filters at all times, not on a recurring
 * window or a date range — when every reserved recurrence/date-scoping field is
 * null (the degenerate row, ADR 0005). Only always-on denies belong in the
 * static filter group; recurring "no YouTube during homework" windows are the
 * per-website time-window swap deferred to a #90 follow-up.
 */
function isAlwaysOn(rule: ScheduleRow): boolean {
  return (
    rule.recurrenceDays === null &&
    rule.recurrenceStartMinute === null &&
    rule.recurrenceEndMinute === null &&
    rule.effectiveFrom === null &&
    rule.effectiveTo === null
  );
}

/**
 * Collect the domains a single user always-on denies. A `deny` schedule that
 * targets a `domain` Activity contributes that activity's matcher; one that
 * targets a `group` contributes every `domain`-kind member's matcher.
 *
 * `domain_group` activities (named bundles the client expands) are intentionally
 * skipped here — resolving a named bundle to concrete domains is owned by the
 * richer-matcher work (#178/#195); this slice handles concrete `domain` matchers.
 */
function resolveBannedSites(db: PolicyDb, userId: number): string[] {
  const sites = new Set<string>();
  for (const rule of listUserSchedules(db, userId)) {
    if (rule.action !== "deny" || !isAlwaysOn(rule) || rule.targetId === null) continue;
    if (rule.targetKind === "activity") {
      const activity = getActivity(db, rule.targetId);
      if (activity?.kind === "domain") sites.add(activity.matcher);
    } else if (rule.targetKind === "group") {
      for (const activity of listGroupActivities(db, rule.targetId)) {
        if (activity.kind === "domain") sites.add(activity.matcher);
      }
    }
  }
  return [...sites].sort();
}

/**
 * Build the e2guardian filter plan for a client from the policy store.
 *
 * Every supervised user linked to the client that has at least one always-on
 * domain deny gets a managed filter group; users with nothing to block are
 * omitted entirely (their traffic stays on the permissive baseline, so we add
 * neither a group nor an iptables redirect for them). Group numbers and listen
 * ports are assigned deterministically in `listClientLinks` order (ascending
 * user id), so re-running against unchanged policy produces an identical plan —
 * the playbook is idempotent.
 *
 * Listen ports count up from `proxyPort + 1`. With the 8080 default there is
 * ample headroom, but a deployment overriding `proxyPort` near the top of the
 * range with many supervised users could push a `listenPort` past 65535, where
 * `e2guardianUserFilterSchema.parse` rejects the plan rather than emitting an
 * invalid port.
 */
export function buildE2guardianPlan(
  db: PolicyDb,
  clientId: number,
  options: BuildE2guardianPlanOptions = {},
): E2guardianPlan {
  const proxyPort = options.proxyPort ?? DEFAULT_PROXY_PORT;
  const redirectPorts = [...(options.redirectPorts ?? DEFAULT_REDIRECT_PORTS)];

  const users: E2guardianUserFilter[] = [];
  for (const link of listClientLinks(db, clientId)) {
    const bannedSites = resolveBannedSites(db, link.userId);
    if (bannedSites.length === 0) continue;
    const index = users.length;
    users.push({
      osUsername: link.osUsername,
      osUserRef: link.osUserRef,
      filterGroup: FIRST_MANAGED_FILTER_GROUP + index,
      listenPort: proxyPort + 1 + index,
      bannedSites,
    });
  }

  return e2guardianPlanSchema.parse({ proxyPort, redirectPorts, users });
}

/** Shape the plan into the nested `--extra-vars` object the playbook reads. */
function planToExtraVars(plan: E2guardianPlan): Record<string, ExtraVarValue> {
  return {
    e2guardian: {
      proxyPort: plan.proxyPort,
      redirectPorts: [...plan.redirectPorts],
      users: plan.users.map((user) => ({
        osUsername: user.osUsername,
        osUserRef: user.osUserRef,
        filterGroup: user.filterGroup,
        listenPort: user.listenPort,
        bannedSites: [...user.bannedSites],
      })),
    },
  };
}

/** Arguments for {@link pushE2guardianFiltering}. */
export interface PushE2guardianFilteringOptions {
  /** The Ansible runner facade. */
  runner: AnsibleRunner;
  /** The target client (hostname + ssh user); the run is `--limit`ed to it. */
  host: AnsibleHost;
  /** The plan to apply. */
  plan: E2guardianPlan;
  /** Enrolled client id, recorded on the audit entry when known. */
  clientId?: number | null;
  /** Optional audit sink; when supplied, one entry is recorded per run. */
  sink?: AuditSink;
  /** Audit actor (`system` default, `admin`, `integration:<name>`). */
  actor?: string;
  /** Optional short audit reason. */
  reason?: string | null;
  /** Injectable clock for the recorded duration (defaults to `Date.now`). */
  now?: () => number;
}

/**
 * Push a client's e2guardian filter plan via the Ansible runner, recording the
 * run in the audit log (if a sink is given). On success returns the run result;
 * on failure the original {@link AnsibleError} is rethrown after the audit entry
 * is recorded, so the caller can branch on the taxonomy (e.g. queue an
 * unreachable host for replay, #84).
 */
export async function pushE2guardianFiltering(
  options: PushE2guardianFilteringOptions,
): Promise<AnsibleRunResult> {
  const { runner, host, sink, clientId = null, actor, reason = null } = options;
  const now = options.now ?? Date.now;
  const plan = e2guardianPlanSchema.parse(options.plan);

  const command = redactArgv(["ansible-playbook", E2GUARDIAN_PLAYBOOK, "--limit", host.hostname]);
  // `AnsibleHost` carries no SSH port today (the runner uses the inventory
  // default, 22); revisit this literal if custom client SSH ports ever land.
  const target = { host: host.hostname, port: 22, username: host.sshUser };
  const startedAt = now();

  const record = (entry: Omit<AuditEntry, "target" | "command" | "context">): void => {
    sink?.record({
      ...entry,
      target,
      command,
      context: { clientId, ...(actor !== undefined ? { actor } : {}), reason },
    });
  };

  try {
    const result = await runner.runPlaybook({
      playbook: E2GUARDIAN_PLAYBOOK,
      hosts: [host],
      limit: host.hostname,
      extraVars: planToExtraVars(plan),
    });
    record({
      outcome: "ok",
      exitCode: result.exitCode,
      signal: null,
      durationMs: now() - startedAt,
      errorMessage: null,
    });
    return result;
  } catch (error) {
    record({
      outcome: error instanceof AnsibleUnreachableError ? "unreachable" : "failed",
      exitCode: exitCodeOf(error),
      signal: null,
      durationMs: now() - startedAt,
      errorMessage: summariseError(error),
    });
    throw error;
  }
}

/** The numeric exit code an Ansible error carries, or `null` (spawn failure / signal). */
function exitCodeOf(error: unknown): number | null {
  if (error instanceof AnsibleUnreachableError) return error.exitCode;
  if (error instanceof AnsiblePlaybookFailedError) return error.exitCode;
  return null;
}

/** A bounded, single-line error summary for the audit row. */
function summariseError(error: unknown): string {
  const message =
    error instanceof AnsibleError || error instanceof Error ? error.message : String(error);
  return message.length > MAX_AUDIT_ERROR_CHARS
    ? `${message.slice(0, MAX_AUDIT_ERROR_CHARS)}…`
    : message;
}
