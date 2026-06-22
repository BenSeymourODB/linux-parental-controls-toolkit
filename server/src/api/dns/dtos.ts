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

import type { DnsStatus } from "../../transport/adguard/index.js";

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
