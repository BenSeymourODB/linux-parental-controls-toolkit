/**
 * Read calls for the usage views (#62 backend, #62 components).
 *
 * Usage is **read-only** over HTTP — it is derived from telemetry, never from a
 * request — so this exposes two queries that mirror the other `$lib/api/*`
 * wrappers (#53): thin typed wrappers over {@link apiFetch}, with the request
 * shape and response type taken from the shared `/api` contract so the frontend
 * never re-declares a DTO.
 *
 * - `getBurndown` → `GET /api/users/:id/usage/burndown` (per-budget consumed vs
 *   allowed for the chosen rollover window).
 * - `getTimeline` → `GET /api/users/:id/usage/timeline` (raw per-activity
 *   intervals + their activity labels over a range).
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { BudgetWindow, BurndownResponse, TimelineResponse } from "./contract.js";

/**
 * Fetch the per-budget burndown for one user over `window` (defaults to
 * `daily`). The window is resolved in the user's effective timezone server-side.
 */
export function getBurndown(
  userId: number,
  window: BudgetWindow = "daily",
): Promise<BurndownResponse> {
  return apiFetch<BurndownResponse>(`/users/${userId}/usage/burndown?window=${window}`);
}

/** Optional `[from, to)` range for {@link getTimeline}; ISO-8601 UTC instants. */
export interface TimelineRange {
  /** Inclusive start; omitted ⇒ the user's daily window start (today). */
  from?: string;
  /** Exclusive end; omitted ⇒ the user's daily window end. */
  to?: string;
}

/**
 * Fetch the per-activity timeline for one user. Omitting both bounds defaults
 * to the user's `daily` window (today) in their effective timezone.
 */
export function getTimeline(userId: number, range: TimelineRange = {}): Promise<TimelineResponse> {
  const query = new URLSearchParams();
  if (range.from !== undefined) {
    query.set("from", range.from);
  }
  if (range.to !== undefined) {
    query.set("to", range.to);
  }
  const qs = query.toString();
  return apiFetch<TimelineResponse>(
    `/users/${userId}/usage/timeline${qs.length > 0 ? `?${qs}` : ""}`,
  );
}
