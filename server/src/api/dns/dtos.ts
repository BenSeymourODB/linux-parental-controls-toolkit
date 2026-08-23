/**
 * zod DTO for the DNS-status read API (#95), shared with the frontend (the
 * single `/api/*` contract). Read-only — the active mode is configuration, not
 * a request-mutable resource — so there is no write DTO.
 *
 * The shape mirrors {@link DnsStatus} from `transport/adguard`; the mapper
 * {@link toDnsStatusResponse} is the single conversion point, and its return
 * type makes the two enums (transport `DnsHealth`/`DnsMode` and the schemas
 * here) a compile-time drift guard — they cannot diverge without a type error.
 */
import { z } from "zod";

import type {
  DnsApplySummary,
  DnsBlocklistPlan,
  DnsStatus,
} from "../../transport/adguard/index.js";

/** The configured DNS-filtering mode (`PCT_ADGUARD_MODE`). */
export const dnsModeSchema = z.enum(["disabled", "external", "managed"]);

/** Health of the configured DNS integration, as last observed. */
export const dnsHealthSchema = z.enum([
  "not_applicable",
  "unknown",
  "ok",
  "unreachable",
  "auth_failed",
  "unhealthy",
  "error",
]);

/** Response shape of `GET /api/dns`. */
export const dnsStatusResponseSchema = z.object({
  mode: dnsModeSchema,
  configured: z.boolean(),
  health: dnsHealthSchema,
  baseUrl: z.string().nullable(),
  checkedAt: z.string().nullable(),
  detail: z.string().nullable(),
});

/** The inferred `GET /api/dns` response type, shared with the frontend. */
export type DnsStatusResponse = z.infer<typeof dnsStatusResponseSchema>;

/** Map the transport-layer {@link DnsStatus} snapshot onto the wire contract. */
export function toDnsStatusResponse(status: DnsStatus): DnsStatusResponse {
  return {
    mode: status.mode,
    configured: status.configured,
    health: status.health,
    baseUrl: status.baseUrl,
    checkedAt: status.checkedAt,
    detail: status.detail,
  };
}

/** One device's composed blocklist as returned by the preview (#97). */
export const dnsBlocklistClientSchema = z.object({
  /** The `pct:`-prefixed AdGuard client name. */
  name: z.string(),
  /** The device's reported IPs (the AdGuard client `ids`), sorted. */
  ids: z.array(z.string()),
  /** Domains always-on denied for this device, sorted. */
  domains: z.array(z.string()),
});

/** A device with denies that cannot be enforced over DNS, and why. */
export const dnsBlocklistSkippedSchema = z.object({
  clientId: z.number().int(),
  name: z.string(),
  label: z.string(),
  reason: z.literal("no_reported_ips"),
  domains: z.array(z.string()),
});

/** Response of `GET /api/dns/blocklist` — what an apply *would* push, plus applyability. */
export const dnsBlocklistPreviewResponseSchema = z.object({
  /** The configured DNS mode. */
  mode: dnsModeSchema,
  /** Whether an apply can run now (a REST client is wired for the active mode). */
  applyable: z.boolean(),
  /** When not applyable, why; else `null`. */
  detail: z.string().nullable(),
  /** Enforceable per-device blocklists. */
  clients: z.array(dnsBlocklistClientSchema),
  /** Devices with denies but no reported IP to target. */
  skipped: z.array(dnsBlocklistSkippedSchema),
});

/** The inferred `GET /api/dns/blocklist` response type, shared with the frontend. */
export type DnsBlocklistPreviewResponse = z.infer<typeof dnsBlocklistPreviewResponseSchema>;

/** Response of `POST /api/dns/blocklist/apply` — what the apply did. */
export const dnsBlocklistApplyResponseSchema = z.object({
  clientsManaged: z.number().int(),
  skipped: z.number().int(),
  ruleCount: z.number().int(),
  rulesChanged: z.boolean(),
  clients: z.object({
    added: z.number().int(),
    updated: z.number().int(),
    deleted: z.number().int(),
    unchanged: z.number().int(),
  }),
});

/** The inferred `POST /api/dns/blocklist/apply` response type, shared with the frontend. */
export type DnsBlocklistApplyResponse = z.infer<typeof dnsBlocklistApplyResponseSchema>;

/**
 * A human reason a device cannot be pushed to right now, from the DNS status —
 * used as the preview `detail` and the `409` message when apply is refused.
 */
export function notApplyableDetail(status: DnsStatus): string {
  if (status.mode === "disabled") {
    return "DNS filtering is disabled (set PCT_ADGUARD_MODE to external or managed).";
  }
  return status.detail ?? "the AdGuard instance is not reachable yet";
}

/** Map a composition {@link DnsBlocklistPlan} + status onto the preview contract. */
export function toDnsBlocklistPreviewResponse(
  status: DnsStatus,
  plan: DnsBlocklistPlan,
  applyable: boolean,
): DnsBlocklistPreviewResponse {
  return {
    mode: status.mode,
    applyable,
    detail: applyable ? null : notApplyableDetail(status),
    clients: plan.clients.map((entry) => ({
      name: entry.name,
      ids: entry.ids,
      domains: entry.domains,
    })),
    skipped: plan.skipped.map((entry) => ({
      clientId: entry.clientId,
      name: entry.name,
      label: entry.label,
      reason: entry.reason,
      domains: entry.domains,
    })),
  };
}

/** Map an {@link DnsApplySummary} onto the apply-response contract. */
export function toDnsBlocklistApplyResponse(summary: DnsApplySummary): DnsBlocklistApplyResponse {
  return {
    clientsManaged: summary.clientsManaged,
    skipped: summary.skipped,
    ruleCount: summary.ruleCount,
    rulesChanged: summary.rulesChanged,
    clients: {
      added: summary.clients.added,
      updated: summary.clients.updated,
      deleted: summary.clients.deleted,
      unchanged: summary.clients.unchanged,
    },
  };
}
