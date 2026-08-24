/**
 * Enrolment orchestration (#77): the logic the `clients` routes delegate to,
 * sitting between the HTTP layer and the policy store. It validates inputs
 * against existing policy state, hashes the bearer secrets, and maps failures
 * onto {@link ApiError}s in the shared envelope. Persistence lives in
 * `policy/enrolment.ts`; token hashing in `auth/secret-token.ts`.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyBaseLogger } from "fastify";

import { generateToken, hashToken } from "../../auth/secret-token.js";
import type { PolicyDb } from "../../policy/db.js";
import type { Platform } from "../../policy/enums.js";
import * as enrolmentRepo from "../../policy/enrolment.js";
import * as repo from "../../policy/repository.js";
import type { ComponentVersions } from "../../policy/schema.js";
import { ApiError } from "../errors.js";
import type {
  EnrolClientRequest,
  MintEnrolmentTokenRequest,
  TimekprMirrorAdvertisement,
} from "./dtos.js";
import { loadServerSshPublicKey } from "./ssh-identity.js";

/** What {@link mintEnrolmentToken} hands back to the route (token shown once). */
export interface MintResult {
  id: number;
  token: string;
  expiresAt: Date;
}

/** What {@link enrolClient} hands back to the route (bearer token shown once). */
export interface EnrolServiceResult {
  clientId: number;
  hostname: string;
  sshUser: string;
  bearerToken: string;
  sshPublicKey: string | null;
  supervisedUsers: { userId: number; osUsername: string; osUserRef: string }[];
  /** The agent version recorded at enrolment, or `null` if none reported (#164). */
  agentVersion: string | null;
  /** The component versions recorded at enrolment, or `null` if none (#164). */
  componentVersions: ComponentVersions | null;
  /** The client's OS family (#229) — `linux` today; the enrol request never sets it. */
  platform: Platform;
  /** Where/how to get `timekpr-next` — the advertised mirror coordinates (#393). */
  timekprMirror: TimekprMirrorAdvertisement;
}

/**
 * Normalise the optional version inventory a client reported (#164) into the
 * three columns the enrolment write expects. An empty `componentVersions`
 * object (every field absent) counts as "nothing reported", so it does not on
 * its own set `versionsReportedAt`. `versionsReportedAt` is the timestamp iff
 * at least one version is present, keeping the trio internally consistent.
 */
export function resolveReportedVersions(input: {
  agentVersion?: string | undefined;
  componentVersions?: ComponentVersions | undefined;
}): {
  agentVersion: string | null;
  componentVersions: ComponentVersions | null;
  versionsReportedAt: Date | null;
} {
  const agentVersion = input.agentVersion ?? null;
  const components = input.componentVersions;
  const componentVersions =
    components !== undefined && Object.values(components).some((v) => v !== undefined)
      ? components
      : null;
  const reported = agentVersion !== null || componentVersions !== null;
  return {
    agentVersion,
    componentVersions,
    versionsReportedAt: reported ? new Date() : null,
  };
}

/**
 * Mint a single-use enrolment token bound to `input.supervisedUsers`. Every
 * referenced policy `userId` must already exist (404 otherwise) so the admin
 * can't bind a token to a phantom user. Returns the plaintext token once; only
 * its hash is persisted.
 */
