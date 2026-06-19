/**
 * Usage-sample persistence + budget rollups (#88).
 *
 * The companion to the pure AW normaliser
 * (`transport/activitywatch/normalise.ts`): this module owns the `usage_samples`
 * writes and the aggregation reads the dashboard renders — per-user budget
 * **burndown** (today/week/month) and the per-activity **timeline**
 * (`docs/architecture.md` → "Key derived views"). It is the data source the
 * Phase-5 chart components (#62) and the Phase-8 per-activity enforcement
 * decision logic (#98) consume.
 *
 * Two rules are load-bearing here:
 *  - **Effective-timezone windows.** Every "how much in today/this week/this
 *    month?" boundary is computed through `policy/budget-window.ts`, so the
 *    rollover instant is the user's effective-TZ local midnight, pinned across
 *    a mid-window timezone change (ADR 0001 / ADR 0003). Storage stays UTC.
 *  - **Gap-conservatism.** A budget window is credited only the *overlap* of a
 *    sample with the window (`max(0, min(end, winEnd) − max(start, winStart))`),
 *    so a sample straddling a boundary is split across windows and never
 *    double-counted, and a missing-telemetry gap simply credits nothing (issue
 *    #88) rather than a punitive deduction.
 *
 * Scope: this is a dedicated module (not `policy/repository.ts`, which the #51
 * CRUD work grows) so it composes beside that in-flight work without collision.
 *
 * License boundary: none touched — Drizzle (Apache-2.0) + better-sqlite3 (MIT)
 * only; no GPL surface and no transport call (samples arrive pre-normalised).
 */
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";

import { effectiveWindow, type TimezoneChange } from "./budget-window.js";
import type { PolicyDb } from "./db.js";
import type { BudgetWindow } from "./enums.js";
import { activitiesToGroups, usageSamples } from "./schema.js";

/** A persisted {@link usageSamples} row. */
export type UsageSampleRow = typeof usageSamples.$inferSelect;

/**
 * One normalised usage interval to persist. Structurally matches the
 * normaliser's `UsageSampleCandidate`, so its output inserts directly without
 * the policy layer importing the transport layer.
 */
export interface UsageSampleInsert {
  readonly userId: number;
  readonly clientId: number;
  readonly activityId: number;
  /** Interval start, UTC. */
  readonly startedAt: Date;
  /** Interval end (exclusive), UTC; must be `>= startedAt`. */
  readonly endedAt: Date;
}

/**
 * Selects the budget window to roll up over. `window` + `now` + the user's
 * effective `tz` resolve to a half-open `[start, end)` boundary via
 * {@link effectiveWindow}; `change` pins the in-flight window across a
 * timezone change (ADR 0003).
 */
export interface WindowQuery {
  readonly userId: number;
  readonly window: BudgetWindow;
  /** Reference instant — the window containing it is rolled up. */
  readonly now: Date;
  /** The user's effective IANA timezone (`User.tz ?? PCT_DEFAULT_TZ`). */
  readonly tz: string;
  /** Optional mid-window timezone change to honour (ADR 0003). */
  readonly change?: TimezoneChange;
}

/**
 * Insert normalised samples. Returns the number of rows written; a no-op for an
 * empty batch.
 *
 * The normaliser dedups overlaps **within** a batch; de-duplicating across
 * overlapping *pull windows* is the telemetry-pull layer's responsibility
 * (#162 owns the per-client pull cursor), not this writer's — keeping this a
 * plain append.
 */
export function insertUsageSamples(db: PolicyDb, samples: readonly UsageSampleInsert[]): number {
  if (samples.length === 0) return 0;
  const rows = samples.map((s) => ({
    userId: s.userId,
    clientId: s.clientId,
    activityId: s.activityId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  }));
  return db.insert(usageSamples).values(rows).run().changes;
}

/** Half-open `[from, to)` overlap of one sample, in seconds (never negative). */
function overlapSeconds(row: UsageSampleRow, from: Date, to: Date): number {
  const start = Math.max(row.startedAt.getTime(), from.getTime());
  const end = Math.min(row.endedAt.getTime(), to.getTime());
  // The callers' SQL WHERE already restricts to genuinely overlapping rows, so
  // `end > start`; `Math.max(0, …)` is the cheap belt-and-suspenders guard
  // against a degenerate row without introducing an untestable branch.
  return Math.max(0, end - start) / 1000;
}

