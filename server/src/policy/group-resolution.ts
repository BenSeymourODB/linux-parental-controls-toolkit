/**
 * User-over-group schedule resolution (#182, `docs/adr/0007-group-targeted-policy-rules.md`).
 *
 * Merges a supervised user's **own** schedule rules with the rules of every
 * {@link import("./schema.js").userGroups group} they belong to into a single
 * precedence-ordered list that drops straight into the effective-policy resolver
 * ({@link import("./resolve.js").effectivePolicy}) and the precedence module
 * ({@link import("./schedule-precedence.js")}).
 *
 * **Precedence (ADR 0007 §"Resolution and precedence").** A member's own rules
 * win over inherited group rules:
 *
 * 1. the user's own schedules, in evaluation order (ascending `ordinal`, then
 *    `id`);
 * 2. then, for each group the user belongs to (ascending group `id`, a stable
 *    deterministic order across multiple groups), that group's schedules in
 *    evaluation order;
 * 3. concatenated **user-first** and **re-sequenced** to dense `0..n-1` ordinals
 *    over the merged list.
 *
 * Re-sequencing is what makes this safe to feed to `byOrdinal`: that helper
 * breaks ordinal ties by `id`, and the two source tables' ids collide (both
 * autoincrement from 1), so a fresh global ordinal makes the merge order
 * authoritative and the `id` tiebreak inert. The result satisfies the
 * owner-agnostic {@link ScheduleRule} interface, so group rules compose with the
 * existing recurrence + first-match-wins engine rather than a second
 * implementation.
 *
 * Each rule is tagged with its {@link RuleSource} so the future inherited-vs-
 * local editor (#124) can show which rules are local and which are inherited
 * (and from which group). Exceptions are intentionally not resolved here —
 * exception composition into the effective policy is #142 and `resolve.ts`
 * consumes neither user nor group exceptions yet.
 *
 * License boundary: none touched — plain TypeScript over the policy model.
 */
import type { PolicyDb } from "./db.js";
import {
  listGroupBudgets,
  listGroupSchedules,
  listUserBudgets,
  listUserGroupsForUser,
  listUserSchedules,
} from "./repository.js";
import { budgetSlotKey, type BudgetInput } from "./resolve.js";
import { byOrdinal, type ScheduleRule } from "./schedule-precedence.js";

/** Where a gathered rule came from: the user's own list, or an inherited group. */
export type RuleSource =
  | { readonly kind: "user" }
  | { readonly kind: "group"; readonly groupId: number };

/**
 * A {@link ScheduleRule} carrying its {@link RuleSource}. Because it extends
 * `ScheduleRule`, it feeds {@link import("./resolve.js").effectivePolicy} and
 * the precedence helpers unchanged; the `source` is extra context for the
 * editor, ignored by the resolver.
 */
export interface GatheredScheduleRule extends ScheduleRule {
  readonly source: RuleSource;
}

/** Copy the {@link ScheduleRule} subset off any own-rule row (Drizzle row or proposed DTO). */
function pickScheduleRuleFields(rule: ScheduleRule): ScheduleRule {
  return {
    id: rule.id,
    ordinal: rule.ordinal,
    targetKind: rule.targetKind,
    targetId: rule.targetId,
    recurrenceDays: rule.recurrenceDays,
    recurrenceStartMinute: rule.recurrenceStartMinute,
    recurrenceEndMinute: rule.recurrenceEndMinute,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    action: rule.action,
  };
}

/**
 * Merge an **explicit** own-rule list with the user's inherited group schedules
 * — own rules first (they win), then each group's rules (groups ascending by
 * id), re-sequenced to dense ordinals so the merge order is authoritative. See
 * the file header for the full precedence contract.
 *
 * The own rules are passed in rather than read here so the same composition
 * serves both the persisted case ({@link gatherUserScheduleRules}) and the
 * save-and-push preview, which merges a *proposed* own-rule set against the
 * persisted group layer the push will re-merge (#362).
 */
export function mergeScheduleRulesWithGroups(
  db: PolicyDb,
  userId: number,
  ownRules: readonly ScheduleRule[],
): GatheredScheduleRule[] {
  // Sort the own rules into evaluation order (ascending ordinal, then id) before
  // the merge re-sequences them. The persisted path (`listUserSchedules`) is
  // already sorted, but a caller passing proposed rows in an arbitrary order
  // (the save-and-push preview) must resolve by `ordinal`, not array position —
  // matching what the eventual save + reload will yield (#362).
  const own: GatheredScheduleRule[] = byOrdinal(
    ownRules.map((rule) => ({ ...pickScheduleRuleFields(rule), source: { kind: "user" } })),
  );

  // `listUserGroupsForUser` already returns groups ascending by id.
  const inherited: GatheredScheduleRule[] = listUserGroupsForUser(db, userId).flatMap((group) =>
    listGroupSchedules(db, group.id).map((row) => ({
      ...pickScheduleRuleFields(row),
      source: { kind: "group", groupId: group.id },
    })),
  );

  // Re-sequence dense ordinals over the user-first merge so `byOrdinal`'s id
  // tiebreak (ids collide across the two tables) can never reorder the result.
  return [...own, ...inherited].map((rule, index) => ({ ...rule, ordinal: index }));
}

