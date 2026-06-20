/**
 * Auth calls for the admin surface (#52 contract, consumed by #53).
 *
 * Login issues the signed session cookie; logout clears it; `fetchSession`
 * reports whether the caller currently holds a valid admin session so the app
 * shell can decide between the login view and the dashboard on first paint and
 * after a hard refresh.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { LoginRequest, SessionResponse } from "./contract.js";

/** Authenticate the admin; on success the session cookie is set by the server. */
export function login(credentials: LoginRequest): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/auth/login", { method: "POST", body: credentials });
}

/** Clear the admin session. Idempotent server-side. */
export function logout(): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/auth/logout", { method: "POST" });
}

/** Report the current session state (drives login-vs-dashboard at startup). */
export function fetchSession(): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/auth/session");
}
