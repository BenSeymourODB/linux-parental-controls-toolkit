/**
 * Effective-policy resolution engine (#143, Phase 4).
 *
 * The single "what applies for user *U* on day *D*?" computation. Given a
 * user's schedule rules, budgets, and active grants — and any local calendar
 * date, today or future — it composes them into the concrete picture for that
 * day: the allowed-access windows, the effective overall and per-activity
 * quotas, and the schedule rules in play. Every downstream surface reads this
 * one resolver rather than re-deriving the rules:
 *
 * - the Phase-4 `timekpra` allowed-hours / daily-limit push (#140),
 * - the Phase-8 per-activity enforcement decision logic (#98/#99),
 * - the Phase-5 burndown views (#62),
 * - the save-and-push "preview diff" (#64), including future-dated changes.
 *
 * **Two layers, deliberately separate.** This module owns the recurrence +
 * date-scoping grammar (the "is this rule active at instant *T*?" predicate
 * that {@link import("./schedule-precedence.js")} left injectable, per ADR
 * 0004); precedence (first-match-wins by `ordinal`) stays in that module. The
 * two compose without either re-implementing the other — see
 * `docs/adr/0005-recurrence-and-date-scoping.md` → "How this composes with
 * ADR 0004", which fixes the exact predicate this implements.
 *
 * **Timezone.** All weekday / minute-of-day / date-gate evaluation happens in
 * the user's effective timezone, via {@link import("./budget-window.js")}
 * (ADR 0001) — local time enters only here, storage stays UTC.
 *
 * **Scope of this slice.** Recurring windows + budgets (uniform *and*
 * weekday-varying) + active grants + date-specific overrides. Two orthogonal
 * additive layers compose here, on independent axes that never interact:
 *
 * - **Date-specific overrides** — the optional `exceptions` layer (#142,
 *   `docs/adr/0012-date-specific-override-composition.md`): an active one-off
 *   `allow`/`deny`/`extend` override wins over the recurring rules for the
 *   target it covers, and `extend` widens the allowed window past a standing
 *   deny. Exceptions affect only the per-day allow/deny/extend **access
 *   windows**, never the seconds budgets (an additive time amount is a `Grant`,
 *   not an exception).
 * - **Weekday-varying budgets** — the `recurrence_days` layer (#141,
 *   `docs/adr/0013-weekday-varying-budgets.md`): {@link selectBudgetsForWeekday}
 *   is a within-slot day layer beneath the ADR-0008 group precedence (which
 *   stays in {@link import("./group-resolution.js")}), resolving the **seconds**
 *   budget for the day. It touches only budgets, so it composes with the
 *   exception layer without either coding against the other.
 *
 * License boundary: none touched — pure TypeScript over the policy model.
 */
import {
  isoWeekday,
  localDayBounds,
  localTimeOfDayMinutes,
  localCalendarDate,
} from "./budget-window.js";
import type { BudgetWindow, Scope, ScheduleAction } from "./enums.js";
import { MINUTES_PER_DAY } from "./recurrence.js";
import { byOrdinal, type RuleActivePredicate, type ScheduleRule } from "./schedule-precedence.js";

/** Milliseconds in one minute — for projecting a UTC instant onto local minutes-of-day. */
const MS_PER_MINUTE = 60_000;

/**
 * The subset of a {@link import("./schema.js").budgets} row the resolver reads.
 * Structural so callers pass either a Drizzle row or a test fixture.
 */
export interface BudgetInput {
  readonly scope: Scope;
  readonly targetId: number | null;
  readonly window: BudgetWindow;
  readonly secondsAllowed: number;
  /**
   * Weekday-varying budgets (#141, ADR 0013): a 7-bit ISO-weekday mask (bit 0 =
   * Monday … bit 6 = Sunday) restricting the day(s) this `daily` allowance
   * applies to. `null`/absent = uniform (every day), the degenerate default
   * that reproduces pre-#141 behaviour. Resolved per slot by
   * {@link selectBudgetsForWeekday}.
   */
  readonly recurrenceDays?: number | null;
}