export function mintEnrolmentToken(db: PolicyDb, input: MintEnrolmentTokenRequest): MintResult {
  for (const entry of input.supervisedUsers) {
    if (repo.getUser(db, entry.userId) === undefined) {
      throw new ApiError(404, "not_found", `User ${entry.userId} not found`);
    }
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  const row = enrolmentRepo.createEnrolmentToken(db, {
    tokenHash: hashToken(token),
    hostname: input.hostname ?? null,
    friendlyName: input.friendlyName ?? null,
    supervisedUsers: input.supervisedUsers,
    expiresAt,
  });

  return { id: row.id, token, expiresAt: row.expiresAt };
}

/** Options threaded into {@link enrolClient} from the route. */
export interface EnrolOptions {
  /** Path to the server's SSH public key (`settings.sshPublicKeyPath`). */
  sshPublicKeyPath: string;
  /** Request logger, used to warn if the SSH key is present but unreadable. */
  log: FastifyBaseLogger;
  /**
   * The observed source IP of the enrol request (`request.ip`), recorded as a
   * self-report-free ground truth of what reached the server (#355). `null`
   * when the route couldn't determine one (e.g. a synthetic/injected call).
   */
  sourceIp?: string | null;
  /**
   * The `timekpr-next` mirror advertisement to return (#393), resolved by the
   * route from `settings.timekprMirror` + the mirror's current on-disk state.
   * Threaded in (rather than read here) so the service stays disk-free.
   */
  timekprMirror: TimekprMirrorAdvertisement;
}

/**
 * Redeem an enrolment token and register the client. The bearer enrolment token
 * (from the `Authorization` header) is validated by hash lookup; a missing,
 * expired, or already-consumed token is a `401`. The request's supervised-user
 * set must exactly match the set the token was minted for (`400` otherwise),
 * and every bound user must still exist (`409` if one was deleted since mint).
 * On success the client + links are created and the token consumed in one
 * transaction, a per-client bearer token is issued (returned once), and the
 * server SSH public key is included when available.
 */
export function enrolClient(
  db: PolicyDb,
  bearerEnrolmentToken: string,
  input: EnrolClientRequest,
  options: EnrolOptions,
): EnrolServiceResult {
  const tokenRow = enrolmentRepo.findEnrolmentTokenByHash(db, hashToken(bearerEnrolmentToken));
  if (tokenRow === undefined) {
    options.log.warn(
      { event: "enrol_rejected", reason: "invalid_token" },
      "client enrolment rejected",
    );
    throw new ApiError(401, "enrolment_token_invalid", "Unknown or invalid enrolment token");
  }
  if (tokenRow.consumedAt !== null) {
    options.log.warn(
      { event: "enrol_rejected", reason: "used_token", tokenId: tokenRow.id },
      "client enrolment rejected",
    );
    throw new ApiError(401, "enrolment_token_used", "This enrolment token has already been used");
  }
  // `expires_at` is stored at second granularity, so a token can read as expired
  // up to ~1s early; harmless for the minute-to-hours TTLs in use.
  if (tokenRow.expiresAt.getTime() <= Date.now()) {
    options.log.warn(
      { event: "enrol_rejected", reason: "expired_token", tokenId: tokenRow.id },
      "client enrolment rejected",
    );
    throw new ApiError(401, "enrolment_token_expired", "This enrolment token has expired");
  }

  // Join the minted mapping (userId ↔ osUsername) with the request's
  // (osUsername ↔ osUserRef) on osUsername; the sets must match exactly so
  // the client can neither drop a bound user nor smuggle in an extra one.
  const requestByName = new Map(input.supervisedUsers.map((entry) => [entry.osUsername, entry]));
  const minted = tokenRow.supervisedUsers;
  const mismatch =
    minted.length !== input.supervisedUsers.length ||
    minted.some((entry) => !requestByName.has(entry.osUsername));
  if (mismatch) {
    throw new ApiError(
      400,
      "enrolment_user_mismatch",
      "Supervised users do not match the ones this enrolment token was minted for",
    );
  }

  const links: enrolmentRepo.EnrolLink[] = minted.map((entry) => {
    const requested = requestByName.get(entry.osUsername);
    if (requested === undefined) {
      // Unreachable given the exact-match check above, but keeps the map access
      // total without a non-null assertion.
      throw new ApiError(400, "enrolment_user_mismatch", "Supervised user set mismatch");
    }
    if (repo.getUser(db, entry.userId) === undefined) {
      throw new ApiError(409, "user_no_longer_exists", `User ${entry.userId} no longer exists`);
    }
    return {
      userId: entry.userId,
      osUsername: entry.osUsername,
      osUserRef: requested.osUserRef,
    };
  });

  const versions = resolveReportedVersions(input);
  const bearerToken = generateToken();
  let result: enrolmentRepo.EnrolResult;
  try {
    result = enrolmentRepo.consumeTokenAndEnrol(db, tokenRow.id, {
      hostname: input.hostname,
      // The admin picks the friendly name at mint time; carry it from the token
      // onto the client so the card has a recognisable title from first sight.
      friendlyName: tokenRow.friendlyName,
      sshUser: input.sshUser,
      bearerTokenHash: hashToken(bearerToken),
      links,
      // Normalise an omitted or empty list to null so "no addresses reported"
      // has a single wire shape (null), never a stray `[]`.
      reportedIps: input.reportedIps && input.reportedIps.length > 0 ? input.reportedIps : null,
      sourceIp: options.sourceIp ?? null,
      agentVersion: versions.agentVersion,
      componentVersions: versions.componentVersions,
      versionsReportedAt: versions.versionsReportedAt,
    });
  } catch (err) {
    if (err instanceof enrolmentRepo.EnrolmentTokenConsumedError) {
      // Lost a race for the same token (not reachable on today's synchronous
      // path; the data-layer guard makes it safe regardless).
      options.log.warn(
        { event: "enrol_rejected", reason: "used_token", tokenId: tokenRow.id },
        "client enrolment rejected",
      );
      throw new ApiError(401, "enrolment_token_used", "This enrolment token has already been used");
    }
    if (repo.isUniqueViolation(err)) {
      throw new ApiError(
        409,
        "conflict",
        `Client "${input.hostname}" is already enrolled, or an OS account reference is duplicated for it`,
      );
    }
    throw err;
  }

  options.log.info(
    { event: "client_enrolled", clientId: result.client.id, hostname: result.client.hostname },
    "client enrolled",
  );
  return {
    clientId: result.client.id,
    hostname: result.client.hostname,
    sshUser: result.client.sshUser,
    bearerToken,
    sshPublicKey: readSshPublicKey(options),
    supervisedUsers: result.links.map((link) => ({
      userId: link.userId,
      osUsername: link.osUsername,
      osUserRef: link.osUserRef,
    })),
    agentVersion: result.client.agentVersion,
    componentVersions: result.client.componentVersions,
    platform: result.client.platform,
    timekprMirror: options.timekprMirror,
  };
}

/**
 * Read the server SSH public key, degrading to `null` on any failure so a key
 * problem never breaks an otherwise-valid enrolment. A genuinely unexpected
 * read error (not "file absent") is logged at warn level for the operator.
 */
function readSshPublicKey(options: EnrolOptions): string | null {
  try {
    return loadServerSshPublicKey(options.sshPublicKeyPath);
  } catch (err) {
    options.log.warn(
      { err, path: options.sshPublicKeyPath },
      "could not read server SSH public key for enrolment; returning null",
    );
    return null;
  }
}
