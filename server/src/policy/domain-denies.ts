/**
 * Shared resolution of a supervised user's **always-on `domain` denies** — the
 * concrete domains a user is blocked from at all times, drawn from the policy
 * store.
 *
 * This is a policy-layer concern, not a transport one: both web-filter
 * enforcement mechanisms consume it — e2guardian per-UID filtering
 * (`transport/ansible/e2guardian.ts`, Phase 6) and AdGuard per-device DNS
 * filtering (`transport/adguard/blocklist.ts`, Phase 7, ADR 0015). Keeping the
 * derivation here means the two mechanisms can never disagree about *which*
 * domains a user always-on denies.
 *
 * "Always-on" means the degenerate schedule row (ADR 0005): every reserved
 * recurrence/date-scoping field is null, so the deny applies at all times rather
 * than on a recurring window or a calendar range. Recurring/date-scoped denies
 * are handled per-mechanism (e2guardian's `#time:` windows, #216) and are
 * deliberately out of scope here.
 */
import { gatherUserScheduleRules } from "./group-resolution.js";
import { getActivity, listGroupActivities } from "./repository.js";
import type { PolicyDb } from "./db.js";
import type { ScheduleRule } from "./schedule-precedence.js";

/**
 * A schedule is *always-on* when every reserved recurrence/date-scoping field is
 * null (the degenerate row, ADR 0005) — it filters at all times, not on a
 * recurring window or a date range.
 */
export function isAlwaysOnRule(rule: ScheduleRule): boolean {
  return (
    rule.recurrenceDays === null &&
    rule.recurrenceStartMinute === null &&
    rule.recurrenceEndMinute === null &&
    rule.effectiveFrom === null &&
    rule.effectiveTo === null
  );
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
 * Rules are expected to come from {@link gatherUserScheduleRules}, so both a
 * user's own and inherited group denies flow through here (#362).
 */
export function domainsForDenyRule(db: PolicyDb, rule: ScheduleRule): string[] {
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
 * (#362) — via {@link gatherUserScheduleRules}. The stable (sorted) output makes
 * downstream plans deterministic and their pushes idempotent.
 */
export function resolveAlwaysOnDomainDenies(db: PolicyDb, userId: number): string[] {
  const sites = new Set<string>();
  for (const rule of gatherUserScheduleRules(db, userId)) {
    if (rule.action !== "deny" || !isAlwaysOnRule(rule)) continue;
    for (const domain of domainsForDenyRule(db, rule)) sites.add(domain);
  }
  return [...sites].sort();
}