/**
 * The subset of a {@link import("./schema.js").grants} row the resolver reads.
 * A grant is **additive** on top of the policy baseline (architecture →
 * "Policy model": `per-day budget = policy + Σ(active grants)`).
 */
export interface GrantInput {
  readonly scope: Scope;
  readonly targetId: number | null;
  readonly secondsGranted: number;
  /** When the grant became live. */
  readonly grantedAt: Date;
  /** Exclusive end of the grant's life. */
  readonly expiresAt: Date;
  /** Revocation instant; `null` for a live grant (revoking never edits in place). */
  readonly revokedAt: Date | null;
}

/**
 * The subset of an {@link import("./schema.js").exceptions} row (or a group
 * exception, or a test fixture) the resolver reads. A one-off, date-anchored
 * override active during `[effective_from ?? created_at, expires_at)` (ADR 0005
 * §2). Structural so callers pass a user row, a group row, or a fixture.
 *
 * An exception carries an access `action`, not a seconds amount — it composes
 * into the allow/deny/extend windows, never the budgets (ADR 0012 §1).
 */
export interface ExceptionInput {
  /** Stable identity, used as the newest-first tiebreak within the exception layer. */
  readonly id: number;
  readonly targetKind: Scope;
  readonly targetId: number | null;
  readonly action: ScheduleAction;
  /** Active-window start; `null` ⇒ active from {@link createdAt}. */
  readonly effectiveFrom: Date | null;
  /** Exclusive active-window end (the exception's `expires_at`). */
  readonly expiresAt: Date;
  /** Row creation instant — the active-window start when {@link effectiveFrom} is `null`. */
  readonly createdAt: Date;
}

/** A half-open allowed-access interval in local minutes-from-midnight `[start, end)`. */
export interface AllowedWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * A schedule rule that is a candidate on the resolved day, with its window
 * already projected onto that day's local-minute space. `startMinute`/
 * `endMinute` default to the full day for an all-day (no intra-day) rule.
 */
export interface ActiveRule {
  readonly id: number;
  readonly targetKind: Scope;
  readonly targetId: number | null;
  readonly action: ScheduleAction;
  readonly startMinute: number;
  readonly endMinute: number;
}

/** An effective per-activity / per-group quota for the day, in seconds. */
export interface ActivityQuota {
  readonly scope: Extract<Scope, "activity" | "group">;
  readonly targetId: number;
  readonly seconds: number;
}

/** The composed answer to "what applies for user *U* on day *D*?". */
export interface EffectivePolicy {
  /** The resolved local calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  /** The effective timezone the resolution was computed in. */
  readonly tz: string;
  /**
   * Allowed overall-access windows for the day, in local minutes, ascending
   * and non-overlapping. Derived from `overall`-scoped schedule rules with
   * baseline-allow; `deny` carves gaps out. Empty means access is denied all
   * day; a single `{ 0, 1440 }` means unrestricted.
   */
  readonly allowedWindows: AllowedWindow[];
  /**
   * Effective overall daily allowance in seconds (baseline + active overall
   * grants), or `null` when no daily overall budget is defined (no daily
   * limit — a grant on an unlimited base is moot).
   */
  readonly overallSeconds: number | null;
  /** Effective per-activity / per-group daily allowances, ascending by target. */
  readonly perActivitySeconds: ActivityQuota[];
  /**
   * Every **schedule** rule in play on the day (all scopes), in precedence order
   * (`ordinal`, then `id`). Lets a preview surface render inherited/competing
   * rules, not just the resolved `overall` windows. Date-specific exceptions are
   * composed into {@link allowedWindows} but deliberately not listed here yet —
   * surfacing their provenance in this list is #343.
   */
  readonly activeRules: ActiveRule[];
}

