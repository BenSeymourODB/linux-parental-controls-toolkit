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
import type { ActivityKind, BudgetWindow, ScheduleAction, Scope } from "./enums.js";
import {
  activities,
  activitiesToGroups,
  activityGroups,
  budgets,
  clients,
  exceptions,
  schedules,
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
}

/** Mutable fields on an {@link activities} row; omitted keys are unchanged. */
export interface ActivityUpdate {
  kind?: ActivityKind | undefined;
  matcher?: string | undefined;
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
    .values({ kind: input.kind, matcher: input.matcher })
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
