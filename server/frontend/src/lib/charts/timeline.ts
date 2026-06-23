/**
 * Pure geometry helpers for the per-activity timeline (#62).
 *
 * Kept free of Svelte/DOM so the placement maths is unit-tested directly. Each
 * sample becomes a lane segment positioned as a percentage of the `[from, to)`
 * window, which the component renders as a horizontal bar in its activity lane.
 */
import type { TimelineSample } from "$lib/api/contract.js";

/** A sample's placement within the timeline window, in percent of its width. */
export interface LaneSegment {
  activityId: number;
  /** Left edge as a percentage `[0, 100)` of the window. */
  leftPct: number;
  /** Width as a percentage `(0, 100]` of the window. */
  widthPct: number;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Project each sample onto the `[from, to)` window as a percentage segment,
 * clamping to the window edges and dropping samples that fall entirely outside
 * it (zero width). Returns `[]` for a non-positive window.
 */
export function laneSegments(
  samples: readonly TimelineSample[],
  from: string,
  to: string,
): LaneSegment[] {
  const start = ms(from);
  const end = ms(to);
  const span = end - start;
  if (span <= 0) {
    return [];
  }
  const segments: LaneSegment[] = [];
  for (const sample of samples) {
    const clampedStart = Math.max(ms(sample.startedAt), start);
    const clampedEnd = Math.min(ms(sample.endedAt), end);
    const widthPct = (Math.max(0, clampedEnd - clampedStart) / span) * 100;
    if (widthPct <= 0) {
      continue;
    }
    segments.push({
      activityId: sample.activityId,
      leftPct: ((clampedStart - start) / span) * 100,
      widthPct,
    });
  }
  return segments;
}