/** Inputs to {@link effectivePolicy}; all rows already loaded for the user. */
export interface EffectivePolicyInput {
  /** Target local calendar date (month 1-12), in the effective timezone. */
  readonly date: { year: number; month: number; day: number };
  /** The user's effective timezone (`User.tz ?? PCT_DEFAULT_TZ`). */
  readonly tz: string;
  readonly schedules: readonly ScheduleRule[];
  readonly budgets: readonly BudgetInput[];
  readonly grants: readonly GrantInput[];
  /**
   * Date-specific overrides (#142), **in precedence order** (index 0 = highest;
   * `gatherUserExceptions` yields own-before-group, newest-before-older). Each
   * active exception composes as a top-precedence, whole-day rule above the
   * recurring `schedules` (ADR 0012). Optional — the recurring `timekpra` push
   * and the force-close sweep legitimately omit it (a one-off date is not a
   * recurring grid entry, and exceptions carry no quota), so it defaults to `[]`.
   */
  readonly exceptions?: readonly ExceptionInput[];
}

/** Is `rule`'s recurrence the always-on degenerate (every recurrence field NULL)? */
function isAlwaysOn(rule: ScheduleRule): boolean {
  return (
    rule.recurrenceDays === null &&
    rule.recurrenceStartMinute === null &&
    rule.recurrenceEndMinute === null
  );
}

/**
 * The **date gate** alone (ADR 0005): does instant `at` fall inside the rule's
 * `[effective_from, effective_to)` calendar range, with either bound open?
 *
 * The bounds are stored as instants fixed at local-day boundaries (ADR 0005),
 * so this is a pure instant comparison — timezone-independent. Split out from
 * {@link isRuleActiveAt} so a caller that must apply *only* the date gate — and
 * evaluate the recurrence part elsewhere — shares the exact same semantics.
 * e2guardian date-scoped denies (#385) are the motivating case: the daemon
 * evaluates the recurrence window itself via its native `#time:` tag, so the
 * renderer needs the calendar-range gate without the recurrence gate.
 */
export function withinEffectiveDateRange(rule: ScheduleRule, at: Date): boolean {
  const t = at.getTime();
  if (rule.effectiveFrom !== null && t < rule.effectiveFrom.getTime()) return false;
  if (rule.effectiveTo !== null && t >= rule.effectiveTo.getTime()) return false;
  return true;
}

/**
 * Is `rule` active at instant `T` in `tz`? Implements the predicate ADR 0005
 * defines (the one {@link import("./schedule-precedence.js")} leaves
 * injectable): the **date gate** (`effective_from ≤ T < effective_to`, either
 * bound open) **and** the **recurrence gate** (always-on, or the local ISO
 * weekday is in `recurrence_days` *and* the local minute-of-day is in
 * `[start, end)`).
 *
 * Exact to the instant — this is what enforcement and a "right now" indicator
 * call. The day-window builder in {@link effectivePolicy} uses the same gates
 * but at day granularity for the recurrence window it projects.
 */
export function isRuleActiveAt(rule: ScheduleRule, at: Date, tz: string): boolean {
  // Date gate: [effective_from, effective_to), either bound open.
  if (!withinEffectiveDateRange(rule, at)) return false;

  if (isAlwaysOn(rule)) return true;

  // Recurrence gate, evaluated in the user's effective TZ.
  if (rule.recurrenceDays !== null) {
    const { year, month, day } = localCalendarDate(at, tz);
    const weekdayBit = 1 << (isoWeekday(year, month, day) - 1);
    if ((rule.recurrenceDays & weekdayBit) === 0) return false;
  }

  if (rule.recurrenceStartMinute !== null && rule.recurrenceEndMinute !== null) {
    const minute = localTimeOfDayMinutes(at, tz);
    if (minute < rule.recurrenceStartMinute || minute >= rule.recurrenceEndMinute) return false;
  }

  return true;
}

