/**
 * zod schemas for the AdGuard Home `/control/*` REST responses this client
 * consumes, plus the TypeScript shapes for the request bodies it sends.
 *
 * Everything AdGuard returns is untrusted external input and is validated here
 * before it crosses into typed code (`CLAUDE.md` → "Validate all external
 * input"). We validate only the fields the dashboard actually uses; zod strips
 * unknown keys by default, so AdGuard adding or renaming fields we don't read
 * never breaks us.
 *
 * Request bodies are plain TS interfaces, **not** zod schemas: we send the
 * caller's object verbatim (we validate what comes *in*, not our own outbound),
 * so a client object read from AdGuard, modified, and written back never loses
 * fields a newer AdGuard version added. The interfaces carry an index signature
 * for exactly that round-trip safety.
 */
import { z } from "zod";

/**
 * `GET /control/status` — instance identity and protection state. The dashboard
 * reads this for the `external`-mode preflight (#95) and the admin "active
 * mode" surface (#97). Only the always-present fields are required; the rest
 * (ports, addresses) are validated-if-present and otherwise ignored.
 */
export const adGuardStatusSchema = z.object({
  version: z.string(),
  running: z.boolean(),
  protection_enabled: z.boolean(),
  dns_addresses: z.array(z.string()).optional(),
  dns_port: z.number().optional(),
  http_port: z.number().optional(),
  language: z.string().optional(),
  dhcp_available: z.boolean().optional(),
});

/** Inferred AdGuard instance status. */
export type AdGuardStatus = z.infer<typeof adGuardStatusSchema>;

/**
 * One persistent client as returned by `GET /control/clients`. A client is an
 * AdGuard-side network identity (by IP/MAC/CIDR/ClientID in {@link ids}). Only
 * `name`/`ids` are required; the per-client filtering toggles and
 * blocked-services list are validated-if-present.
 */
export const adGuardClientSchema = z.object({
  name: z.string(),
  ids: z.array(z.string()),
  use_global_settings: z.boolean().optional(),
  filtering_enabled: z.boolean().optional(),
  parental_enabled: z.boolean().optional(),
  safebrowsing_enabled: z.boolean().optional(),
  use_global_blocked_services: z.boolean().optional(),
  blocked_services: z.array(z.string()).optional(),
  upstreams: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

/** Inferred persistent client (the validated read shape). */
export type AdGuardClient = z.infer<typeof adGuardClientSchema>;

/**
 * `GET /control/clients` — persistent clients plus runtime-discovered
 * `auto_clients` and the server's `supported_tags`. We only consume the
 * persistent `clients`; the other two are accepted (validated-if-present) but
 * not surfaced. A missing `clients` key validates as an empty list.
 */
export const adGuardClientsResponseSchema = z.object({
  clients: z
    .array(adGuardClientSchema)
    .nullish()
    .transform((value) => value ?? []),
  auto_clients: z.array(z.unknown()).optional(),
  supported_tags: z.array(z.string()).optional(),
});

/** Inferred clients listing. */
export type AdGuardClientsResponse = z.infer<typeof adGuardClientsResponseSchema>;

/**
 * `GET /control/filtering/status` — global filtering state. The dashboard reads
 * `user_rules` (the custom-rules list) to compose per-client blocklists (#97);
 * the rest is validated-if-present. A missing `user_rules` validates as empty.
 */
export const adGuardFilteringStatusSchema = z.object({
  enabled: z.boolean().optional(),
  interval: z.number().optional(),
  user_rules: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
});

/** Inferred filtering status. */
export type AdGuardFilteringStatus = z.infer<typeof adGuardFilteringStatusSchema>;

/**
 * The request-body shape for `POST /control/clients/add` and the `data` of
 * `POST /control/clients/update`. Sent verbatim; the index signature preserves
 * any AdGuard fields the caller round-trips that this type does not name.
 */
export interface AdGuardClientInput {
  /** The client name — must carry the dashboard's `pct:` prefix (enforced). */
  name: string;
  /** Network identities (IP/MAC/CIDR/ClientID) this client matches. */
  ids: string[];
  /** Any other AdGuard client fields, preserved on round-trip. */
  [key: string]: unknown;
}
