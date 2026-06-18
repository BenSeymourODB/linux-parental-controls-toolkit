/**
 * Policy-store data access for the account/device core (#51).
 *
 * Thin, synchronous repository functions over the shared {@link PolicyDb}
 * handle (better-sqlite3 + Drizzle). They carry no HTTP concerns — the `/api`
 * route layer (`api/policy/routes.ts`) maps their results and the
 * {@link isUniqueViolation} signal onto status codes and the shared error
 * envelope. Keeping persistence here honours `CLAUDE.md` → "policy/ — Drizzle
 * schema, policy model, DB access" and #51's "reads and writes go through the
 * policy service over `app.db`".
 *
 * Scope: `User`, `Client`, and the `UserOnClient` link. The remaining policy
 * entities (Activity/ActivityGroup, Budget, Schedule, Exception) land in their
 * own follow-up modules under the #51 umbrella.
 *
 * License boundary: none touched — Drizzle (Apache-2.0) and better-sqlite3
 * (MIT) only.
 */
import { and, eq } from "drizzle-orm";

import type { PolicyDb } from "./db.js";
import { clients, users, usersOnClients } from "./schema.js";

/** A persisted {@link users} row. */
export type UserRow = typeof users.$inferSelect;
/** A persisted {@link clients} row. */
export type ClientRow = typeof clients.$inferSelect;
/** A persisted {@link usersOnClients} link row. */
export type UserOnClientRow = typeof usersOnClients.$inferSelect;

/** Fields accepted when creating a {@link users} row. */
export interface UserCreate {
  displayName: string;
  /** IANA timezone, or `null`/absent to inherit the server default. */
  tz?: string | null | undefined;
}

/** Mutable fields on a {@link users} row; omitted keys are left unchanged. */
export interface UserUpdate {
  displayName?: string | undefined;
  tz?: string | null | undefined;
}

/** Fields accepted when creating a {@link clients} row. */
export interface ClientCreate {
  hostname: string;
  sshUser: string;
}

/** Mutable fields on a {@link clients} row; omitted keys are left unchanged. */
export interface ClientUpdate {
  hostname?: string | undefined;
  sshUser?: string | undefined;
}

/** The link's own attributes (the user/client pair comes from the route). */
export interface LinkUpsert {
  linuxUsername: string;
  linuxUid: number;
}

// --- Users -----------------------------------------------------------------

/** All users, ascending by id. */
export function listUsers(db: PolicyDb): UserRow[] {
  return db.select().from(users).orderBy(users.id).all();
}

/** One user by id, or `undefined` if absent. */
export function getUser(db: PolicyDb, id: number): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** Insert a user and return the stored row. */
export function createUser(db: PolicyDb, input: UserCreate): UserRow {
  return db
    .insert(users)
    .values({ displayName: input.displayName, tz: input.tz ?? null })
    .returning()
    .get();
}

/**
 * Apply a partial update and return the stored row, or `undefined` if no user
 * with `id` exists. `patch` must carry at least one key (the route enforces
 * this); a `tz` of `null` clears the override.
 */
export function updateUser(db: PolicyDb, id: number, patch: UserUpdate): UserRow | undefined {
  return db.update(users).set(patch).where(eq(users.id, id)).returning().get();
}

/** Delete a user (cascading its links). Returns whether a row was removed. */
export function deleteUser(db: PolicyDb, id: number): boolean {
  return db.delete(users).where(eq(users.id, id)).returning({ id: users.id }).get() !== undefined;
}

// --- Clients ---------------------------------------------------------------

/** All clients, ascending by id. */
export function listClients(db: PolicyDb): ClientRow[] {
  return db.select().from(clients).orderBy(clients.id).all();
}

/** One client by id, or `undefined` if absent. */
export function getClient(db: PolicyDb, id: number): ClientRow | undefined {
  return db.select().from(clients).where(eq(clients.id, id)).get();
}

/**
 * Insert a client and return the stored row. Throws the underlying
 * unique-constraint error on a duplicate `hostname` — see
 * {@link isUniqueViolation}.
 */
export function createClient(db: PolicyDb, input: ClientCreate): ClientRow {
  return db
    .insert(clients)
    .values({ hostname: input.hostname, sshUser: input.sshUser })
    .returning()
    .get();
}

/**
 * Apply a partial update and return the stored row, or `undefined` if no client
 * with `id` exists. Throws on a `hostname` collision (see
 * {@link isUniqueViolation}).
 */
export function updateClient(db: PolicyDb, id: number, patch: ClientUpdate): ClientRow | undefined {
  return db.update(clients).set(patch).where(eq(clients.id, id)).returning().get();
}

/** Delete a client (cascading its links). Returns whether a row was removed. */
export function deleteClient(db: PolicyDb, id: number): boolean {
  return (
    db.delete(clients).where(eq(clients.id, id)).returning({ id: clients.id }).get() !== undefined
  );
}

// --- User-on-client links --------------------------------------------------

/** All links for a user, ascending by client id. */
export function listUserLinks(db: PolicyDb, userId: number): UserOnClientRow[] {
  return db
    .select()
    .from(usersOnClients)
    .where(eq(usersOnClients.userId, userId))
    .orderBy(usersOnClients.clientId)
    .all();
}

/**
 * Create or replace the link between `userId` and `clientId` (idempotent on the
 * composite key). Throws on the `(client, linux_uid)` uniqueness collision —
 * i.e. another user already mapped to that UID on the same client (see
 * {@link isUniqueViolation}). The caller is responsible for confirming the user
 * and client exist first (FK violations otherwise surface as opaque errors).
 */
export function upsertLink(
  db: PolicyDb,
  userId: number,
  clientId: number,
  input: LinkUpsert,
): UserOnClientRow {
  return db
    .insert(usersOnClients)
    .values({ userId, clientId, linuxUsername: input.linuxUsername, linuxUid: input.linuxUid })
    .onConflictDoUpdate({
      target: [usersOnClients.userId, usersOnClients.clientId],
      set: { linuxUsername: input.linuxUsername, linuxUid: input.linuxUid },
    })
    .returning()
    .get();
}

/**
 * The ids of every client a user is linked to, ascending. Used by the stub
 * transport (#54) to resolve the clients a user-level policy change would push
 * to — captured *before* a delete, since the links cascade away with the user.
 */
export function listUserClientIds(db: PolicyDb, userId: number): number[] {
  return db
    .select({ clientId: usersOnClients.clientId })
    .from(usersOnClients)
    .where(eq(usersOnClients.userId, userId))
    .orderBy(usersOnClients.clientId)
    .all()
    .map((row) => row.clientId);
}

/** Delete a link. Returns whether a row was removed. */
export function deleteLink(db: PolicyDb, userId: number, clientId: number): boolean {
  return (
    db
      .delete(usersOnClients)
      .where(and(eq(usersOnClients.userId, userId), eq(usersOnClients.clientId, clientId)))
      .returning({ userId: usersOnClients.userId })
      .get() !== undefined
  );
}

/**
 * Whether an error thrown by better-sqlite3 is a UNIQUE/PRIMARY-KEY constraint
 * violation, which the route layer maps to `409 conflict`. Reads `.code`
 * structurally (via `Reflect.get`) so no `as` cast or `any` is needed.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = Reflect.get(err, "code");
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}
