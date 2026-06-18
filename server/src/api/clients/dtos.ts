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
});

export type EnrolClientRequest = z.infer<typeof enrolClientSchema>;
export type EnrolResponse = z.infer<typeof enrolResponseSchema>;
