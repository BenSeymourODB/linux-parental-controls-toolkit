/**
 * Policy-store data access for client enrolment (#77).
 *
 * Companion to {@link ./repository.ts}: thin, synchronous functions over the
 * shared {@link PolicyDb} for the `enrolment_tokens` table and the one
 * transactional write that turns a redeemed token into an enrolled client.
 * HTTP concerns (status codes, the error envelope, token hashing) stay in the
 * `api/clients` route/service layer — this module only touches the database.
 *
 * License boundary: none touched — Drizzle (Apache-2.0) + better-sqlite3 (MIT).
 */
import { and, eq, isNull } from "drizzle-orm";

import type { PolicyDb } from "./db.js";
import { clients, enrolmentTokens, usersOnClients, type ComponentVersions } from "./schema.js";
import type { ClientRow, UserOnClientRow } from "./repository.js";

/** A persisted {@link enrolmentTokens} row. */
export type EnrolmentTokenRow = typeof enrolmentTokens.$inferSelect;

/** The policy-user ↔ Linux-account mapping the admin binds at mint time. */
export interface SupervisedUserMapping {
  userId: number;
  linuxUsername: string;
}

/** Fields accepted when minting an {@link enrolmentTokens} row. */
export interface EnrolmentTokenCreate {
  /** SHA-256 of the plaintext token (never the plaintext itself). */
  tokenHash: string;
  hostname?: string | null;
  supervisedUsers: SupervisedUserMapping[];
  expiresAt: Date;
}

/** One supervised-user link to create at enrol time (uid supplied by the client). */
export interface EnrolLink {
  userId: number;
  linuxUsername: string;
  linuxUid: number;
}

/** Inputs to the {@link consumeTokenAndEnrol} transaction. */
export interface EnrolWrite {
  hostname: string;
  sshUser: string;
  /** SHA-256 of the per-client bearer token issued at enrolment. */
  bearerTokenHash: string;
  links: EnrolLink[];
  /**
   * Version inventory reported at enrolment (#164). All three move together:
   * `versionsReportedAt` is set by the caller exactly when at least one of
   * `agentVersion` / `componentVersions` is present, so a row never claims to
   * have reported versions it doesn't hold. Omit all three for a client that
   * reported nothing — the columns stay NULL.
   */
  agentVersion?: string | null;
  componentVersions?: ComponentVersions | null;
  versionsReportedAt?: Date | null;
}

/** The rows created by a successful enrolment. */
export interface EnrolResult {
  client: ClientRow;
  links: UserOnClientRow[];
}

/** Insert an enrolment token and return the stored row. */
export function createEnrolmentToken(db: PolicyDb, input: EnrolmentTokenCreate): EnrolmentTokenRow {
  return db
    .insert(enrolmentTokens)
    .values({
      tokenHash: input.tokenHash,
      hostname: input.hostname ?? null,
      supervisedUsers: input.supervisedUsers,
      expiresAt: input.expiresAt,
    })
    .returning()
    .get();
}

/** Look up an enrolment token by its SHA-256 hash, or `undefined` if none. */
export function findEnrolmentTokenByHash(
  db: PolicyDb,
  tokenHash: string,
): EnrolmentTokenRow | undefined {
  return db.select().from(enrolmentTokens).where(eq(enrolmentTokens.tokenHash, tokenHash)).get();
}

/**
 * Redeem a token in a single transaction: create the {@link clients} row (with
 * its bearer-token hash), insert the {@link usersOnClients} links, and mark the
 * token consumed (recording which client it created). Any failure — a duplicate
 * hostname, a duplicate `(client, linux_uid)`, or a vanished user FK — rolls the
 * whole thing back, so a failed enrolment never half-creates a client or burns
 * the token. The caller is responsible for having validated the token's
 * state (unexpired/unconsumed) and that each `userId` still exists first.
 *
 * The consume UPDATE is guarded with `consumed_at IS NULL` and its row count is
 * asserted: although the synchronous request path already serialises the
 * check-then-consume (the service does no `await` between them), this rolls the
 * whole transaction back rather than double-enrolling if the token's state
 * changed under us — defence in depth against a future async refactor.
 * {@link EnrolmentTokenConsumedError} signals that case.
 */
export class EnrolmentTokenConsumedError extends Error {
  constructor() {
    super("enrolment token was already consumed");
    this.name = "EnrolmentTokenConsumedError";
  }
}

export function consumeTokenAndEnrol(
  db: PolicyDb,
  tokenId: number,
  input: EnrolWrite,
): EnrolResult {
  return db.transaction((tx) => {
    const client = tx
      .insert(clients)
      .values({
        hostname: input.hostname,
        sshUser: input.sshUser,
        bearerTokenHash: input.bearerTokenHash,
        agentVersion: input.agentVersion ?? null,
        componentVersions: input.componentVersions ?? null,
        versionsReportedAt: input.versionsReportedAt ?? null,
      })
      .returning()
      .get();

    const links = input.links.map((link) =>
      tx
        .insert(usersOnClients)
        .values({
          userId: link.userId,
          clientId: client.id,
          linuxUsername: link.linuxUsername,
          linuxUid: link.linuxUid,
        })
        .returning()
        .get(),
    );

    const consumed = tx
      .update(enrolmentTokens)
      .set({ consumedAt: new Date(), consumedClientId: client.id })
      .where(and(eq(enrolmentTokens.id, tokenId), isNull(enrolmentTokens.consumedAt)))
      .run();
    if (consumed.changes !== 1) {
      // Token was consumed between the caller's check and here — abort so the
      // client + links insert above roll back with this transaction.
      throw new EnrolmentTokenConsumedError();
    }

    return { client, links };
  });
}