/**
 * A {@link RuleActivePredicate} bound to an instant and timezone, so a caller
 * can resolve "which rule is in effect right now?" by composing this resolver's
 * grammar with `schedule-precedence`'s first-match-wins:
 *
 * ```ts
 * resolveEffectiveAction(rules, ruleActiveAt(new Date(), tz), "allow");
 * ```
 */
export function ruleActiveAt(at: Date, tz: string): RuleActivePredicate {
  return (rule) => isRuleActiveAt(rule, at, tz);
}

/** Zero-pad a positive integer to two digits for `YYYY-MM-DD` formatting. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Does `rule`'s recurrence apply on the local day with ISO weekday `weekday`,
 * and does its date gate overlap the day's `[dayStart, dayEnd)` UTC bounds?
 *
 * The date gate is applied at **day granularity** here (candidate iff the
 * effective window overlaps the day): ADR 0005 fixes `effective_from`/`_to` at
 * local-day boundaries, so for every in-contract input this is exact. The
 * instant-exact gate lives in {@link isRuleActiveAt} for "right now" callers.
 */
function appliesOnDay(rule: ScheduleRule, weekday: number, dayStart: Date, dayEnd: Date): boolean {
  if (rule.effectiveFrom !== null && rule.effectiveFrom.getTime() >= dayEnd.getTime()) return false;
  if (rule.effectiveTo !== null && rule.effectiveTo.getTime() <= dayStart.getTime()) return false;
  if (rule.recurrenceDays !== null && (rule.recurrenceDays & (1 << (weekday - 1))) === 0) {
    return false;
  }
  return true;
}

/** The local-minute `[start, end)` window `rule` occupies on a day it applies. */
function ruleWindow(rule: ScheduleRule): { start: number; end: number } {
  return {
    start: rule.recurrenceStartMinute ?? 0,
    end: rule.recurrenceEndMinute ?? MINUTES_PER_DAY,
  };
}

/**
 * Sort `windows` by start and merge every overlapping or abutting pair into the
 * minimal set of maximal, ascending, non-overlapping intervals. Empty and
 * inverted (`start >= end`) inputs are dropped.
 */
function mergeWindows(windows: readonly AllowedWindow[]): AllowedWindow[] {
  const sorted = windows.filter((w) => w.start < w.end).sort((a, b) => a.start - b.start);
  const merged: AllowedWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && window.start <= last.end) {
      // Overlaps or abuts the current run — extend it (never shrink).
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, window.end) };
    } else {
      merged.push({ start: window.start, end: window.end });
    }
  }
  return merged;
}

/**
 * Resolve the day's allowed overall-access windows from the `overall`-scoped
 * candidate rules, in precedence order (highest first — active exceptions are
 * already prepended by {@link effectivePolicy}, ADR 0012 §1).
 *
 * Two composition steps:
 *
 * 1. **allow/deny first-match** — walk the minute timeline at every rule
 *    boundary; within each segment the first rule whose window covers it wins,
 *    and the segment is allowed unless that winner is `deny`. With no winner the
 *    baseline is allow (ADR 0004). (`extend` participates here as a permit, so
 *    it still wins its own segment exactly as before.)
 * 2. **`extend` union** (ADR 0012 §2) — every active `extend` window is then
 *    unioned onto the allowed set, so an `extend` widens access even past a
 *    higher-precedence overlapping `deny`. This only ever *adds* allowed time.
 *
 * The union is merged with the first-match result into the minimal set of
 * maximal windows.
 */
