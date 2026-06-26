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
 * Scope: `User`, `Client`, the `UserOnClient` link (slice 1, #51), and the
 * `Activity` / `ActivityGroup` (+ membership) / `Budget` / `Schedule` /
 * `Exception` entities (slice 2, #148), the latter two against the recurrence +
 * date-scoping shape finalized in #146.
 *
 * License boundary: none touched — Drizzle (Apache-2.0) and better-sqlite3
 * (MIT) only.
 */
import { and, eq } from "drizzle-orm";

import type { PolicyDb } from "./db.js";
import type {
  ActivityKind,
  BudgetWindow,
  MatchType,
  RetentionCategory,
  ScheduleAction,
  Scope,
  SoundProfile,
} from "./enums.js";
import type { ResolvedRetention } from "./retention.js";
import { reorder } from "./schedule-precedence.js";
import {
  activities,
  activitiesToGroups,
  activityGroups,
  budgets,
  clients,
  exceptions,
  groupExceptions,
  groupSchedules,
  notificationPolicies,
  retentionOverrides,
  schedules,
  userGroupMemberships,
  userGroups,
  users,
  usersOnClients,
} from "./schema.js";

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
  osUsername: string;
  /** OS account reference: a uid on Linux, a SID on Windows (#230). */
  osUserRef: string;
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

/**
 * Find the client whose per-client bearer token hashes to `tokenHash`, or
 * `undefined`. The credential the Phase-8b event stream (`/api/events/stream`,
 * #100) authenticates against; the SHA-256 hash is the stored form (#77), and
 * `clients_bearer_token_hash_unique` makes the match single-row. Clients with
 * no bearer token (admin-CRUD, `bearer_token_hash IS NULL`) never match a real
 * hash, so they cannot be impersonated by an empty credential.
 */
export function findClientByBearerTokenHash(
  db: PolicyDb,
  tokenHash: string,
): ClientRow | undefined {
  return db.select().from(clients).where(eq(clients.bearerTokenHash, tokenHash)).get();
}

/**
 * Record that the dashboard just heard from a client — the event-stream
 * connect/disconnect liveness signal (#100). `last_seen` is a system-managed
 * column (not in {@link ClientUpdate}), so this writes it directly. A no-op if
 * no client with `id` exists.
 */
export function touchClientLastSeen(db: PolicyDb, id: number, at: Date): void {
  db.update(clients).set({ lastSeen: at }).where(eq(clients.id, id)).run();
}

/**
 * Record that the client was confirmed reachable at `at`, returning the updated
 * row (or `undefined` if it no longer exists). Kept separate from
 * {@link updateClient}: `last_seen` is a system observation written by the
 * transport/health paths (#81), not an admin-editable field, so it stays out of
 * {@link ClientUpdate}.
 */
export function recordClientLastSeen(db: PolicyDb, id: number, at: Date): ClientRow | undefined {
  return db.update(clients).set({ lastSeen: at }).where(eq(clients.id, id)).returning().get();
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

/** All links for a client, ascending by user id (inverse of {@link listUserLinks}). */
export function listClientLinks(db: PolicyDb, clientId: number): UserOnClientRow[] {
  return db
    .select()
    .from(usersOnClients)
    .where(eq(usersOnClients.clientId, clientId))
    .orderBy(usersOnClients.userId)
    .all();
}

/**
 * Create or replace the link between `userId` and `clientId` (idempotent on the
 * composite key). Throws on the `(client, os_user_ref)` uniqueness collision —
 * i.e. another user already mapped to that OS account reference on the same
 * client (see {@link isUniqueViolation}). The caller is responsible for
 * confirming the user and client exist first (FK violations otherwise surface
 * as opaque errors).
 */
export function upsertLink(
  db: PolicyDb,
  userId: number,
  clientId: number,
  input: LinkUpsert,
): UserOnClientRow {
  return db
    .insert(usersOnClients)
    .values({ userId, clientId, osUsername: input.osUsername, osUserRef: input.osUserRef })
    .onConflictDoUpdate({
      target: [usersOnClients.userId, usersOnClients.clientId],
      set: { osUsername: input.osUsername, osUserRef: input.osUserRef },
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

/**
 * Delete a link, returning the **removed** row, or `undefined` if there was no
 * such link. Returning the row (rather than a bare boolean) lets the caller read
 * the `os_username` it carried *before* it cascaded away — the unlink push
 * (#253) needs that name to "unmanage" the account's `timekpra` config on the
 * client, where there is no longer a link row to resolve it from.
 */
export function deleteLink(
  db: PolicyDb,
  userId: number,
  clientId: number,
): UserOnClientRow | undefined {
  return db
    .delete(usersOnClients)
    .where(and(eq(usersOnClients.userId, userId), eq(usersOnClients.clientId, clientId)))
    .returning()
    .get();
}

// --- User groups -----------------------------------------------------------

/** A persisted {@link userGroups} row. */
export type UserGroupRow = typeof userGroups.$inferSelect;
/** A persisted {@link userGroupMemberships} row. */
export type UserGroupMembershipRow = typeof userGroupMemberships.$inferSelect;

/** Fields accepted when creating a {@link userGroups} row. */
export interface UserGroupCreate {
  name: string;
}

/** Mutable fields on a {@link userGroups} row; omitted keys are left unchanged. */
export interface UserGroupUpdate {
  name?: string | undefined;
}

/** All user groups, ascending by id. */
export function listUserGroups(db: PolicyDb): UserGroupRow[] {
  return db.select().from(userGroups).orderBy(userGroups.id).all();
}

/** One user group by id, or `undefined` if absent. */
export function getUserGroup(db: PolicyDb, id: number): UserGroupRow | undefined {
  return db.select().from(userGroups).where(eq(userGroups.id, id)).get();
}

/**
 * Insert a user group and return the stored row. Throws the underlying
 * unique-constraint error on a duplicate `name` — see {@link isUniqueViolation}.
 */
export function createUserGroup(db: PolicyDb, input: UserGroupCreate): UserGroupRow {
  return db.insert(userGroups).values({ name: input.name }).returning().get();
}

/**
 * Apply a partial update and return the stored row, or `undefined` if no group
 * with `id` exists. Throws on a `name` collision (see {@link isUniqueViolation}).
 */
export function updateUserGroup(
  db: PolicyDb,
  id: number,
  patch: UserGroupUpdate,
): UserGroupRow | undefined {
  return db.update(userGroups).set(patch).where(eq(userGroups.id, id)).returning().get();
}

/**
 * Delete a user group. Returns whether a row was removed. Its memberships
 * cascade away (`user_group_memberships.group_id` ON DELETE CASCADE); any
 * group-targeted schedules/exceptions cascade with it once those land
 * (Phase 3, #124).
 */
export function deleteUserGroup(db: PolicyDb, id: number): boolean {
  return (
    db.delete(userGroups).where(eq(userGroups.id, id)).returning({ id: userGroups.id }).get() !==
    undefined
  );
}

// --- User-group membership (users ↔ user_groups M2M) -----------------------

/** The users in a group, ascending by user id. */
export function listGroupMembers(db: PolicyDb, groupId: number): UserRow[] {
  return db
    .select({
      id: users.id,
      displayName: users.displayName,
      tz: users.tz,
      createdAt: users.createdAt,
    })
    .from(userGroupMemberships)
    .innerJoin(users, eq(userGroupMemberships.userId, users.id))
    .where(eq(userGroupMemberships.groupId, groupId))
    .orderBy(users.id)
    .all();
}

/** The groups a user belongs to, ascending by group id. */
export function listUserGroupsForUser(db: PolicyDb, userId: number): UserGroupRow[] {
  return db
    .select({
      id: userGroups.id,
      name: userGroups.name,
      createdAt: userGroups.createdAt,
    })
    .from(userGroupMemberships)
    .innerJoin(userGroups, eq(userGroupMemberships.groupId, userGroups.id))
    .where(eq(userGroupMemberships.userId, userId))
    .orderBy(userGroups.id)
    .all();
}

/**
 * Whether a user is a member of a group. Lets the route layer return a precise
 * `404` on an attempt to remove a non-membership.
 */
export function isUserGroupMember(db: PolicyDb, groupId: number, userId: number): boolean {
  return (
    db
      .select({ userId: userGroupMemberships.userId })
      .from(userGroupMemberships)
      .where(
        and(eq(userGroupMemberships.groupId, groupId), eq(userGroupMemberships.userId, userId)),
      )
      .get() !== undefined
  );
}

/**
 * Add a user to a group, idempotently (a repeated add is a no-op, not a
 * conflict — mirrors {@link addActivityToGroup}). The caller is responsible for
 * confirming both ends exist first; FK violations otherwise surface as opaque
 * errors.
 */
export function addUserToGroup(db: PolicyDb, groupId: number, userId: number): void {
  db.insert(userGroupMemberships).values({ groupId, userId }).onConflictDoNothing().run();
}

/** Remove a user from a group. Returns whether a membership was removed. */
export function removeUserFromGroup(db: PolicyDb, groupId: number, userId: number): boolean {
  return (
    db
      .delete(userGroupMemberships)
      .where(
        and(eq(userGroupMemberships.groupId, groupId), eq(userGroupMemberships.userId, userId)),
      )
      .returning({ userId: userGroupMemberships.userId })
      .get() !== undefined
  );
}

// --- Activities ------------------------------------------------------------

/** A persisted {@link activities} row. */
export type ActivityRow = typeof activities.$inferSelect;
/** A persisted {@link activityGroups} row. */
export type ActivityGroupRow = typeof activityGroups.$inferSelect;
/** A persisted {@link activitiesToGroups} membership row. */
export type ActivityGroupMembershipRow = typeof activitiesToGroups.$inferSelect;

/** Fields accepted when creating an {@link activities} row. */
export interface ActivityCreate {
  kind: ActivityKind;
  matcher: string;
  /** How `matcher` is interpreted (ADR 0006). Omitted → DB default `exact`. */
  matchType?: MatchType | undefined;
}

/** Mutable fields on an {@link activities} row; omitted keys are unchanged. */
export interface ActivityUpdate {
  kind?: ActivityKind | undefined;
  matcher?: string | undefined;
  matchType?: MatchType | undefined;
}

/** All activities, ascending by id. */
export function listActivities(db: PolicyDb): ActivityRow[] {
  return db.select().from(activities).orderBy(activities.id).all();
}

/** One activity by id, or `undefined` if absent. */
export function getActivity(db: PolicyDb, id: number): ActivityRow | undefined {
  return db.select().from(activities).where(eq(activities.id, id)).get();
}

/** Insert an activity and return the stored row. */
export function createActivity(db: PolicyDb, input: ActivityCreate): ActivityRow {
  return db
    .insert(activities)
    .values({
      kind: input.kind,
      matcher: input.matcher,
      // Omit when undefined so the column's DEFAULT 'exact' applies (ADR 0006).
      ...(input.matchType !== undefined ? { matchType: input.matchType } : {}),
    })
    .returning()
    .get();
}

/**
 * Apply a partial update and return the stored row, or `undefined` if no
 * activity with `id` exists. `patch` must carry at least one key (the route
 * enforces this).
 */
export function updateActivity(
  db: PolicyDb,
  id: number,
  patch: ActivityUpdate,
): ActivityRow | undefined {
  return db.update(activities).set(patch).where(eq(activities.id, id)).returning().get();
}

/**
 * Delete an activity. Returns whether a row was removed. Its group memberships
 * cascade away with it (`activities_to_groups.activity_id` ON DELETE CASCADE).
 */
export function deleteActivity(db: PolicyDb, id: number): boolean {
  return (
    db.delete(activities).where(eq(activities.id, id)).returning({ id: activities.id }).get() !==
    undefined
  );
}

// --- Activity groups -------------------------------------------------------

/** Fields accepted when creating an {@link activityGroups} row. */
export interface ActivityGroupCreate {
  name: string;
}

/** Mutable fields on an {@link activityGroups} row. */
export interface ActivityGroupUpdate {
  name?: string | undefined;
}

/** All activity groups, ascending by id. */
export function listActivityGroups(db: PolicyDb): ActivityGroupRow[] {
  return db.select().from(activityGroups).orderBy(activityGroups.id).all();
}

/** One activity group by id, or `undefined` if absent. */
export function getActivityGroup(db: PolicyDb, id: number): ActivityGroupRow | undefined {
  return db.select().from(activityGroups).where(eq(activityGroups.id, id)).get();
}

/**
 * Insert an activity group and return the stored row. Throws the underlying
 * unique-constraint error on a duplicate `name` — see {@link isUniqueViolation}.
 */
export function createActivityGroup(db: PolicyDb, input: ActivityGroupCreate): ActivityGroupRow {
  return db.insert(activityGroups).values({ name: input.name }).returning().get();
}

/**
 * Apply a partial update and return the stored row, or `undefined` if no group
 * with `id` exists. Throws on a `name` collision (see {@link isUniqueViolation}).
 */
export function updateActivityGroup(
  db: PolicyDb,
  id: number,
  patch: ActivityGroupUpdate,
): ActivityGroupRow | undefined {
  return db.update(activityGroups).set(patch).where(eq(activityGroups.id, id)).returning().get();
}

/**
 * Delete an activity group. Returns whether a row was removed. Its memberships
 * cascade away (`activities_to_groups.group_id` ON DELETE CASCADE).
 */
export function deleteActivityGroup(db: PolicyDb, id: number): boolean {
  return (
    db
      .delete(activityGroups)
      .where(eq(activityGroups.id, id))
      .returning({ id: activityGroups.id })
      .get() !== undefined
  );
}

// --- Activity-group membership (activities ↔ groups M2M) -------------------

/** The activities belonging to a group, ascending by activity id. */
export function listGroupActivities(db: PolicyDb, groupId: number): ActivityRow[] {
  return db
    .select({
      id: activities.id,
      kind: activities.kind,
      matcher: activities.matcher,
      matchType: activities.matchType,
    })
    .from(activitiesToGroups)
    .innerJoin(activities, eq(activitiesToGroups.activityId, activities.id))
    .where(eq(activitiesToGroups.groupId, groupId))
    .orderBy(activities.id)
    .all();
}

/**
 * Whether an activity is a member of a group. Lets the route layer return a
 * precise `404` on an attempt to remove a non-membership.
 */
export function isGroupMember(db: PolicyDb, groupId: number, activityId: number): boolean {
  return (
    db
      .select({ activityId: activitiesToGroups.activityId })
      .from(activitiesToGroups)
      .where(
        and(eq(activitiesToGroups.groupId, groupId), eq(activitiesToGroups.activityId, activityId)),
      )
      .get() !== undefined
  );
}

/**
 * Add an activity to a group, idempotently (a repeated add is a no-op, not a
 * conflict). The caller is responsible for confirming both ends exist first —
 * FK violations otherwise surface as opaque errors.
 */
export function addActivityToGroup(db: PolicyDb, groupId: number, activityId: number): void {
  db.insert(activitiesToGroups).values({ groupId, activityId }).onConflictDoNothing().run();
}

/** Remove an activity from a group. Returns whether a membership was removed. */
export function removeActivityFromGroup(
  db: PolicyDb,
  groupId: number,
  activityId: number,
): boolean {
  return (
    db
      .delete(activitiesToGroups)
      .where(
        and(eq(activitiesToGroups.groupId, groupId), eq(activitiesToGroups.activityId, activityId)),
      )
      .returning({ activityId: activitiesToGroups.activityId })
      .get() !== undefined
  );
}

// --- Budgets ---------------------------------------------------------------

/** A persisted {@link budgets} row. */
export type BudgetRow = typeof budgets.$inferSelect;

/**
 * Fields accepted when creating a {@link budgets} row. `targetId` is the
 * polymorphic referent: an `activity.id` (scope `activity`), an
 * `activity_group.id` (scope `group`), or `null` (scope `overall`). The
 * route layer enforces scope/target coherence and referent existence before
 * this is called, so the storage `CHECK` is a backstop, not the primary guard.
 */
export interface BudgetCreate {
  userId: number;
  scope: Scope;
  targetId?: number | null | undefined;
  window: BudgetWindow;
  secondsAllowed: number;
}

/** Mutable fields on a {@link budgets} row; omitted keys are left unchanged. */
export interface BudgetUpdate {
  scope?: Scope | undefined;
  targetId?: number | null | undefined;
  window?: BudgetWindow | undefined;
  secondsAllowed?: number | undefined;
}

/** All budgets, ascending by id. */
export function listBudgets(db: PolicyDb): BudgetRow[] {
  return db.select().from(budgets).orderBy(budgets.id).all();
}

/** All budgets for one user, ascending by id. */
export function listUserBudgets(db: PolicyDb, userId: number): BudgetRow[] {
  return db.select().from(budgets).where(eq(budgets.userId, userId)).orderBy(budgets.id).all();
}

/** One budget by id, or `undefined` if absent. */
export function getBudget(db: PolicyDb, id: number): BudgetRow | undefined {
  return db.select().from(budgets).where(eq(budgets.id, id)).get();
}

/**
 * Insert a budget and return the stored row. The caller confirms the user
 * exists first (an FK violation otherwise surfaces opaquely).
 */
export function createBudget(db: PolicyDb, input: BudgetCreate): BudgetRow {
  return db
    .insert(budgets)
    .values({
      userId: input.userId,
      scope: input.scope,
      targetId: input.targetId ?? null,
      window: input.window,
      secondsAllowed: input.secondsAllowed,
    })
    .returning()
    .get();
}

/**
 * Apply a partial update and return the stored row, or `undefined` if no
 * budget with `id` exists. The route layer re-validates scope/target coherence
 * on the merged row before calling this.
 */
export function updateBudget(db: PolicyDb, id: number, patch: BudgetUpdate): BudgetRow | undefined {
  return db.update(budgets).set(patch).where(eq(budgets.id, id)).returning().get();
}

/** Delete a budget. Returns whether a row was removed. */
export function deleteBudget(db: PolicyDb, id: number): boolean {
  return (
    db.delete(budgets).where(eq(budgets.id, id)).returning({ id: budgets.id }).get() !== undefined
  );
}

// --- Schedules -------------------------------------------------------------

/** A persisted {@link schedules} row. */
export type ScheduleRow = typeof schedules.$inferSelect;

/**
 * Fields accepted when creating a {@link schedules} row. The recurrence +
 * date-scoping fields (reserved by #146, ADR 0005) all default to `null` — the
 * always-on degenerate. Timestamps are `Date`s (epoch-second storage); the
 * route layer converts the DTO's ISO-8601 strings. `targetId` is the
 * polymorphic referent (see {@link BudgetCreate}). `ordinal` defaults to the
 * column default when omitted; the drag-reorder editor (#63) owns reordering.
 */
export interface ScheduleCreate {
  userId: number;
  targetKind: Scope;
  targetId?: number | null | undefined;
  action: ScheduleAction;
  recurrenceDays?: number | null | undefined;
  recurrenceStartMinute?: number | null | undefined;
  recurrenceEndMinute?: number | null | undefined;
  effectiveFrom?: Date | null | undefined;
  effectiveTo?: Date | null | undefined;
  ordinal?: number | undefined;
}

/** Mutable fields on a {@link schedules} row; omitted keys are left unchanged. */
export interface ScheduleUpdate {
  targetKind?: Scope | undefined;
  targetId?: number | null | undefined;
  action?: ScheduleAction | undefined;
  recurrenceDays?: number | null | undefined;
  recurrenceStartMinute?: number | null | undefined;
  recurrenceEndMinute?: number | null | undefined;
  effectiveFrom?: Date | null | undefined;
  effectiveTo?: Date | null | undefined;
  ordinal?: number | undefined;
}

/** All schedules, ascending by id. */
export function listSchedules(db: PolicyDb): ScheduleRow[] {
  return db.select().from(schedules).orderBy(schedules.id).all();
}

/** All schedules for one user, in evaluation order (ascending `ordinal`, then id). */
export function listUserSchedules(db: PolicyDb, userId: number): ScheduleRow[] {
  return db
    .select()
    .from(schedules)
    .where(eq(schedules.userId, userId))
    .orderBy(schedules.ordinal, schedules.id)
    .all();
}

/** One schedule by id, or `undefined` if absent. */
export function getSchedule(db: PolicyDb, id: number): ScheduleRow | undefined {
  return db.select().from(schedules).where(eq(schedules.id, id)).get();
}

/**
 * Insert a schedule and return the stored row. The caller confirms the user
 * (and any activity/group referent) exists first; the recurrence + coherence
 * invariants are validated by the DTO and the route before this is called.
 */
export function createSchedule(db: PolicyDb, input: ScheduleCreate): ScheduleRow {
  return db
    .insert(schedules)
    .values({
      userId: input.userId,
      targetKind: input.targetKind,
      targetId: input.targetId ?? null,
      action: input.action,
      recurrenceDays: input.recurrenceDays ?? null,
      recurrenceStartMinute: input.recurrenceStartMinute ?? null,
      recurrenceEndMinute: input.recurrenceEndMinute ?? null,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      // Omit when undefined so the column default (0) applies.
      ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    })
    .returning()
    .get();
}

/**
 * Apply a partial update and return the stored row, or `undefined` if no
 * schedule with `id` exists. The route re-validates coherence + recurrence on
 * the merged row before calling this.
 */
export function updateSchedule(
  db: PolicyDb,
  id: number,
  patch: ScheduleUpdate,
): ScheduleRow | undefined {
  return db.update(schedules).set(patch).where(eq(schedules.id, id)).returning().get();
}

/** Delete a schedule. Returns whether a row was removed. */
export function deleteSchedule(db: PolicyDb, id: number): boolean {
  return (
    db.delete(schedules).where(eq(schedules.id, id)).returning({ id: schedules.id }).get() !==
    undefined
  );
}

/**
 * Atomically reorder a user's schedules to match `orderedIds`, the persistence
 * step behind the drag-to-reorder editor (#63). `orderedIds` must be a
 * permutation of exactly that user's schedule ids; {@link reorder} validates
 * this and throws {@link import("./schedule-precedence.js").ReorderMismatchError}
 * before any write, so a stale or garbled request can never partially apply or
 * drop a rule's position. The dense `0..n-1` ordinals are written in a single
 * transaction; the rows are then re-read in the new evaluation order.
 */
export function reorderUserSchedules(
  db: PolicyDb,
  userId: number,
  orderedIds: readonly number[],
): ScheduleRow[] {
  // Validate the permutation and compute dense ordinals up front (may throw).
  const reordered = reorder(listUserSchedules(db, userId), orderedIds);
  db.transaction((tx) => {
    for (const rule of reordered) {
      tx.update(schedules).set({ ordinal: rule.ordinal }).where(eq(schedules.id, rule.id)).run();
    }
  });
  return listUserSchedules(db, userId);
}

// --- Exceptions ------------------------------------------------------------

/** A persisted {@link exceptions} row. */
export type ExceptionRow = typeof exceptions.$inferSelect;

/**
 * Fields accepted when creating an {@link exceptions} row. The override is
 * active during `[effectiveFrom ?? createdAt, expiresAt)` (ADR 0005 §2);
 * `effectiveFrom` NULL means active from creation. Timestamps are `Date`s.
 */
export interface ExceptionCreate {
  userId: number;
  targetKind: Scope;
  targetId?: number | null | undefined;
  action: ScheduleAction;
  reason?: string | null | undefined;
  effectiveFrom?: Date | null | undefined;
  expiresAt: Date;
}

/** Mutable fields on an {@link exceptions} row; omitted keys are left unchanged. */
export interface ExceptionUpdate {
  targetKind?: Scope | undefined;
  targetId?: number | null | undefined;
  action?: ScheduleAction | undefined;
  reason?: string | null | undefined;
  effectiveFrom?: Date | null | undefined;
  expiresAt?: Date | undefined;
}

/** All exceptions, ascending by id. */
export function listExceptions(db: PolicyDb): ExceptionRow[] {
  return db.select().from(exceptions).orderBy(exceptions.id).all();
}

/** All exceptions for one user, ascending by `expiresAt` (the hot lookup order). */
export function listUserExceptions(db: PolicyDb, userId: number): ExceptionRow[] {
  return db
    .select()
    .from(exceptions)
    .where(eq(exceptions.userId, userId))
    .orderBy(exceptions.expiresAt, exceptions.id)
    .all();
}

/** One exception by id, or `undefined` if absent. */
export function getException(db: PolicyDb, id: number): ExceptionRow | undefined {
  return db.select().from(exceptions).where(eq(exceptions.id, id)).get();
}

/**
 * Insert an exception and return the stored row. The caller confirms the user
 * (and any activity/group referent) exists first; coherence and the
 * `effectiveFrom < expiresAt` window are validated by the DTO/route.
 */
export function createException(db: PolicyDb, input: ExceptionCreate): ExceptionRow {
  return db
    .insert(exceptions)
    .values({
      userId: input.userId,
      targetKind: input.targetKind,
      targetId: input.targetId ?? null,
      action: input.action,
      reason: input.reason ?? null,
      effectiveFrom: input.effectiveFrom ?? null,
      expiresAt: input.expiresAt,
    })
    .returning()
    .get();
}

/**
 * Apply a partial update and return the stored row, or `undefined` if no
 * exception with `id` exists. The route re-validates coherence and the
 * effective window on the merged row before calling this.
 */
export function updateException(
  db: PolicyDb,
  id: number,
  patch: ExceptionUpdate,
): ExceptionRow | undefined {
  return db.update(exceptions).set(patch).where(eq(exceptions.id, id)).returning().get();
}

/** Delete an exception. Returns whether a row was removed. */
export function deleteException(db: PolicyDb, id: number): boolean {
  return (
    db.delete(exceptions).where(eq(exceptions.id, id)).returning({ id: exceptions.id }).get() !==
    undefined
  );
}

// --- Notification policies (#104) ------------------------------------------

/** A persisted {@link notificationPolicies} row. */
export type NotificationPolicyRow = typeof notificationPolicies.$inferSelect;

/**
 * Fields accepted when upserting a {@link notificationPolicies} row. All
 * optional: an omitted field takes the column default on insert (the
 * documented `subtle` / `15` / `true`), or is left unchanged on update — the
 * route layer resolves the full effective policy from the merged row. A
 * `cadenceOverrides` of `null` clears any override back to the built-in cadence.
 */
export interface NotificationPolicyUpsert {
  enabled?: boolean | undefined;
  soundProfile?: SoundProfile | undefined;
  graceSeconds?: number | undefined;
  cadenceOverrides?: Record<string, unknown> | null | undefined;
}

/** The persisted notification policy for a user, or `undefined` if unset. */
export function getNotificationPolicy(
  db: PolicyDb,
  userId: number,
): NotificationPolicyRow | undefined {
  return db
    .select()
    .from(notificationPolicies)
    .where(eq(notificationPolicies.userId, userId))
    .get();
}

/**
 * Create or replace the user's notification policy (idempotent on the
 * `user_id` primary key) and return the stored row. The caller confirms the
 * user exists first (an FK violation otherwise surfaces opaquely). Only the
 * fields present in `input` are written; on conflict the same fields are
 * updated, so a partial upsert leaves the rest at their stored (or default)
 * values. `cadenceOverrides` maps to the `cadence_overrides_json` column.
 */
export function upsertNotificationPolicy(
  db: PolicyDb,
  userId: number,
  input: NotificationPolicyUpsert,
): NotificationPolicyRow {
  // Build the column set from only the provided fields so omitted keys fall to
  // the column default (insert) or stay unchanged (the on-conflict update).
  const set: Partial<typeof notificationPolicies.$inferInsert> = {};
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.soundProfile !== undefined) set.soundProfile = input.soundProfile;
  if (input.graceSeconds !== undefined) set.graceSeconds = input.graceSeconds;
  if (input.cadenceOverrides !== undefined) set.cadenceOverridesJson = input.cadenceOverrides;
  return db
    .insert(notificationPolicies)
    .values({ userId, ...set })
    .onConflictDoUpdate({ target: notificationPolicies.userId, set })
    .returning()
    .get();
}

/**
 * Delete a user's notification policy (reverting them to the documented
 * defaults). Returns whether a row was removed.
 */
export function deleteNotificationPolicy(db: PolicyDb, userId: number): boolean {
  return (
    db
      .delete(notificationPolicies)
      .where(eq(notificationPolicies.userId, userId))
      .returning({ userId: notificationPolicies.userId })
      .get() !== undefined
  );
}

// --- Group schedules (#182) ------------------------------------------------
// Group-targeted recurring rules, keyed by `user_group_id` (ADR 0007). The same
// rule shape as {@link schedules} minus the owner; `policy/group-resolution.ts`
// merges a user's own schedules with the schedules of their groups.

/** A persisted {@link groupSchedules} row. */
export type GroupScheduleRow = typeof groupSchedules.$inferSelect;

/**
 * Fields accepted when creating a {@link groupSchedules} row — {@link
 * ScheduleCreate} with `userGroupId` in place of `userId`. The recurrence +
 * date-scoping fields default to `null` (always-on); `ordinal` defaults to the
 * column default when omitted.
 */
export interface GroupScheduleCreate {
  userGroupId: number;
  targetKind: Scope;
  targetId?: number | null | undefined;
  action: ScheduleAction;
  recurrenceDays?: number | null | undefined;
  recurrenceStartMinute?: number | null | undefined;
  recurrenceEndMinute?: number | null | undefined;
  effectiveFrom?: Date | null | undefined;
  effectiveTo?: Date | null | undefined;
  ordinal?: number | undefined;
}

/** Mutable fields on a {@link groupSchedules} row; omitted keys are unchanged. */
export interface GroupScheduleUpdate {
  targetKind?: Scope | undefined;
  targetId?: number | null | undefined;
  action?: ScheduleAction | undefined;
  recurrenceDays?: number | null | undefined;
  recurrenceStartMinute?: number | null | undefined;
  recurrenceEndMinute?: number | null | undefined;
  effectiveFrom?: Date | null | undefined;
  effectiveTo?: Date | null | undefined;
  ordinal?: number | undefined;
}

/** All schedules for one group, in evaluation order (ascending `ordinal`, then id). */
export function listGroupSchedules(db: PolicyDb, groupId: number): GroupScheduleRow[] {
  return db
    .select()
    .from(groupSchedules)
    .where(eq(groupSchedules.userGroupId, groupId))
    .orderBy(groupSchedules.ordinal, groupSchedules.id)
    .all();
}

/** One group schedule by id, or `undefined` if absent. */
export function getGroupSchedule(db: PolicyDb, id: number): GroupScheduleRow | undefined {
  return db.select().from(groupSchedules).where(eq(groupSchedules.id, id)).get();
}

/**
 * Insert a group schedule and return the stored row. The caller confirms the
 * group (and any activity/group referent) exists first; the recurrence +
 * coherence invariants are validated by the DTO and the route before this.
 */
export function createGroupSchedule(db: PolicyDb, input: GroupScheduleCreate): GroupScheduleRow {
  return db
    .insert(groupSchedules)
    .values({
      userGroupId: input.userGroupId,
      targetKind: input.targetKind,
      targetId: input.targetId ?? null,
      action: input.action,
      recurrenceDays: input.recurrenceDays ?? null,
      recurrenceStartMinute: input.recurrenceStartMinute ?? null,
      recurrenceEndMinute: input.recurrenceEndMinute ?? null,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      // Omit when undefined so the column default (0) applies.
      ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    })
    .returning()
    .get();
}

/**
 * Apply a partial update and return the stored row, or `undefined` if no group
 * schedule with `id` exists. The route re-validates coherence + recurrence on
 * the merged row before calling this.
 */
export function updateGroupSchedule(
  db: PolicyDb,
  id: number,
  patch: GroupScheduleUpdate,
): GroupScheduleRow | undefined {
  return db.update(groupSchedules).set(patch).where(eq(groupSchedules.id, id)).returning().get();
}

/** Delete a group schedule. Returns whether a row was removed. */
export function deleteGroupSchedule(db: PolicyDb, id: number): boolean {
  return (
    db
      .delete(groupSchedules)
      .where(eq(groupSchedules.id, id))
      .returning({ id: groupSchedules.id })
      .get() !== undefined
  );
}

/**
 * Atomically reorder a group's schedules to match `orderedIds` — the group
 * counterpart of {@link reorderUserSchedules} (#270), the persistence step
 * behind the group drag-to-reorder editor. `orderedIds` must be a permutation
 * of exactly that group's schedule ids; {@link reorder} validates this and
 * throws {@link import("./schedule-precedence.js").ReorderMismatchError} before
 * any write, so a stale or garbled request can never partially apply or drop a
 * rule's position. The dense `0..n-1` ordinals are written in a single
 * transaction; the rows are then re-read in the new evaluation order.
 */
export function reorderGroupSchedules(
  db: PolicyDb,
  groupId: number,
  orderedIds: readonly number[],
): GroupScheduleRow[] {
  // Validate the permutation and compute dense ordinals up front (may throw).
  const reordered = reorder(listGroupSchedules(db, groupId), orderedIds);
  db.transaction((tx) => {
    for (const rule of reordered) {
      tx.update(groupSchedules)
        .set({ ordinal: rule.ordinal })
        .where(eq(groupSchedules.id, rule.id))
        .run();
    }
  });
  return listGroupSchedules(db, groupId);
}

// --- Group exceptions (#182) -----------------------------------------------
// Group-targeted one-off overrides, keyed by `user_group_id` (ADR 0007).

/** A persisted {@link groupExceptions} row. */
export type GroupExceptionRow = typeof groupExceptions.$inferSelect;

/**
 * Fields accepted when creating a {@link groupExceptions} row — {@link
 * ExceptionCreate} with `userGroupId` in place of `userId`. Active during
 * `[effectiveFrom ?? createdAt, expiresAt)` (ADR 0005 §2).
 */
export interface GroupExceptionCreate {
  userGroupId: number;
  targetKind: Scope;
  targetId?: number | null | undefined;
  action: ScheduleAction;
  reason?: string | null | undefined;
  effectiveFrom?: Date | null | undefined;
  expiresAt: Date;
}

/** Mutable fields on a {@link groupExceptions} row; omitted keys are unchanged. */
export interface GroupExceptionUpdate {
  targetKind?: Scope | undefined;
  targetId?: number | null | undefined;
  action?: ScheduleAction | undefined;
  reason?: string | null | undefined;
  effectiveFrom?: Date | null | undefined;
  expiresAt?: Date | undefined;
}

/** All exceptions for one group, ascending by `expiresAt` (the hot lookup order). */
export function listGroupExceptions(db: PolicyDb, groupId: number): GroupExceptionRow[] {
  return db
    .select()
    .from(groupExceptions)
    .where(eq(groupExceptions.userGroupId, groupId))
    .orderBy(groupExceptions.expiresAt, groupExceptions.id)
    .all();
}

/** One group exception by id, or `undefined` if absent. */
export function getGroupException(db: PolicyDb, id: number): GroupExceptionRow | undefined {
  return db.select().from(groupExceptions).where(eq(groupExceptions.id, id)).get();
}

/**
 * Insert a group exception and return the stored row. The caller confirms the
 * group (and any activity/group referent) exists first; coherence and the
 * `effectiveFrom < expiresAt` window are validated by the DTO/route.
 */
export function createGroupException(db: PolicyDb, input: GroupExceptionCreate): GroupExceptionRow {
  return db
    .insert(groupExceptions)
    .values({
      userGroupId: input.userGroupId,
      targetKind: input.targetKind,
      targetId: input.targetId ?? null,
      action: input.action,
      reason: input.reason ?? null,
      effectiveFrom: input.effectiveFrom ?? null,
      expiresAt: input.expiresAt,
    })
    .returning()
    .get();
}

/**
 * Apply a partial update and return the stored row, or `undefined` if no group
 * exception with `id` exists. The route re-validates coherence and the
 * effective window on the merged row before calling this.
 */
export function updateGroupException(
  db: PolicyDb,
  id: number,
  patch: GroupExceptionUpdate,
): GroupExceptionRow | undefined {
  return db.update(groupExceptions).set(patch).where(eq(groupExceptions.id, id)).returning().get();
}

/** Delete a group exception. Returns whether a row was removed. */
export function deleteGroupException(db: PolicyDb, id: number): boolean {
  return (
    db
      .delete(groupExceptions)
      .where(eq(groupExceptions.id, id))
      .returning({ id: groupExceptions.id })
      .get() !== undefined
  );
}

// --- Retention overrides (#136) --------------------------------------------

/** A persisted {@link retentionOverrides} row. */
export type RetentionOverrideRow = typeof retentionOverrides.$inferSelect;

/**
 * Every per-category retention override, ascending by category. A category
 * absent from this list inherits the global default (see `policy/retention.ts`
 * → {@link RetentionPolicy.fromOverrides}); the row layer never invents a
 * default-inheriting row.
 */
export function listRetentionOverrides(db: PolicyDb): RetentionOverrideRow[] {
  return db.select().from(retentionOverrides).orderBy(retentionOverrides.category).all();
}

/**
 * Set (insert or replace) the override for one category and return the stored
 * row. The {@link ResolvedRetention} is split onto the `keep_forever` / `days`
 * columns the storage CHECK enforces: keep-forever rows carry no day count,
 * custom rows carry the positive count. `updated_at` is refreshed on every
 * write so the admin surface can show when a window last changed.
 */
export function upsertRetentionOverride(
  db: PolicyDb,
  category: RetentionCategory,
  retention: ResolvedRetention,
): RetentionOverrideRow {
  const keepForever = retention.keepForever;
  const days = retention.keepForever ? null : retention.days;
  const now = new Date();
  return db
    .insert(retentionOverrides)
    .values({ category, keepForever, days, updatedAt: now })
    .onConflictDoUpdate({
      target: retentionOverrides.category,
      set: { keepForever, days, updatedAt: now },
    })
    .returning()
    .get();
}

/**
 * Clear the override for one category, reverting it to the global default.
 * Returns whether a row was actually removed (false when none was set).
 */
export function deleteRetentionOverride(db: PolicyDb, category: RetentionCategory): boolean {
  return (
    db
      .delete(retentionOverrides)
      .where(eq(retentionOverrides.category, category))
      .returning({ category: retentionOverrides.category })
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

/**
 * Whether an error thrown by better-sqlite3 is a `CHECK` constraint violation,
 * which the route layer maps to `400 validation_error` rather than leaking a
 * generic 500 (#148: "map the schema's CHECK constraints to clear 400/409s").
 * This backstops the storage invariants — budget non-negativity / target
 * coherence, schedule recurrence bounds, the exception effective window — for
 * the cases a PATCH merge can violate without the DTO seeing the merged row.
 * Reads `.code` structurally so no `as` cast or `any` is needed.
 */
export function isCheckViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return Reflect.get(err, "code") === "SQLITE_CONSTRAINT_CHECK";
}
