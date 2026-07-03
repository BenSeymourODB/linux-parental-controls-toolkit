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

import { getActivity, listClientLinks, listGroupActivities } from "../../policy/repository.js";
import type { PolicyDb } from "../../policy/db.js";
import { gatherUserScheduleRules } from "../../policy/group-resolution.js";
import { MINUTES_PER_DAY } from "../../policy/recurrence.js";
import type { ScheduleRule } from "../../policy/schedule-precedence.js";
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

/**
 * A recurring time-window deny for a single supervised user (#216). e2guardian
 * evaluates the window itself via a `#time:` tag on the `.Include`d list, so the
 * window is *declarative config*, not a client-side timer or a scheduled re-push
 * (the mechanism decision recorded in `docs/architecture.md` → "Enforcement
 * responsibilities").
 */
export const e2guardianWindowSchema = z.object({
  /**
   * The e2guardian `#time:` body — `"<sh> <sm> <eh> <em> <days>"`, days as cron
   * digits (0=Sunday … 6=Saturday). Preformatted server-side by
   * {@link e2guardianTimeTag} so the grammar is unit-tested and the playbook
   * template stays dumb. e.g. `"16 0 18 0 12345"` (weekdays 16:00–18:00).
   */
  timeTag: z.string().min(1),
  /** Domains denied during this window, deduplicated and sorted; never empty. */
  sites: z.array(z.string().min(1)).min(1),
});
export type E2guardianWindow = z.infer<typeof e2guardianWindowSchema>;

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
  /**
   * Recurring time-window denies (#216), each grouped by its `#time:` tag so one
   * window list serves all its domains. Empty ⇒ the user has only always-on
   * denies (or, combined with an empty `bannedSites`, would not be in the plan).
   */
  windows: z.array(e2guardianWindowSchema),
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
 * static filter group; recurring "no YouTube during homework" windows are
 * handled separately via {@link resolveWindowedDenies} (#216).
 */
function isAlwaysOn(rule: ScheduleRule): boolean {
  return (
    rule.recurrenceDays === null &&
    rule.recurrenceStartMinute === null &&
    rule.recurrenceEndMinute === null &&
    rule.effectiveFrom === null &&
    rule.effectiveTo === null
  );
}

/**
 * A schedule is a *recurring window* (#216) when it carries at least one
 * recurrence field (weekday mask and/or intra-day window) **and** is not
 * date-scoped (`effective_from`/`effective_to` both null). e2guardian's `#time:`
 * grammar expresses weekday + time-of-day but not calendar date ranges, so
 * date-scoped denies are deliberately excluded and ride with the date-scoped
 * resolver work (#142).
 */
function isRecurringWindow(rule: ScheduleRule): boolean {
  if (rule.effectiveFrom !== null || rule.effectiveTo !== null) return false;
  return (
    rule.recurrenceDays !== null ||
    rule.recurrenceStartMinute !== null ||
    rule.recurrenceEndMinute !== null
  );
}

/**
 * Map a 7-bit ISO weekday mask (bit 0 = Monday … bit 6 = Sunday, ADR 0005) to
 * e2guardian's cron-style day digits (0 = Sunday … 6 = Saturday), sorted
 * ascending. A `null` mask means "no weekday restriction" ⇒ every day
 * (`"0123456"`).
 */
function maskToE2guardianDays(mask: number | null): string {
  if (mask === null) return "0123456";
  const digits: number[] = [];
  for (let bit = 0; bit < 7; bit += 1) {
    if ((mask & (1 << bit)) !== 0) {
      const isoWeekday = bit + 1; // 1 = Monday … 7 = Sunday
      digits.push(isoWeekday % 7); // Monday=1 … Saturday=6, Sunday=0
    }
  }
  return digits.sort((a, b) => a - b).join("");
}

/** Format minutes-from-midnight as the e2guardian `"<hour> <minute>"` pair. */
function minuteToHourMinute(minute: number): string {
  return `${Math.floor(minute / 60)} ${minute % 60}`;
}

/**
 * Format a recurring window as an e2guardian `#time:` body:
 * `"<start_hour> <start_min> <end_hour> <end_min> <days>"`.
 *
 * A `null` minute pair means the deny applies all day (`0 0 24 0`); a `null`
 * weekday mask means every day (`0123456`). The end-of-day sentinel `1440`
 * (ADR 0005) formats to the idiomatic e2guardian `24 0`. At least one field is
 * non-null for any rule that reaches here — an always-on rule is filtered out by
 * {@link isRecurringWindow} first.
 */
export function e2guardianTimeTag(
  recurrenceDays: number | null,
  startMinute: number | null,
  endMinute: number | null,
): string {
  const start = minuteToHourMinute(startMinute ?? 0);
  const end = minuteToHourMinute(endMinute ?? MINUTES_PER_DAY);
  return `${start} ${end} ${maskToE2guardianDays(recurrenceDays)}`;
}

/**
 * Expand one `deny` schedule to the concrete domains it bans. A rule targeting a
 * `domain` Activity contributes that activity's matcher; one targeting a `group`
 * contributes every `domain`-kind member's matcher.
 *
 * `domain_group` activities (named bundles the client expands) are intentionally
 * skipped — resolving a named bundle to concrete domains is owned by the
 * richer-matcher work (#178/#195); this handles concrete `domain` matchers only.
 *
 * The rule comes from {@link gatherUserScheduleRules}, so both the user's own and
 * inherited group denies flow through here (#362) — a group-targeted domain block
 * reaches e2guardian, and a group *recurring* deny reaches the windowed lists.
 */
function domainsForRule(db: PolicyDb, rule: ScheduleRule): string[] {
  if (rule.targetId === null) return [];
  const domains: string[] = [];
  if (rule.targetKind === "activity") {
    const activity = getActivity(db, rule.targetId);
    if (activity?.kind === "domain") domains.push(activity.matcher);
  } else if (rule.targetKind === "group") {
    for (const activity of listGroupActivities(db, rule.targetId)) {
      if (activity.kind === "domain") domains.push(activity.matcher);
    }
  }
  return domains;
}

/**
 * Collect the domains a single user *always-on* denies, deduplicated and sorted.
 * Reads the user's effective schedules — own rules plus inherited group denies
 * (#362) — via {@link gatherUserScheduleRules}.
 */
function resolveBannedSites(db: PolicyDb, userId: number): string[] {
  const sites = new Set<string>();
  for (const rule of gatherUserScheduleRules(db, userId)) {
    if (rule.action !== "deny" || !isAlwaysOn(rule)) continue;
    for (const domain of domainsForRule(db, rule)) sites.add(domain);
  }
  return [...sites].sort();
}

/**
 * Collect a single user's recurring time-window domain denies (#216), grouped by
 * their e2guardian `#time:` tag so denies sharing an identical window collapse to
 * one list. Sites within a window are deduplicated and sorted; windows are sorted
 * by tag — so re-running against unchanged policy yields an identical plan and
 * the playbook stays idempotent. Reads effective schedules via
 * {@link gatherUserScheduleRules}, so inherited group recurring denies are
 * honoured too (the recurring half of #362's group-deny deferral).
 */
function resolveWindowedDenies(db: PolicyDb, userId: number): E2guardianWindow[] {
  const sitesByTag = new Map<string, Set<string>>();
  for (const rule of gatherUserScheduleRules(db, userId)) {
    if (rule.action !== "deny" || !isRecurringWindow(rule)) continue;
    const domains = domainsForRule(db, rule);
    if (domains.length === 0) continue;
    const tag = e2guardianTimeTag(
      rule.recurrenceDays,
      rule.recurrenceStartMinute,
      rule.recurrenceEndMinute,
    );
    const sites = sitesByTag.get(tag) ?? new Set<string>();
    for (const domain of domains) sites.add(domain);
    sitesByTag.set(tag, sites);
  }
  return [...sitesByTag.entries()]
    .map(([timeTag, sites]) => ({ timeTag, sites: [...sites].sort() }))
    .sort((a, b) => (a.timeTag < b.timeTag ? -1 : a.timeTag > b.timeTag ? 1 : 0));
}

/**
 * Build the e2guardian filter plan for a client from the policy store.
 *
 * Every supervised user linked to the client that has at least one always-on
 * domain deny **or** a recurring window deny (#216) gets a managed filter group;
 * users with nothing to block are omitted entirely (their traffic stays on the
 * permissive baseline, so we add neither a group nor an iptables redirect for
 * them). A windowed-only user still gets a group + redirect: outside the window
 * their list is inactive, so nothing is blocked — which is the intended
 * behaviour. Group numbers and listen ports are assigned deterministically in
 * `listClientLinks` order (ascending user id), so re-running against unchanged
 * policy produces an identical plan — the playbook is idempotent.
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
    const windows = resolveWindowedDenies(db, link.userId);
    if (bannedSites.length === 0 && windows.length === 0) continue;
    const index = users.length;
    users.push({
      osUsername: link.osUsername,
      osUserRef: link.osUserRef,
      filterGroup: FIRST_MANAGED_FILTER_GROUP + index,
      listenPort: proxyPort + 1 + index,
      bannedSites,
      windows,
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
        windows: user.windows.map((window) => ({
          timeTag: window.timeTag,
          sites: [...window.sites],
        })),
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