function resolveAllowedWindows(overallRules: readonly ActiveRule[]): AllowedWindow[] {
  // Segment boundaries: day edges plus every rule window edge, deduped/sorted.
  const edges = new Set<number>([0, MINUTES_PER_DAY]);
  for (const rule of overallRules) {
    edges.add(rule.startMinute);
    edges.add(rule.endMinute);
  }
  const points = [...edges].sort((a, b) => a - b);

  const windows: AllowedWindow[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i] ?? 0;
    const end = points[i + 1] ?? MINUTES_PER_DAY;
    // First-match-wins: rules are already in precedence order.
    const winner = overallRules.find((r) => r.startMinute <= start && r.endMinute >= end);
    const allowed = winner === undefined || winner.action !== "deny";
    if (!allowed) continue;
    windows.push({ start, end });
  }

  // Widen with every `extend` window (ADR 0012 §2), then merge to maximal windows.
  const extendWindows = overallRules
    .filter((rule) => rule.action === "extend")
    .map((rule) => ({ start: rule.startMinute, end: rule.endMinute }));
  return mergeWindows([...windows, ...extendWindows]);
}

/**
 * Is `exc` active on the local day whose UTC bounds are `[dayStart, dayEnd)`?
 * The exception's local-minute `[start, end)` window on the day whose UTC bounds
 * are `[dayStart, dayEnd)`, or `null` when its active window
 * `[effective_from ?? created_at, expires_at)` (ADR 0005 §2) does not overlap
 * the day at all.
 *
 * The active window is a precise instant range (an exception `expires_at` is an
 * exact instant — "allow games until 9pm tonight", ADR 0012 §1), so it is
 * **intersected** with the day and projected onto local minutes: an interior day
 * of a multi-day override yields the full `[0, 1440)`, while the first/last day
 * yields the partial window the instants carve out. Minutes-since-local-midnight
 * are the elapsed real minutes from `dayStart` (the UTC instant of local
 * midnight), matching the resolver's existing minute model.
 */
function exceptionWindowOnDay(
  exc: ExceptionInput,
  dayStart: Date,
  dayEnd: Date,
): { start: number; end: number } | null {
  const fromMs = (exc.effectiveFrom ?? exc.createdAt).getTime();
  const startMs = Math.max(fromMs, dayStart.getTime());
  const endMs = Math.min(exc.expiresAt.getTime(), dayEnd.getTime());
  if (startMs >= endMs) return null;
  return {
    start: Math.round((startMs - dayStart.getTime()) / MS_PER_MINUTE),
    end: Math.round((endMs - dayStart.getTime()) / MS_PER_MINUTE),
  };
}

/** Is `grant` live and overlapping the day's `[dayStart, dayEnd)` UTC bounds? */
function grantOverlapsDay(grant: GrantInput, dayStart: Date, dayEnd: Date): boolean {
  if (grant.revokedAt !== null) return false;
  return (
    grant.grantedAt.getTime() < dayEnd.getTime() && grant.expiresAt.getTime() > dayStart.getTime()
  );
}

/**
 * The day's UTC `[start, end)` bounds, as returned by
 * {@link import("./budget-window.js").localDayBounds}. These already encode the
 * user's effective timezone, so the budget resolvers below take them directly
 * and never need the `tz` string again — grant overlap is a UTC-instant test.
 */
