/**
 * `/app` child PIN-session calls (#112 contract, consumed by the `/app` login).
 *
 * The child-scoped counterpart to `$lib/api/auth` (the admin session): login by
 * `userId` + PIN issues the signed `pct_pin_session` cookie; logout clears it;
 * `fetchAppSession` reports whether the caller holds a valid PIN session so the
 * `/app` shell can decide between the PIN-entry screen and the status view on
 * first paint and after a hard refresh.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { PinLoginRequest, PinSessionResponse } from "./contract.js";

/** Authenticate a supervised user with their PIN; on success the cookie is set. */
export function pinLogin(credentials: PinLoginRequest): Promise<PinSessionResponse> {
  return apiFetch<PinSessionResponse>("/app/session", { method: "POST", body: credentials });
}

/** Clear the PIN session. Idempotent server-side. */
export function pinLogout(): Promise<PinSessionResponse> {
  return apiFetch<PinSessionResponse>("/app/session", { method: "DELETE" });
}

/** Report the current PIN-session state (drives login-vs-status at startup). */
export function fetchAppSession(): Promise<PinSessionResponse> {
  return apiFetch<PinSessionResponse>("/app/session");
}
