/**
 * DNS-status surface (#95): the route registrar plus the zod DTO and inferred
 * type the frontend consumes. Re-exported from the top-level `api/` barrel so
 * the whole `/api` contract imports from one place.
 */
export { registerDnsRoutes } from "./routes.js";
export {
  dnsModeSchema,
  dnsHealthSchema,
  dnsStatusResponseSchema,
  toDnsStatusResponse,
  type DnsStatusResponse,
} from "./dtos.js";