interface DayBounds {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The `(scope, window, target)` slot a budget occupies — the key over which
 * ADR 0008 dedupes cross-source budgets and ADR 0013 groups a slot's rows for
 * weekday selection. Exported so {@link import("./group-resolution.js")} shares
 * the one definition (the two layers must key identically or they drift).
 */
export function budgetSlotKey(budget: BudgetInput): string {
  return `${budget.scope}:${budget.window}:${budget.targetId ?? "null"}`;
}

/**
 * Reduce a budget list to the rows that apply on the given ISO `weekday`
 * (1 = Monday … 7 = Sunday), the within-slot weekday layer of #141 / ADR 0013.
 *
 * Per `(scope, window, target)` slot: rows whose `recurrenceDays` mask **covers**
 * `weekday` (weekday-specific) win over and shadow the slot's uniform
 * (`null`-mask) rows; rows whose mask is set but does **not** cover `weekday`
 * are dropped. If a slot has weekday-specific rows but none covers `weekday`
 * and there is no uniform fallback, the slot contributes nothing that day (no
 * daily limit). Surviving rows are returned as-is so the callers' existing
 * same-slot summing is preserved — a uniform-only list passes through unchanged,
 * so pre-#141 behaviour is exact.
 *
 * This is a *within-slot* dimension: it never mixes sources, so it composes
 * with the ADR-0008 group precedence resolved upstream in
 * {@link import("./group-resolution.js").gatherUserBudgets} without disturbing
 * the "a slot is sourced from exactly one place" invariant.
 */
export function selectBudgetsForWeekday(
  budgets: readonly BudgetInput[],
  weekday: number,
): BudgetInput[] {
  const weekdayBit = 1 << (weekday - 1);
  const bySlot = new Map<string, BudgetInput[]>();
  for (const budget of budgets) {
    const key = budgetSlotKey(budget);
    const existing = bySlot.get(key);
    if (existing === undefined) bySlot.set(key, [budget]);
    else existing.push(budget);
  }

  const selected: BudgetInput[] = [];
  for (const rows of bySlot.values()) {
    const specific = rows.filter((b) => {
      const mask = b.recurrenceDays ?? null;
      return mask !== null && (mask & weekdayBit) !== 0;
    });
    if (specific.length > 0) {
      selected.push(...specific);
      continue;
    }
    selected.push(...rows.filter((b) => (b.recurrenceDays ?? null) === null));
  }
  return selected;
}

/**
 * The effective overall daily allowance for one ISO `weekday`, in seconds — the
 * sum of the `overall`/`daily` budgets that {@link selectBudgetsForWeekday}
 * leaves in play on that weekday, or `null` when none does (no daily limit that
 * day). Grants are **not** folded in here: this is the per-weekday baseline the
 * `timekpra` push (`transport/policy-push/resolve.ts`) reads to build the
 * seven-day `--settimelimits` list, and the grant overlay is a per-user
 * recompute layer above the push (#117).
 */
export function overallDailySecondsForWeekday(
  budgets: readonly BudgetInput[],
  weekday: number,
): number | null {
  const daily = selectBudgetsForWeekday(budgets, weekday).filter(
    (b) => b.scope === "overall" && b.window === "daily",
  );
  return daily.length === 0 ? null : daily.reduce((sum, b) => sum + b.secondsAllowed, 0);
}

/**
 * The effective overall daily allowance in seconds: the sum of the user's
 * `overall`/`daily` budgets plus any active overall grants overlapping the day.
 * Returns `null` when no daily overall budget is defined (no daily limit — a
 * grant on an unlimited base is moot).
 */
function resolveOverallSeconds(
  budgets: readonly BudgetInput[],
  grants: readonly GrantInput[],
  dayBounds: DayBounds,
): number | null {
  const dailyOverall = budgets.filter((b) => b.scope === "overall" && b.window === "daily");
  if (dailyOverall.length === 0) return null;

  let seconds = dailyOverall.reduce((sum, b) => sum + b.secondsAllowed, 0);
  for (const grant of grants) {
    if (grant.scope === "overall" && grantOverlapsDay(grant, dayBounds.start, dayBounds.end)) {
      seconds += grant.secondsGranted;
    }
  }
  return seconds;
}

/**
 * The effective per-activity / per-group daily quotas: every `(scope, target)`
 * with a `daily` budget, folding in that target's active same-scope grants.
 *
 * Quotas are accumulated in a `Map` keyed `"scope:targetId"` (e.g.
 * `"activity:2"`, `"group:1"`) so multiple budget rows and grants for the same
 * target sum onto one slot. A grant on a target with **no** daily budget is
 * skipped — an unlimited base stays unlimited. The result is emitted ascending
 * by `(scope, targetId)`.
 */
function buildActivityQuotas(
  budgets: readonly BudgetInput[],
  grants: readonly GrantInput[],
  dayBounds: DayBounds,
): ActivityQuota[] {
  const quotas = new Map<string, ActivityQuota>();
  for (const b of budgets) {
    if (b.window !== "daily") continue;
    if ((b.scope !== "activity" && b.scope !== "group") || b.targetId === null) continue;
    const key = `${b.scope}:${b.targetId}`;
    const existing = quotas.get(key);
    quotas.set(key, {
      scope: b.scope,
      targetId: b.targetId,
      seconds: (existing?.seconds ?? 0) + b.secondsAllowed,
    });
  }
  for (const grant of grants) {
    if (grant.scope !== "activity" && grant.scope !== "group") continue;
    if (grant.targetId === null || !grantOverlapsDay(grant, dayBounds.start, dayBounds.end)) {
      continue;
    }
    const key = `${grant.scope}:${grant.targetId}`;
    const existing = quotas.get(key);
    // Grant-only targets (no daily budget) leave the base unlimited → skip.
    if (existing === undefined) continue;
    quotas.set(key, { ...existing, seconds: existing.seconds + grant.secondsGranted });
  }
  return [...quotas.values()].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.targetId - b.targetId,
  );
}

