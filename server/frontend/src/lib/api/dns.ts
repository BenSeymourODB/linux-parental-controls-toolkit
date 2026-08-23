/**
 * Calls for the DNS-filtering API: the active-mode status (#95) and the
 * per-client domain blocklist preview/apply (#97).
 *
 * Thin typed wrappers over {@link apiFetch}, with the response types imported
 * from the shared `/api` contract so the frontend never re-declares a DTO. All
 * writes go through `/api/*` → the AdGuard REST client server-side; the UI never
 * talks to AdGuard directly (`CLAUDE.md` → "License boundaries").
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  DnsBlocklistApplyResponse,
  DnsBlocklistPreviewResponse,
  DnsStatusResponse,
} from "./contract.js";

/** The active DNS mode + last-observed health. */
export function fetchDnsStatus(): Promise<DnsStatusResponse> {
  return apiFetch<DnsStatusResponse>("/dns");
}

/** Preview the per-device blocklist an apply would push, plus whether it can run now. */
export function fetchDnsBlocklist(): Promise<DnsBlocklistPreviewResponse> {
  return apiFetch<DnsBlocklistPreviewResponse>("/dns/blocklist");
}

/** Reconcile the managed AdGuard clients and push the composed rules. */
export function applyDnsBlocklist(): Promise<DnsBlocklistApplyResponse> {
  return apiFetch<DnsBlocklistApplyResponse>("/dns/blocklist/apply", { method: "POST" });
}
