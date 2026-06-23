/**
 * Pure geometry helpers for the overall-budget burndown chart (#62).
 *
 * Kept free of Svelte/DOM so the consumption maths is unit-tested directly: the
 * component imports these to place the actual-remaining curve, the ideal-pace
 * reference line, and the "now" marker. All instants are ISO-8601 UTC strings
 * (the `/api` contract); the window is half-open `[windowStart, windowEnd)`.
 */
import type { TimelineSample } from "$lib/api/contract.js";

/** A point on the remaining-budget curve: epoch ms `t`, seconds `remaining`. */
export interface RemainingPoint {
  t: number;
  remaining: number;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/** Clamped overlap of `[start, end)` with `[from, to)`, in seconds (never < 0). */
function overlapSeconds(start: number, end: number, from: number, to: number): number {
  return Math.max(0, Math.min(end, to) - Math.max(start, from)) / 1000;
}

/** Total seconds consumed across `samples` within `[windowStart, windowEnd)`. */
export function consumedSeconds(
  samples: readonly TimelineSample[],
  windowStart: string,
  windowEnd: string,
): number {
  const from = ms(windowStart);
  const to = ms(windowEnd);
  return samples.reduce(
    (sum, s) => sum + overlapSeconds(ms(s.startedAt), ms(s.endedAt), from, to),
    0,
  );
}

/**
 * The remaining-budget series: starts at `budgetSeconds` at the window open and
 * steps down by each sample's in-window consumption, in chronological order.
 * Remaining is floored at zero (an over-budget day flatlines on the axis). The
 * first point is always the window start; samples with no overlap are skipped.
 */
export function remainingSeries(
  budgetSeconds: number,
  samples: readonly TimelineSample[],
  windowStart: string,
  windowEnd: string,
): RemainingPoint[] {
  const from = ms(windowStart);
  const to = ms(windowEnd);
  const points: RemainingPoint[] = [{ t: from, remaining: budgetSeconds }];
  let remaining = budgetSeconds;
  const sorted = [...samples].sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  for (const sample of sorted) {
    const start = ms(sample.startedAt);
    const end = ms(sample.endedAt);
    const secs = overlapSeconds(start, end, from, to);
    if (secs <= 0) {
      continue;
    }
    remaining = Math.max(0, remaining - secs);
    points.push({ t: Math.min(end, to), remaining });
  }
  return points;
}

/**
 * The ideal-pace remaining at instant `at`: a straight burn from `budgetSeconds`
 * at the window open to zero at the window close. Clamps outside the window.
 */
export function idealRemaining(
  budgetSeconds: number,
  windowStart: string,
  windowEnd: string,
  at: string,
): number {
  const from = ms(windowStart);
  const to = ms(windowEnd);
  const now = ms(at);
  if (now <= from) {
    return budgetSeconds;
  }
  if (now >= to || to <= from) {
    return 0;
  }
  return budgetSeconds * (1 - (now - from) / (to - from));
}