/**
 * Resolve the effective policy for user *U* on day *D* — the core computation
 * documented at the top of this module. Pure: every input row is supplied by
 * the caller (the `/api/.../effective` route loads them), so this is fully
 * unit-testable without a database.
 */
export function effectivePolicy(input: EffectivePolicyInput): EffectivePolicy {
  const { year, month, day } = input.date;
  const { tz } = input;
  const { start: dayStart, end: dayEnd } = localDayBounds(year, month, day, tz);
  const weekday = isoWeekday(year, month, day);

  // Candidate schedule rules for the day, in precedence order (ordinal, id).
  const activeRules: ActiveRule[] = byOrdinal(input.schedules)
    .filter((rule) => appliesOnDay(rule, weekday, dayStart, dayEnd))
    .map((rule) => {
      const window = ruleWindow(rule);
      return {
        id: rule.id,
        targetKind: rule.targetKind,
        targetId: rule.targetId,
        action: rule.action,
        startMinute: window.start,
        endMinute: window.end,
      };
    });

  // Date-specific overrides (#142, ADR 0012): each exception active on the day
  // becomes a rule at the head of the precedence order — over the local-minute
  // window its instant range carves out of the day — so an active override wins
  // over the recurring rules for the target it covers. The `exceptions` array is
  // already in precedence order (own-before-group, newest-before-older); its
  // order is preserved.
  const exceptionRules: ActiveRule[] = (input.exceptions ?? []).flatMap((exc) => {
    const window = exceptionWindowOnDay(exc, dayStart, dayEnd);
    if (window === null) return [];
    return [
      {
        id: exc.id,
        targetKind: exc.targetKind,
        targetId: exc.targetId,
        action: exc.action,
        startMinute: window.start,
        endMinute: window.end,
      },
    ];
  });

  const allowedWindows = resolveAllowedWindows([
    ...exceptionRules.filter((rule) => rule.targetKind === "overall"),
    ...activeRules.filter((rule) => rule.targetKind === "overall"),
  ]);

  // Budgets: reduce to the rows in play on this weekday (#141, ADR 0013) — a
  // uniform-only list passes through unchanged — then resolve the overall daily
  // allowance and the per-activity/per-group quotas, each folding in active
  // grants overlapping the day (`dayBounds` carries the effective-tz day edges
  // the grant-overlap test needs).
  const dayBounds: DayBounds = { start: dayStart, end: dayEnd };
  const budgetsForDay = selectBudgetsForWeekday(input.budgets, weekday);
  const overallSeconds = resolveOverallSeconds(budgetsForDay, input.grants, dayBounds);
  const perActivitySeconds = buildActivityQuotas(budgetsForDay, input.grants, dayBounds);

  return {
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    tz,
    allowedWindows,
    overallSeconds,
    perActivitySeconds,
    activeRules,
  };
}
