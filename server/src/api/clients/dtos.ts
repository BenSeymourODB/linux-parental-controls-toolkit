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

/** A local OS login name (mirrors the link DTO in `../policy/dtos.ts`). */
const osUsernameSchema = z.string().trim().min(1).max(32);
/**
 * An OS account reference — a uid on Linux, a SID on Windows (#230). A string
 * so the published contract is stable across platforms; the charset (like
 * {@link versionStringSchema}) forbids `"`/`\`/control chars so a value can
 * never break the install script's hand-rolled JSON encoder. On Linux this
 * carries the numeric uid as a decimal string (`"0"` for root is permitted at
 * the type level even if policy would never map a supervised user to it).
 */
const osUserRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "must be an OS account reference (a uid on Linux, a SID on Windows)",
  );
/** A hostname (RFC-1035 max length); also mirrors the client DTO. */
const hostnameSchema = z.string().trim().min(1).max(253);
/** An SSH login name for the `pct-agent` principal. */
const sshUserSchema = z.string().trim().min(1).max(64);
/**
 * A human-friendly admin label for a client, e.g. "kids' living-room PC"
 * (#355). Free-form: it travels only server-side (the mint form → the token →
 * the client row), never through the install script's hand-rolled JSON encoder,
 * so unlike {@link osUserRefSchema} it is not charset-constrained — only trimmed
 * and length-bounded. Fastify/zod escape it on the way back out as JSON.
 */
const friendlyNameSchema = z.string().trim().min(1).max(100);
/**
 * A self-reported client IP address (#355). Constrained to the IPv4/IPv6
 * literal charset (hex digits, `.`, `:`, and `%` for a link-local zone id) so a
 * reported value can never carry a `"`/`\`/control char that would break the
 * install script's hand-rolled JSON encoder, and length-bounded so a
 * misbehaving client can't write a blob. Deliberately *not* validated as a
 * fully-parseable address — it is advisory metadata for admin identification,
 * never an SSH target in this slice — only constrained to be safe to store and
 * echo.
 */
const reportedIpSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Fa-f.:%]+$/, "must be an IPv4/IPv6 address literal");
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

/** Reject a list whose `osUsername`s are not all distinct. */
function distinctUsernames(list: { osUsername: string }[]): boolean {
  return new Set(list.map((entry) => entry.osUsername)).size === list.length;
}

const distinctUsernamesMessage = { message: "osUsername values must be distinct" };

// --- Mint (admin-guarded) --------------------------------------------------

export const mintEnrolmentTokenSchema = z.object({
  /** The policy-user ↔ OS-account mapping this client will carry. */
  supervisedUsers: z
    .array(z.object({ userId: positiveIdSchema, osUsername: osUsernameSchema }))
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
  /**
   * Optional admin-chosen friendly name (#355), applied to the client row at
   * claim time. Reframes the mint form's former "Expected hostname" input into
   * a recognisable label the admin picks up front.
   */
  friendlyName: friendlyNameSchema.optional(),
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
  /** Each supervised user's resolved OS account on this box. */
  supervisedUsers: z
    .array(z.object({ osUsername: osUsernameSchema, osUserRef: osUserRefSchema }))
    .min(1)
    .refine(distinctUsernames, distinctUsernamesMessage),
  /** The `pct-client` agent `.deb` version this box installed (#164). Optional. */
  agentVersion: versionStringSchema.optional(),
  /** Detected versions of the managed components (#164). Optional. */
  componentVersions: componentVersionsSchema.optional(),
  /**
   * The client's own primary IPv4/IPv6 address(es) as it detected them (#355).
   * Advisory metadata for admin identification; each is charset-constrained and
   * the list is bounded (see {@link reportedIpSchema}). Optional — a client that
   * couldn't detect any simply omits it.
   */
  reportedIps: z.array(reportedIpSchema).max(16).optional(),
});

/**
 * The managed `timekpr-next` mirror coordinates advertised to a client at enrol
 * (#393, epic #389), mirroring the server's own `disabled | external | managed`
 * config trichotomy so the client knows where to get the package without a
 * `launchpad.net` round-trip (ADR 0011). The client baseline installer (#394)
 * consumes this to point apt at the dashboard.
 */
export const timekprMirrorAdvertisementSchema = z.discriminatedUnion("mode", [
  /** No mirror: the client installs from the distro repo (the PPA stays opt-in). */
  z.object({ mode: z.literal("disabled") }),
  /** The homelab hosts its own apt repo; the client points apt straight at `url`. */
  z.object({ mode: z.literal("external"), url: z.url() }),
  z.object({
    mode: z.literal("managed"),
    /**
     * The stable LAN URL path root the dashboard serves the mirror at, relative
     * to the client's `--server-url` (e.g. `/apt/timekpr`). Advertised rather
     * than hardcoded on the client so the serving path stays server-owned.
     */
    aptPath: z.string().min(1),
    /** The upstream package/channel served (`timekpr-next` / `timekpr-next-beta`). */
    package: z.string().min(1),
    /**
     * The version currently cached and served, or `null` before the refresh job
     * has fetched one — in which case the client falls back to the distro/PPA
     * path (#394) rather than waiting on the mirror.
     */
    version: z.string().min(1).nullable(),
    /** The `.deb` filename to download under `aptPath`, or `null` (see `version`). */
    debFilename: z.string().min(1).nullable(),
  }),
]);
export type TimekprMirrorAdvertisement = z.infer<typeof timekprMirrorAdvertisementSchema>;

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
      osUsername: z.string(),
      osUserRef: z.string(),
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
  /**
   * Where and how to get `timekpr-next` (#393): the server-configured mirror
   * mode + coordinates, so the client can install without a Launchpad
   * round-trip. `{ mode: "disabled" }` on a default deployment.
   */
  timekprMirror: timekprMirrorAdvertisementSchema,
});

export type EnrolClientRequest = z.infer<typeof enrolClientSchema>;
export type EnrolResponse = z.infer<typeof enrolResponseSchema>;
