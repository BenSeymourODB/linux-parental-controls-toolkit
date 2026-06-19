/**
 * Normalise pulled ActivityWatch events into `UsageSample` candidates (#88).
 *
 * The Phase-5 telemetry job (#86/#162) pulls window + afk events from a client's
 * `aw-server` over an SSH port-forward (`transport/activitywatch/client.ts`).
 * This module is the **pure** transform from those typed events into the
 * `usage_samples` shape the policy store persists (`policy/usage.ts`) and the
 * burndown / per-activity-timeline views read. It is DB-free and side-effect
 * free so it unit-tests without a database or a live `aw-server`.
 *
 * What it does, in order:
 *  1. Resolve each window event's foreground `app` to an {@link Activity} via
 *     the matcher index (see "Matcher semantics" below). Unmatched apps yield no
 *     sample — the `usage_samples.activity_id` FK requires a real activity and
 *     we never fabricate one.
 *  2. Drop future-skewed events (a client clock running ahead): an event whose
 *     start is more than {@link DEFAULT_FUTURE_TOLERANCE_SECONDS} beyond `now`
 *     is discarded rather than summed into a budget (`docs/testing.md` →
 *     "an event with a future timestamp beyond the tolerance window is dropped").
 *     The interval *end* is clamped to the same cutoff, so a single event with a
 *     corrupt/huge `durationSeconds` cannot credit unbounded future time.
 *  3. Clip credited time to **not-afk** intervals when afk telemetry is present,
 *     so foreground time while the user was away from the keyboard is not
 *     charged. When no afk telemetry is supplied we do not clip — missing
 *     telemetry credits no consumption and is never a punitive deduction
 *     (issue #88), so we neither invent away-time nor zero out positive
 *     window evidence.
 *  4. Merge overlapping/adjacent intervals **per activity**, collapsing the
 *     clock-skew duplicate-event artifact (`docs/testing.md` → "Overlapping
 *     events ... are deduplicated") into tiling half-open intervals.
 *
 * Matcher semantics (v1, defined here because the docs leave "matcher"
 * unspecified): only `app`-kind activities are resolvable from window events,
 * by **case-insensitive exact match** of the event `app` against the activity
 * `matcher`. `domain*` kinds come from web-proxy telemetry (not the window
 * watcher) and `*_group` kinds are client-expanded bundles; both are out of
 * scope for window-event normalisation (tracked as a follow-up). Group-level
 * *rollups* are still available downstream via the `activities_to_groups` M2M.
 *
 * License boundary: pure TypeScript over the already-validated AW DTOs — no
 * ActivityWatch source linked, no GPL surface, no subprocess/REST call here.
 */
import type { ActivityKind } from "../../policy/enums.js";
import type { AwAfkEvent, AwWindowEvent } from "./schemas.js";

/**
 * A normalised usage interval ready to insert into `usage_samples`. Structurally
 * matches `policy/usage.ts`'s `UsageSampleInsert`, so the normaliser output flows
 * straight into the repository without the transport layer importing the policy
 * layer (or vice-versa).
 */
export interface UsageSampleCandidate {
  /** The supervised user this telemetry belongs to. */
  readonly userId: number;
  /** The client the telemetry was pulled from. */
  readonly clientId: number;
  /** The resolved {@link Activity} the foreground app matched. */
  readonly activityId: number;
  /** Interval start, UTC. */
  readonly startedAt: Date;
  /** Interval end (exclusive), UTC; always `>= startedAt`. */
  readonly endedAt: Date;
}

/** The fields of an {@link Activity} the matcher needs (a row subset). */
export interface ActivityMatcher {
  readonly id: number;
  readonly kind: ActivityKind;
  readonly matcher: string;
}

/** Input to {@link normaliseWindowEvents}. */
export interface NormaliseUsageInput {
  /** The supervised user the telemetry belongs to. */
  readonly userId: number;
  /** The client the telemetry was pulled from. */
  readonly clientId: number;
  /** Window-watcher events for the pull window. */
  readonly windowEvents: readonly AwWindowEvent[];
  /**
   * Afk-watcher events for the same window. When present (≥1 entry), credited
   * time is clipped to the `not-afk` intervals. Absent or empty → no clip.
   */
  readonly afkEvents?: readonly AwAfkEvent[];
  /** Candidate activities to resolve `app` against (only `app`-kind is used). */
  readonly activities: readonly ActivityMatcher[];
  /** Reference "now" for the future-skew guard (typically the pull instant). */
  readonly now: Date;
  /**
   * How far ahead of `now` an event start may sit before it's treated as a
   * clock-skew artifact and dropped. Defaults to
   * {@link DEFAULT_FUTURE_TOLERANCE_SECONDS}.
   */
  readonly futureToleranceSeconds?: number;
}

/**
 * Future-skew tolerance: an event start within this many seconds of `now` is
 * accepted; beyond it the event is dropped (`docs/testing.md` — "≤60 s in the
 * future is accepted; >60 s is rejected").
 */
export const DEFAULT_FUTURE_TOLERANCE_SECONDS = 60;

