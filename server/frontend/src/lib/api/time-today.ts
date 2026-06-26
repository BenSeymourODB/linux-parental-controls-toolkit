/**
 * Call for the "Add time today" same-day adjustment lever (#257).
 *
 * Same proven shape as the other `$lib/api/*` wrappers: a thin typed wrapper
 * over {@link apiFetch}, with the request/response types imported from the
 * shared `/api` contract so the frontend never re-declares a DTO. This adjusts a
 * user's *remaining time for today* on their linked client(s) via the server's
 * `timekpra --settimeleft` transport, without changing the standing daily
 * `Budget`. It is an online-only nudge: the response reports a per-client
 * `applied | unreachable | failed` outcome (offline clients are not queued).
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { AdjustTimeTodayRequest, TimeTodayResponse } from "./contract.js";

/**
 * Adjust `userId`'s remaining time for today. The body carries exactly one of
 * `deltaSeconds` (signed, non-zero — `+1800` = "+30 min") or `setSeconds`
 * (absolute — `0` = lock out now), plus an optional `clientId` to restrict the
 * adjustment to one linked client. Returns the resolved op + per-client results.
 */
export function adjustTimeToday(
  userId: number,
  input: AdjustTimeTodayRequest,
): Promise<TimeTodayResponse> {
  return apiFetch<TimeTodayResponse>(`/users/${userId}/time-today`, {
    method: "POST",
    body: input,
  });
}
