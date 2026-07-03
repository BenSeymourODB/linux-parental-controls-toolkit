/**
 * Local time-remaining warning cadence for the per-user agent (#103, Phase 8b).
 *
 * `docs/client-notifications.md` → "Notification cadence — exact rules": for
 * every active budget the agent tracks remaining time and fires escalating
 * warnings that line up with **round numbers of minutes remaining**, regardless
 * of when in real time the budget started:
 *
 * | remaining | interval | warnings fire at (minutes remaining)              |
 * |-----------|----------|---------------------------------------------------|
 * | > 15 min  | 15 min   | every 15-minute boundary (…, 45, 30, 15)          |
 * | 6–15 min  | 5 min    | 15, 10                                             |
 * | 1–5 min   | 1 min    | 5, 4, 3, 2, 1                                      |
 * | 0:00      | —        | the final "time's up — save and quit!"            |
 *
 * The union of those boundaries is the {@link warningThresholdsSeconds} set:
 * every 15-minute multiple, plus 10, plus 5/4/3/2/1 minutes — each **strictly
 * below** the budget total, so a fresh budget never warns at t=0.
 *
 * This module is **pure** (no timers, no I/O): a {@link CadenceTracker} takes
 * successive `remaining` readings and returns the warning to render, if any, so
 * the schedule is unit-testable without a clock — the same discipline
 * `bridge/backoff.ts` uses for the reconnect delay. The agent owns one tracker
 * per budget and drives it from the tick loop.
 *
 * License boundary: none touched — plain TypeScript.
 */

/** Seconds in a minute — the cadence is expressed entirely in whole minutes. */
const SECONDS_PER_MINUTE = 60;
/** The coarse interval: a warning at every 15-minute boundary while > 15 min. */
const COARSE_INTERVAL_MINUTES = 15;
/** The single mid-tier boundary between the 15- and 5-minute cadences. */
const MID_TIER_MINUTES = 10;
/** The fine tier: a warning at each of the last five whole minutes. */
const FINE_TIER_MINUTES: readonly number[] = [5, 4, 3, 2, 1];

/** What a fired warning is: a routine boundary, or the final zero. */
export type CadenceKind = "warning" | "timesUp";

/** A single budget's warning to render this tick. */
export interface CadenceWarning {
  /** Stable per-budget key (e.g. `overall` or `activity:7`). */
  budgetKey: string;
  /** Human label for the toast ("YouTube", "overall screen time"). */
  budgetLabel: string;
  kind: CadenceKind;
  /** Remaining seconds at the moment the warning fired (clamped to ≥ 0). */
  remainingSeconds: number;
  /** The minute-boundary that triggered it, in seconds; `0` for `timesUp`. */
  thresholdSeconds: number;
}

/**
 * The set of warning boundaries for a budget of `totalSeconds`, in seconds,
 * sorted **descending**. Every entry is strictly less than the total so the
 * first tick of a fresh budget is silent. A budget of a minute or less has no
 * boundaries — it only ever fires the final `timesUp`.
 */
export function warningThresholdsSeconds(totalSeconds: number): number[] {
  const total = Math.max(0, Math.floor(totalSeconds));
  const minutes = new Set<number>();

  // Every 15-minute multiple below the total (…, 45, 30, 15).
  for (
    let m = COARSE_INTERVAL_MINUTES;
    m * SECONDS_PER_MINUTE < total;
    m += COARSE_INTERVAL_MINUTES
  ) {
    minutes.add(m);
  }
  // The mid-tier and fine-tier boundaries, each kept only if below the total.
  for (const m of [MID_TIER_MINUTES, ...FINE_TIER_MINUTES]) {
    if (m * SECONDS_PER_MINUTE < total) minutes.add(m);
  }

  return [...minutes].map((m) => m * SECONDS_PER_MINUTE).sort((a, b) => b - a);
}