/** A half-open `[start, end)` interval in epoch milliseconds. */
interface MsInterval {
  start: number;
  end: number;
}

/**
 * Build a case-insensitive `app → activityId` lookup over the `app`-kind
 * activities. On a duplicate (case-folded) matcher the lowest activity id wins,
 * so resolution is deterministic regardless of input order.
 */
function buildAppMatchIndex(activities: readonly ActivityMatcher[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const activity of activities) {
    if (activity.kind !== "app") continue;
    const key = activity.matcher.toLowerCase();
    const existing = index.get(key);
    if (existing === undefined || activity.id < existing) {
      index.set(key, activity.id);
    }
  }
  return index;
}

/** Coalesce a set of intervals into sorted, non-overlapping, merged intervals. */
function mergeIntervals(intervals: MsInterval[]): MsInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: MsInterval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    // Adjacent (touching) intervals merge too, so back-to-back skew duplicates
    // collapse into one tiling interval rather than leaving a zero-width gap.
    if (last !== undefined && current.start <= last.end) {
      if (current.end > last.end) last.end = current.end;
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/**
 * Intersect a candidate interval with a set of (already merged, sorted) allow
 * intervals, returning the overlapping sub-intervals. An empty allow set yields
 * nothing (everything was afk).
 */
function intersectWithAllowed(candidate: MsInterval, allowed: MsInterval[]): MsInterval[] {
  const out: MsInterval[] = [];
  for (const window of allowed) {
    if (window.end <= candidate.start) continue;
    if (window.start >= candidate.end) break;
    const start = Math.max(candidate.start, window.start);
    const end = Math.min(candidate.end, window.end);
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** The `not-afk` intervals (merged), in epoch ms, from afk telemetry. */
function notAfkIntervals(afkEvents: readonly AwAfkEvent[]): MsInterval[] {
  const intervals: MsInterval[] = [];
  for (const event of afkEvents) {
    if (event.status !== "not-afk") continue;
    const start = event.timestamp.getTime();
    const end = start + event.durationSeconds * 1000;
    if (end > start) intervals.push({ start, end });
  }
  return mergeIntervals(intervals);
}

/**
 * Normalise window-watcher events (clipped by afk telemetry) into
 * {@link UsageSampleCandidate}s ready for `policy/usage.ts` to persist.
 *
 * Pure and deterministic: the output is sorted by `(activityId, startedAt)`,
 * carries no overlapping intervals within an activity, and has boundaries
 * floored to whole seconds to match the `usage_samples` storage granularity.
 */
export function normaliseWindowEvents(input: NormaliseUsageInput): UsageSampleCandidate[] {
  const { userId, clientId, windowEvents, activities, now } = input;
  const tolerance = (input.futureToleranceSeconds ?? DEFAULT_FUTURE_TOLERANCE_SECONDS) * 1000;
  const futureCutoff = now.getTime() + tolerance;

  const appIndex = buildAppMatchIndex(activities);

  // Group raw (skew-checked, matched) intervals by activity.
  const byActivity = new Map<number, MsInterval[]>();
  for (const event of windowEvents) {
    if (event.durationSeconds <= 0) continue;
    const start = event.timestamp.getTime();
    if (start > futureCutoff) continue;
    const activityId = appIndex.get(event.app.toLowerCase());
    if (activityId === undefined) continue;
    // Clamp the end to the same future cutoff as the start, so a single event
    // with a corrupt/huge `durationSeconds` cannot credit unbounded future
    // time past the skew tolerance; a fully-future-clamped interval is dropped.
    const end = Math.min(start + event.durationSeconds * 1000, futureCutoff);
    if (end <= start) continue;
    const bucket = byActivity.get(activityId);
    if (bucket === undefined) byActivity.set(activityId, [{ start, end }]);
    else bucket.push({ start, end });
  }

  // Clip to not-afk only when afk telemetry was actually supplied.
  const afkEvents = input.afkEvents;
  const allowed =
    afkEvents !== undefined && afkEvents.length > 0 ? notAfkIntervals(afkEvents) : null;

  const candidates: UsageSampleCandidate[] = [];
  // Deterministic activity order so output is stable for assertions and so
  // inserts hit the index in a predictable pattern.
  for (const [activityId, raw] of [...byActivity.entries()].sort((a, b) => a[0] - b[0])) {
    const clipped = allowed === null ? raw : raw.flatMap((iv) => intersectWithAllowed(iv, allowed));
    for (const interval of mergeIntervals(clipped)) {
      // Floor boundaries to whole seconds: `usage_samples` stores epoch
      // *seconds*, so emitting second-aligned candidates makes the persisted
      // row exactly the candidate (no hidden write-time truncation) and keeps
      // the rollups' arithmetic lossless. Flooring (vs rounding) can only
      // shrink an interval, never over-credit.
      const startedAt = Math.floor(interval.start / 1000) * 1000;
      const endedAt = Math.floor(interval.end / 1000) * 1000;
      if (endedAt <= startedAt) continue;
      candidates.push({
        userId,
        clientId,
        activityId,
        startedAt: new Date(startedAt),
        endedAt: new Date(endedAt),
      });
    }
  }
  return candidates;
}
