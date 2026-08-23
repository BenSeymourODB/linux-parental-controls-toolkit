/**
 * The `/app` per-child status read (#110), consumed by the signed-in status
 * screen. A thin typed wrapper over {@link apiFetch}, mirroring the other
 * `$lib/api/*` clients: the response type comes from the shared `/api` contract
 * so the frontend never re-declares a DTO.
 *
 * The call is PIN-session-scoped — it needs no user id in the URL because the
 * server serves only `request.pinUser`'s own data. The same-origin PIN cookie
 * rides along automatically (see `$lib/api/client`).
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { AppStatusResponse } from "./contract.js";

/** Fetch the signed-in child's own status (time left, limits, next transition). */
export function fetchAppStatus(): Promise<AppStatusResponse> {
  return apiFetch<AppStatusResponse>("/app/status");
}
