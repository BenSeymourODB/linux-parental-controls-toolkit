/**
 * Compact human duration formatting, shared by the usage views (#62).
 *
 * Renders a seconds count as `Xh Ym` (dropping a zero hours or zero minutes
 * component), e.g. `5400 → "1h 30m"`, `1800 → "30m"`, `7200 → "2h"`. Negative
 * inputs clamp to zero so a rounding artefact never prints a negative duration.
 */

/** Render `seconds` as a compact `Xh Ym` (or `Ym` / `Xh`). */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  let hours = Math.floor(total / 3600);
  let minutes = Math.round((total - hours * 3600) / 60);
  // A value like 3599s rounds its minutes to 60; carry it into the hours so we
  // never print "0h 60m".
  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }
  if (hours === 0) {
    return `${minutes}m`;
  }
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