/**
 * The user's samples that overlap `[from, to)`. A sample overlaps iff it starts
 * before the window ends and ends after the window starts; the
 * `(user_id, started_at)` index serves the scan.
 */
function samplesOverlapping(db: PolicyDb, userId: number, from: Date, to: Date): UsageSampleRow[] {
  return db
    .select()
    .from(usageSamples)
    .where(
      and(
        eq(usageSamples.userId, userId),
        lt(usageSamples.startedAt, to),
        gt(usageSamples.endedAt, from),
      ),
    )
    .all();
}

/**
 * Seconds of one activity consumed by `userId` within the effective budget
 * window. Sums the clamped overlap so a sample crossing the rollover boundary
 * contributes only its in-window portion.
 */
export function activitySecondsInWindow(
  db: PolicyDb,
  query: WindowQuery & { activityId: number },
): number {
  const { start, end } = effectiveWindow(query.window, query.now, query.tz, query.change);
  const rows = db
    .select()
    .from(usageSamples)
    .where(
      and(
        eq(usageSamples.userId, query.userId),
        eq(usageSamples.activityId, query.activityId),
        lt(usageSamples.startedAt, end),
        gt(usageSamples.endedAt, start),
      ),
    )
    .all();
  return rows.reduce((total, row) => total + overlapSeconds(row, start, end), 0);
}

/**
 * Per-activity consumption (seconds) for `userId` within the effective budget
 * window — the burndown across every per-activity budget the user has. Only
 * activities with usage in the window appear; an activity with none is absent
 * (the caller reads `Map.get(id) ?? 0`).
 */
export function usageByActivityInWindow(db: PolicyDb, query: WindowQuery): Map<number, number> {
  const { start, end } = effectiveWindow(query.window, query.now, query.tz, query.change);
  const byActivity = new Map<number, number>();
  for (const row of samplesOverlapping(db, query.userId, start, end)) {
    const seconds = overlapSeconds(row, start, end);
    byActivity.set(row.activityId, (byActivity.get(row.activityId) ?? 0) + seconds);
  }
  return byActivity;
}

/**
 * Seconds consumed by `userId` across **every activity in a group** within the
 * effective budget window — the group-budget burndown (the group's members come
 * from the `activities_to_groups` M2M). An empty group credits zero.
 */
export function groupSecondsInWindow(
  db: PolicyDb,
  query: WindowQuery & { groupId: number },
): number {
  const activityIds = db
    .select({ activityId: activitiesToGroups.activityId })
    .from(activitiesToGroups)
    .where(eq(activitiesToGroups.groupId, query.groupId))
    .all()
    .map((row) => row.activityId);
  if (activityIds.length === 0) return 0;

  const { start, end } = effectiveWindow(query.window, query.now, query.tz, query.change);
  const rows = db
    .select()
    .from(usageSamples)
    .where(
      and(
        eq(usageSamples.userId, query.userId),
        inArray(usageSamples.activityId, activityIds),
        lt(usageSamples.startedAt, end),
        gt(usageSamples.endedAt, start),
      ),
    )
    .all();
  return rows.reduce((total, row) => total + overlapSeconds(row, start, end), 0);
}

/**
 * The per-activity timeline: every sample for `userId` overlapping `[from, to)`,
 * ordered by `started_at`. Unlike the budget rollups this returns the raw
 * intervals (clamping is the renderer's job) so the view can draw exactly when
 * each activity was active (`docs/architecture.md` → "Per-activity timeline").
 */
export function activityTimeline(
  db: PolicyDb,
  query: { userId: number; from: Date; to: Date },
): UsageSampleRow[] {
  return db
    .select()
    .from(usageSamples)
    .where(
      and(
        eq(usageSamples.userId, query.userId),
        lt(usageSamples.startedAt, query.to),
        gt(usageSamples.endedAt, query.from),
      ),
    )
    .orderBy(asc(usageSamples.startedAt), asc(usageSamples.id))
    .all();
}