/**
 * Tracks one budget's descent toward zero and decides when to warn.
 *
 * `observe(remaining)` is called each tick with the current remaining seconds;
 * it returns a {@link CadenceWarning} the first time remaining reaches a
 * not-yet-announced boundary (the **deepest** boundary reached that tick, so a
 * large jump announces the most urgent state rather than a stale higher one),
 * a `timesUp` warning the first time remaining hits `0`, and `null` otherwise.
 *
 * A tracker is single-use per budget total: when a grant tops the budget back
 * up, the agent builds a fresh tracker for the new total, which re-arms the
 * boundaries so warnings fire again as it drains a second time.
 */
export class CadenceTracker {
  readonly #thresholds: readonly number[];
  #lastAnnounced = Number.POSITIVE_INFINITY;
  #finalAnnounced = false;

  constructor(
    private readonly budgetKey: string,
    private readonly budgetLabel: string,
    totalSeconds: number,
  ) {
    this.#thresholds = warningThresholdsSeconds(totalSeconds);
  }

  /** Feed the current remaining seconds; get the warning to render, if any. */
  observe(remainingSeconds: number): CadenceWarning | null {
    const remaining = Math.max(0, Math.floor(remainingSeconds));

    if (remaining <= 0) {
      if (this.#finalAnnounced) return null;
      this.#finalAnnounced = true;
      this.#lastAnnounced = 0;
      return this.#warning("timesUp", 0, 0);
    }

    // Boundaries reached this tick and not yet announced. `#thresholds` is
    // descending, so the last match is the smallest — the deepest boundary
    // reached, i.e. the most urgent one to announce.
    let deepest: number | null = null;
    for (const threshold of this.#thresholds) {
      if (threshold < this.#lastAnnounced && remaining <= threshold) deepest = threshold;
    }
    if (deepest === null) return null;

    this.#lastAnnounced = deepest;
    return this.#warning("warning", remaining, deepest);
  }

  #warning(kind: CadenceKind, remainingSeconds: number, thresholdSeconds: number): CadenceWarning {
    return {
      budgetKey: this.budgetKey,
      budgetLabel: this.budgetLabel,
      kind,
      remainingSeconds,
      thresholdSeconds,
    };
  }
}

/** One rendered notification covering one or more budgets at the same boundary. */
export interface CoalescedWarning {
  kind: CadenceKind;
  thresholdSeconds: number;
  /** The budgets that crossed this boundary together, in input order. */
  budgets: { key: string; label: string }[];
  /** A ready-to-render toast body. */
  message: string;
}

/**
 * Coalesce the warnings produced across all budgets in a single tick into one
 * notification per (kind, boundary) pair, so several budgets crossing the same
 * boundary in the same ~5-second window become one toast rather than a burst
 * (`docs/client-notifications.md`: "coalesces them into one toast").
 *
 * Grouping order follows first appearance so the output is deterministic.
 */
export function coalesceWarnings(warnings: readonly CadenceWarning[]): CoalescedWarning[] {
  const groups = new Map<string, CoalescedWarning>();
  for (const w of warnings) {
    const groupKey = `${w.kind}:${w.thresholdSeconds}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.budgets.push({ key: w.budgetKey, label: w.budgetLabel });
    } else {
      groups.set(groupKey, {
        kind: w.kind,
        thresholdSeconds: w.thresholdSeconds,
        budgets: [{ key: w.budgetKey, label: w.budgetLabel }],
        message: "",
      });
    }
  }
  for (const group of groups.values()) group.message = formatCadenceMessage(group);
  return [...groups.values()];
}

/** Format the toast body for a coalesced warning, non-punitive per the design. */
export function formatCadenceMessage(group: {
  kind: CadenceKind;
  thresholdSeconds: number;
  budgets: readonly { label: string }[];
}): string {
  const labels = group.budgets.map((b) => b.label);
  const subject = joinLabels(labels);
  if (group.kind === "timesUp") {
    const verb = labels.length > 1 ? "are" : "is";
    return `Time's up — save and quit! ${subject} ${verb} out of time.`;
  }
  const minutes = Math.round(group.thresholdSeconds / SECONDS_PER_MINUTE);
  const unit = minutes === 1 ? "minute" : "minutes";
  const verb = labels.length > 1 ? "have" : "has";
  return `${subject} ${verb} ${minutes} ${unit} left.`;
}

/** Join labels as a natural-language list: "A", "A and B", "A, B and C". */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
