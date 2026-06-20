/**
 * zod DTOs for the client-enrolment surface (#77): the admin "mint a token"
 * request/response and the install script's "enrol" request/response. As with
 * every `/api/*` DTO these are the single contract shared with the SvelteKit
 * frontend and the install script — types are inferred, never hand-written
 * twice (`CLAUDE.md` → "api/ — zod DTOs ...").
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

import { platformSchema } from "../../policy/enums.js";

/** Largest enrolment-token lifetime an admin may request: 24h. */
export const MAX_ENROLMENT_TTL_SECONDS = 24 * 60 * 60;
/** Default enrolment-token lifetime when the admin doesn't specify one: 1h. */
export const DEFAULT_ENROLMENT_TTL_SECONDS = 60 * 60;

/** A Linux login name (mirrors the link DTO in `../policy/dtos.ts`). */
const linuxUsernameSchema = z.string().trim().min(1).max(32);
/** A Linux UID; 0 (root) is representable even if policy would never use it. */
const linuxUidSchema = z.number().int().min(0);
/** A hostname (RFC-1035 max length); also mirrors the client DTO. */
const hostnameSchema = z.string().trim().min(1).max(253);
/** An SSH login name for the `pct-agent` principal. */
const sshUserSchema = z.string().trim().min(1).max(64);
/** A positive integer primary key. */
const positiveIdSchema = z.number().int().positive();

/**
 * A reported software version (#164). Constrained to the Debian version charset
 * (digits, dots, and `-`/`+`/`~`/`:`/`_` for epochs, revisions, and tildes) so
 * a reported value can never contain a `"`/`\`/control char that would break
 * the install script's hand-rolled JSON encoder, nor smuggle free-form text
 * into the inventory. The bounded length keeps a misbehaving client from
 * writing an unbounded blob.
 */
const versionStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._+~:-]+$/, "must be a plain version string");

/**
 * Versions of the managed components a client reports at enrolment (#164).
 * `.strict()` rejects unknown keys so the inventory shape stays typed — a new
 * component is added here deliberately rather than absorbed silently. Every
 * field is optional: a client reports only what it could detect.
 */
export const componentVersionsSchema = z
  .object({
    timekpr: versionStringSchema.optional(),
    e2guardian: versionStringSchema.optional(),
    activitywatch: versionStringSchema.optional(),
  })
  .strict();

export type ComponentVersionsDto = z.infer<typeof componentVersionsSchema>;

/** Reject a list whose `linuxUsername`s are not all distinct. */
function distinctUsernames(list: { linuxUsername: string }[]): boolean {
  return new Set(list.map((entry) => entry.linuxUsername)).size === list.length;
}

const distinctUsernamesMessage = { message: "linuxUsername values must be distinct" };

// --- Mint (admin-guarded) --------------------------------------------------

export const mintEnrolmentTokenSchema = z.object({
  /** The policy-user ↔ Linux-account mapping this client will carry. */
  supervisedUsers: z
    .array(z.object({ userId: positiveIdSchema, linuxUsername: linuxUsernameSchema }))
    .min(1)
    .refine(distinctUsernames, distinctUsernamesMessage),
  /** Token lifetime; defaults to {@link DEFAULT_ENROLMENT_TTL_SECONDS}. */
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(MAX_ENROLMENT_TTL_SECONDS)
    .default(DEFAULT_ENROLMENT_TTL_SECONDS),
  /** Optional expected hostname, recorded for the admin's reference. */
  hostname: hostnameSchema.optional(),
});

export const enrolmentTokenResponseSchema = z.object({
  id: z.number().int(),
  /** The plaintext token — returned **once**; only its hash is stored. */
  token: z.string(),
  expiresAt: z.string(),
});

export type MintEnrolmentTokenRequest = z.infer<typeof mintEnrolmentTokenSchema>;
export type EnrolmentTokenResponse = z.infer<typeof enrolmentTokenResponseSchema>;

// --- Enrol (token-authenticated) -------------------------------------------

export const enrolClientSchema = z.object({
  hostname: hostnameSchema,
  sshUser: sshUserSchema,
  /** Each supervised user's resolved Linux account on this box. */
  supervisedUsers: z
    .array(z.object({ linuxUsername: linuxUsernameSchema, linuxUid: linuxUidSchema }))
    .min(1)
    .refine(distinctUsernames, distinctUsernamesMessage),
  /** The `pct-client` agent `.deb` version this box installed (#164). Optional. */
  agentVersion: versionStringSchema.optional(),
  /** Detected versions of the managed components (#164). Optional. */
  componentVersions: componentVersionsSchema.optional(),
});

export const enrolResponseSchema = z.object({
  clientId: z.number().int(),
  hostname: z.string(),
  sshUser: z.string(),
  /** The per-client bearer token — returned **once**; only its hash is stored. */
  bearerToken: z.string(),
  /** The dashboard's SSH public key to authorize, or `null` if not yet generated. */
  sshPublicKey: z.string().nullable(),
  supervisedUsers: z.array(
    z.object({
      userId: z.number().int(),
      linuxUsername: z.string(),
      linuxUid: z.number().int(),
    }),
  ),
  /** The agent version the server recorded, or `null` if none was reported (#164). */
  agentVersion: z.string().nullable(),
  /** The component versions the server recorded, or `null` if none (#164). */
  componentVersions: componentVersionsSchema.nullable(),
  /**
   * The client's OS family (#229) — always `linux` for now (a Windows
   * enforcement client is the post-Phase-14 epic #233); the enrol request does
   * not set it. Surfaced so the install script and admin UI agree on the value.
   */
  platform: platformSchema,
});

export type EnrolClientRequest = z.infer<typeof enrolClientSchema>;
export type EnrolResponse = z.infer<typeof enrolResponseSchema>;
