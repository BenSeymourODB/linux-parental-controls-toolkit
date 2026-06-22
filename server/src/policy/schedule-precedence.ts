/**
 * Shared schedule-precedence helper — the one place "which rule is in effect
 * right now?" is decided.
 *
 * A user's {@link import("./schema.js").schedules} rows are an **ordered**
 * list: they are evaluated ascending by `ordinal` and the **first** rule
 * whose window is active wins (`allow` / `deny` / `extend`). That rule
 * determines what the policy says for the matched target at a given instant.
 * The decision (first-match-wins over most-specific-wins) and its rationale
 * are recorded in `docs/adr/0004-schedule-precedence.md`.
 *
 * Every surface that needs to display or enforce "what's allowed now" — the
 * admin editor, the `/app` PWA child-status view, the future enforcement
 * decision logic — goes through this module so the precedence is applied
 * identically and the stored `ordinal` order is the single source of truth.
 *
 * **What this module deliberately does not know:** how to decide whether a
 * given rule's recurrence window (ADR 0005) is active at an instant. That
 * resolver (#143) is a separate concern; callers inject it as an
 * {@link RuleActivePredicate}. Keeping it out keeps this module pure,
 * dependency-free, and grammar-agnostic — exactly like `budget-window.ts`
 * abstracts the timezone source from the windowing math.
 */
import type { Scope, ScheduleAction } from "./enums.js";

/**
 * A schedule rule as it participates in precedence resolution — the subset of
 * the {@link import("./schema.js").schedules} row this module reasons about.
 * Read straight from the policy store (or built in a test); intentionally
 * structural so callers are not coupled to the Drizzle row type.
 */
export interface ScheduleRule {
  /** Stable identity, used as the deterministic tiebreak for equal ordinals. */
  readonly id: number;
  /** Evaluation position; lower wins. May tie (see {@link byOrdinal}). */
  readonly ordinal: number;
  /** What the rule applies to — `overall`, a single `activity`, or a `group`. */
  readonly targetKind: Scope;
  /** The activity/group id when scoped; `null` for `overall`. */
  readonly targetId: number | null;
  /**
   * The reserved recurrence + date-scoping window (ADR 0005, #146): a 7-bit
   * ISO-weekday mask, an intra-day `[start, end)` minute pair, and an effective
   * date range. All `null` is the always-on degenerate. Whether the window is
   * *active at an instant* is opaque to this module (see file header); these
   * fields feed only the structural shadow heuristic in {@link findShadowedRules}.
   */
  readonly recurrenceDays: number | null;
  readonly recurrenceStartMinute: number | null;
  readonly recurrenceEndMinute: number | null;
  readonly effectiveFrom: Date | null;
  readonly effectiveTo: Date | null;
  /** What the rule does in its window when it wins. */
  readonly action: ScheduleAction;
}

/**
 * Decides whether `rule`'s window is active for the instant/context the
 * caller cares about. Supplied by the caller because the recurrence grammar
 * (ADR 0005) lives outside this module (see file header).
 */
export type RuleActivePredicate = (rule: ScheduleRule) => boolean;

/**
 * Rules sorted into evaluation order: ascending `ordinal`, then ascending
 * `id` as a deterministic tiebreak so two rules sharing an ordinal still have
 * a stable, reproducible precedence. Returns a new array; the input is not
 * mutated.
 */
export function byOrdinal<T extends ScheduleRule>(rules: readonly T[]): T[] {
  return [...rules].sort((a, b) => a.ordinal - b.ordinal || a.id - b.id);
}

/**
 * The rule in effect: the first one (in {@link byOrdinal} order) whose window
 * is active per `isActive`. Returns `undefined` when no rule is active — the
 * caller decides what "no rule applies" means for its surface (typically a
 * baseline allow), rather than this module baking in a default action.
 */
export function resolveEffectiveRule<T extends ScheduleRule>(
  rules: readonly T[],
  isActive: RuleActivePredicate,
): T | undefined {
  return byOrdinal(rules).find((rule) => isActive(rule));
}

/**
 * Convenience over {@link resolveEffectiveRule}: the winning rule's action,
 * or `fallback` when no rule is active.
 */
export function resolveEffectiveAction(
  rules: readonly ScheduleRule[],
  isActive: RuleActivePredicate,
  fallback: ScheduleAction,
): ScheduleAction {
  return resolveEffectiveRule(rules, isActive)?.action ?? fallback;
}

/**
 * The ordinal to give a newly appended rule so it sorts last: `max + 1`, or
 * `0` when empty. Never returns negative — a set of only-negative ordinals
 * (not produced by {@link reorder}, which densifies to `0..n-1`) still yields
 * `0`, which sorts after them.
 */
export function nextOrdinal(rules: readonly ScheduleRule[]): number {
  return rules.reduce((max, rule) => Math.max(max, rule.ordinal + 1), 0);
}

/** Thrown by {@link reorder} when `orderedIds` is not a permutation of the rules' ids. */
export class ReorderMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReorderMismatchError";
  }
}

/**
 * Reassign dense `0..n-1` ordinals to match a caller-supplied id order — the
 * persistence step behind a drag-to-reorder save. `orderedIds` must be a
 * permutation of exactly the rules' ids (no missing, extra, or duplicate id),
 * else {@link ReorderMismatchError} is thrown so a stale or malformed reorder
 * request can never silently drop or duplicate a rule's position.
 *
 * Returns new rule objects (same fields, updated `ordinal`) in the new order;
 * the input array and its elements are not mutated.
 */