/**
 * The user's effective schedule rule list — their persisted own rules merged
 * with inherited group rules via {@link mergeScheduleRulesWithGroups}. The
 * single entry point every enforcement and display surface reads so the push,
 * the force-close sweep, the preview, and `/api/.../effective` can't drift
 * (#362).
 */
export function gatherUserScheduleRules(db: PolicyDb, userId: number): GatheredScheduleRule[] {
  return mergeScheduleRulesWithGroups(db, userId, listUserSchedules(db, userId));
}

/**
 * A {@link BudgetInput} carrying its {@link RuleSource}. Feeds
 * {@link import("./resolve.js").effectivePolicy} unchanged; the `source` is
 * extra context for the inherited-vs-local editor (#124), ignored by the
 * resolver.
 */
export interface GatheredBudget extends BudgetInput {
  readonly source: RuleSource;
}

/**
 * Merge an **explicit** own-budget list with the user's inherited group budgets
 * — own budgets first (they win), then each group's budgets (groups ascending
 * by id), with **full-replace** override per slot (#134,
 * `docs/adr/0008-group-targeted-budgets.md`):
 *
 * 1. all of the passed-in own budgets are included, and their slots are marked
 *    covered;
 * 2. then, for each group the user belongs to (ascending group `id`), only that
 *    group's budgets whose slot is **not yet covered** are inherited — a slot is
 *    sourced from exactly one place, the user else the lowest-id group that
 *    defines it.
 *
 * A `Budget` is a single baseline figure, not an additive layer, so a slot is
 * never summed across sources (grants are the additive layer, applied per user
 * downstream — #117). *Within* one source two budgets sharing a slot are both
 * emitted, preserving the resolver's existing same-slot summing for the
 * user's own duplicate rows. The result is a plain `BudgetInput[]` (each tagged
 * with its {@link RuleSource}) that drops straight into
 * {@link import("./resolve.js").effectivePolicy}.
 *
 * The own budgets are passed in rather than read here so the same composition
 * serves both the persisted case ({@link gatherUserBudgets}) and the
 * save-and-push preview, which merges a *proposed* own-budget set against the
 * persisted group layer the push will re-merge (#362).
 */
export function mergeBudgetsWithGroups(
  db: PolicyDb,
  userId: number,
  ownBudgets: readonly BudgetInput[],
): GatheredBudget[] {
  const result: GatheredBudget[] = [];
  const covered = new Set<string>();

  for (const row of ownBudgets) {
    result.push({
      scope: row.scope,
      targetId: row.targetId,
      window: row.window,
      secondsAllowed: row.secondsAllowed,
      recurrenceDays: row.recurrenceDays ?? null,
      source: { kind: "user" },
    });
    covered.add(budgetSlotKey(row));
  }

  // `listUserGroupsForUser` already returns groups ascending by id.
  for (const group of listUserGroupsForUser(db, userId)) {
    // Slots this group contributes — folded into `covered` only after the whole
    // group so a same-slot duplicate *within* the group is still summed, while a
    // later (higher-id) group can never re-contribute a slot this one supplied.
    const groupSlots = new Set<string>();
    for (const row of listGroupBudgets(db, group.id)) {
      const key = budgetSlotKey(row);
      if (covered.has(key)) continue;
      result.push({
        scope: row.scope,
        targetId: row.targetId,
        window: row.window,
        secondsAllowed: row.secondsAllowed,
        recurrenceDays: row.recurrenceDays ?? null,
        source: { kind: "group", groupId: group.id },
      });
      groupSlots.add(key);
    }
    for (const key of groupSlots) covered.add(key);
  }

  return result;
}

/**
 * The user's effective budget baseline — their persisted own budgets merged
 * with inherited group budgets via {@link mergeBudgetsWithGroups}. The single
 * entry point every enforcement and display surface reads so the push, the
 * force-close sweep, the preview, and `/api/.../effective` can't drift (#362).
 */
export function gatherUserBudgets(db: PolicyDb, userId: number): GatheredBudget[] {
  return mergeBudgetsWithGroups(db, userId, listUserBudgets(db, userId));
}
