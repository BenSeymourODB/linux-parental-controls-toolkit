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
 * **Scope of this slice.** Recurring windows + uniform budgets + active grants,
 * exactly the Phase-4 core of #143. Exception/date-specific-override
 * composition (#142) and weekday-varying budgets (#141) are additive layers
 * that plug into the same resolver later; they are intentionally not resolved
 * here so this does not code against #142's not-yet-decided cross-layer
 * ordering.
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
import { byOrdinal, type RuleActivePredicate, type ScheduleRule } from "./schedule-precedence.js";

/** Minutes in a full day; the exclusive end of the intra-day window space. */
const MINUTES_PER_DAY = 1440;

/**
 * The subset of a {@link import("./schema.js").budgets} row the resolver reads.
 * Structural so callers pass either a Drizzle row or a test fixture.
 */
export interface BudgetInput {
  readonly scope: Scope;
  readonly targetId: number | null;
  readonly window: BudgetWindow;
  readonly secondsAllowed: number;
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
   * Every schedule rule in play on the day (all scopes), in precedence order
   * (`ordinal`, then `id`). Lets a preview surface render inherited/competing
   * rules, not just the resolved `overall` windows.
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
  const t = at.getTime();

  // Date gate: [effective_from, effective_to), either bound open.
  if (rule.effectiveFrom !== null && t < rule.effectiveFrom.getTime()) return false;
  if (rule.effectiveTo !== null && t >= rule.effectiveTo.getTime()) return false;

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
 * Resolve the day's allowed overall-access windows from the `overall`-scoped
 * candidate rules. Walks the minute timeline at every rule boundary; within
 * each segment the first rule (by precedence order) whose window covers it
 * wins, and the segment is allowed unless that winner is `deny`. With no
 * winner the baseline is allow (ADR 0004). Adjacent allowed segments are
 * merged so the result is the minimal set of maximal windows.
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
    const last = windows[windows.length - 1];
    if (last !== undefined && last.end === start) {
      windows[windows.length - 1] = { start: last.start, end };
    } else {
      windows.push({ start, end });
    }
  }
  return windows;
}

/** Is `grant` live and overlapping the day's `[dayStart, dayEnd)` UTC bounds? */
function grantOverlapsDay(grant: GrantInput, dayStart: Date, dayEnd: Date): boolean {
  if (grant.revokedAt !== null) return false;
  return (
    grant.grantedAt.getTime() < dayEnd.getTime() && grant.expiresAt.getTime() > dayStart.getTime()
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

  const allowedWindows = resolveAllowedWindows(
    activeRules.filter((rule) => rule.targetKind === "overall"),
  );

  // Overall budget: daily baseline + active overall grants. Null when no daily
  // overall budget exists (no daily limit; a grant on an unlimited base is moot).
  const dailyOverall = input.budgets.filter((b) => b.scope === "overall" && b.window === "daily");
  let overallSeconds: number | null = null;
  if (dailyOverall.length > 0) {
    overallSeconds = dailyOverall.reduce((sum, b) => sum + b.secondsAllowed, 0);
    for (const grant of input.grants) {
      if (grant.scope === "overall" && grantOverlapsDay(grant, dayStart, dayEnd)) {
        overallSeconds += grant.secondsGranted;
      }
    }
  }

  // Per-activity / per-group quotas: each (scope, target) with a daily budget,
  // plus its active grants. Keyed `scope:targetId`, emitted ascending.
  const quotas = new Map<string, ActivityQuota>();
  for (const b of input.budgets) {
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
  for (const grant of input.grants) {
    if (grant.scope !== "activity" && grant.scope !== "group") continue;
    if (grant.targetId === null || !grantOverlapsDay(grant, dayStart, dayEnd)) continue;
    const key = `${grant.scope}:${grant.targetId}`;
    const existing = quotas.get(key);
    // Grant-only targets (no daily budget) leave the base unlimited → skip.
    if (existing === undefined) continue;
    quotas.set(key, { ...existing, seconds: existing.seconds + grant.secondsGranted });
  }
  const perActivitySeconds = [...quotas.values()].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.targetId - b.targetId,
  );

  return {
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    tz,
    allowedWindows,
    overallSeconds,
    perActivitySeconds,
    activeRules,
  };
}