export function reorder(
  rules: readonly ScheduleRule[],
  orderedIds: readonly number[],
): ScheduleRule[] {
  if (orderedIds.length !== rules.length) {
    throw new ReorderMismatchError(`expected ${rules.length} ids, got ${orderedIds.length}`);
  }
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const seen = new Set<number>();
  return orderedIds.map((id, index) => {
    const rule = byId.get(id);
    if (rule === undefined) {
      throw new ReorderMismatchError(`id ${id} is not among the rules being reordered`);
    }
    if (seen.has(id)) {
      throw new ReorderMismatchError(`id ${id} appears more than once in the new order`);
    }
    seen.add(id);
    return { ...rule, ordinal: index };
  });
}

/** A later rule that an earlier rule makes unreachable. */
export interface ShadowFinding {
  /** The rule that can never win. */
  readonly shadowedId: number;
  /** The earlier rule that always pre-empts it. */
  readonly shadowedById: number;
}

/**
 * Does an active `earlier` rule always pre-empt `later` for `later`'s target?
 *
 * True when `earlier` applies to a superset of `later`'s target: `overall`
 * covers everything, and an identical `target_kind`+`target_id` covers
 * itself. Group membership (a `group` rule covering an `activity` in it) is
 * **not** resolved here — that needs the activities-to-groups data this pure
 * module does not take — so such cases are conservatively treated as
 * non-shadowing rather than guessed.
 */
function targetSupersetOf(earlier: ScheduleRule, later: ScheduleRule): boolean {
  if (earlier.targetKind === "overall") return true;
  return earlier.targetKind === later.targetKind && earlier.targetId === later.targetId;
}

/** Equal instants (or both absent) — the date-scoping half of {@link sameWindow}. */
function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/**
 * Do two rules carry the **provably identical** recurrence + date-scoping
 * window (ADR 0005)? Used by the conservative shadow heuristic: when an earlier
 * rule's window matches a later one's field-for-field, the earlier rule is
 * active in exactly the same instants and wins every time. This is the
 * structured successor to the old free-text `cron_or_window` string equality —
 * same conservatism, no understanding of the grammar (a broader window
 * subsuming a narrower one is still left to the resolver, #143).
 */
function sameWindow(a: ScheduleRule, b: ScheduleRule): boolean {
  return (
    a.recurrenceDays === b.recurrenceDays &&
    a.recurrenceStartMinute === b.recurrenceStartMinute &&
    a.recurrenceEndMinute === b.recurrenceEndMinute &&
    sameInstant(a.effectiveFrom, b.effectiveFrom) &&
    sameInstant(a.effectiveTo, b.effectiveTo)
  );
}

/**
 * Rules that can never fire because an earlier rule shadows them — the input
 * to the editor's "this rule will never apply" warning.
 *
 * **Conservative by design:** a later rule is flagged only when an earlier
 * rule (a) covers its target (see {@link targetSupersetOf}) **and** (b) has an
 * **identical** recurrence window (see {@link sameWindow}), so the earlier rule
 * is provably active in exactly the windows the later one is and wins every
 * time. This never produces a false positive. It does miss shadowing that needs
 * understanding the recurrence grammar (e.g. a broader window subsuming a
 * narrower one, or group membership) — that analysis belongs with the resolver
 * (#143) and is intentionally out of scope here; see the file header. Each
 * later rule is reported at most once, against the first (highest-precedence)
 * rule that shadows it.
 */
export function findShadowedRules(rules: readonly ScheduleRule[]): ShadowFinding[] {
  const ordered = byOrdinal(rules);
  const findings: ShadowFinding[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const later = ordered[i];
    if (later === undefined) continue;
    for (let j = 0; j < i; j++) {
      const earlier = ordered[j];
      if (earlier === undefined) continue;
      if (sameWindow(earlier, later) && targetSupersetOf(earlier, later)) {
        findings.push({ shadowedId: later.id, shadowedById: earlier.id });
        break;
      }
    }
  }
  return findings;
}

/**
 * The ids of the rules in effect **right now** — the input to the editor's "in
 * effect now" badge. For each distinct target the rules address, the winner is
 * the first active rule (by {@link byOrdinal}) among the rules that *cover* that
 * target, using the same coverage relation as {@link findShadowedRules}: an
 * `overall` rule covers every target, and an identical `target_kind`+`target_id`
 * covers itself. Resolving coverage the same way is what keeps the two views
 * consistent — a rule a broader rule shadows can never appear here, because that
 * broader rule wins for its target too. Group membership is **not** resolved
 * (see {@link findShadowedRules}).
 *
 * `isActive` decides whether a rule's window is active at the caller's instant
 * (see {@link RuleActivePredicate}); a target whose covering rules are all
 * inactive contributes no id. Each id appears at most once.
 */
export function effectiveRuleIds(
  rules: readonly ScheduleRule[],
  isActive: RuleActivePredicate,
): number[] {
  const ordered = byOrdinal(rules);
  const winners = new Set<number>();
  const seenTargets = new Set<string>();
  for (const rule of ordered) {
    const key = `${rule.targetKind}:${rule.targetId ?? "overall"}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    const covering = ordered.filter((candidate) => targetSupersetOf(candidate, rule));
    const winner = resolveEffectiveRule(covering, isActive);
    if (winner !== undefined) winners.add(winner.id);
  }
  return [...winners];
}
