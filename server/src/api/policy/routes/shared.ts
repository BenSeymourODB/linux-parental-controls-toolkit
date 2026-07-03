/**
 * Shared building blocks for the policy CRUD registrars (#225).
 *
 * `registerPolicyRoutes` was a single ~1330-line function; it is split into
 * per-entity registrars under this directory, each of which reuses the error
 * mappers, existence guards, target-coherence check, group push fan-out, and
 * PATCH update-payload builders collected here. Keeping them in one module lets
 * the 404/409/400 envelope contract and the PATCH normalization change in a
 * single place rather than at every call site.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { PolicyDb } from "../../../policy/db.js";
import type { Scope } from "../../../policy/enums.js";
import * as repo from "../../../policy/repository.js";
import { userPushCommands, type UserPushReason } from "../../../transport/stub.js";
import { ApiError } from "../../errors.js";
import type { UpdateExceptionRequest, UpdateScheduleRequest } from "../dtos.js";

/** Run a repository write, mapping a UNIQUE collision to a `409 conflict`. */
export function asConflict<T>(write: () => T, message: string): T {
  try {
    return write();
  } catch (err) {
    if (repo.isUniqueViolation(err)) {
      throw new ApiError(409, "conflict", message);
    }
    throw err;
  }
}

/**
 * Run a repository write, mapping a storage `CHECK` violation to a
 * `400 validation_error`. Backstops the merged-row invariants a PATCH can break
 * without the DTO seeing them (budget non-negativity / target coherence,
 * schedule recurrence bounds, the exception effective window) — #148: "map the
 * schema's CHECK constraints to clear 400/409s rather than a generic 500".
 */
export function asValidated<T>(write: () => T, message: string): T {
  try {
    return write();
  } catch (err) {
    if (repo.isCheckViolation(err)) {
      throw new ApiError(400, "validation_error", message);
    }
    throw err;
  }
}

/**
 * Build the shared `404 not_found` envelope error. The CRUD handlers map a
 * missing row to a 404 in ~40 places ({@link assertFound} / {@link assertRemoved});
 * routing them all through here keeps the status + machine-readable code in one
 * spot, so the 404 contract changes once rather than at every call site (#224).
 */
export function notFound(message: string): ApiError {
  return new ApiError(404, "not_found", message);
}

/**
 * Return `row` if present, else throw a `404 not_found` naming the entity. Used
 * both for "GET/PATCH/DELETE a missing row → 404" (the returned row is kept) and
 * for referenced-entity existence guards before a create/list (the return is
 * discarded, only the guard matters), so the `${entity} ${id} not found` shape
 * lives in one place.
 */
export function assertFound<T>(row: T | undefined, entity: string, id: number): T {
  if (row === undefined) {
    throw notFound(`${entity} ${id} not found`);
  }
  return row;
}

/**
 * Throw a `404 not_found` with `message` when a delete/removal reports the row
 * was absent (`removed === false`). The standard delete sites pass the same
 * `${entity} ${id} not found` text {@link assertFound} builds; the relational
 * link/membership removals pass their own message.
 */
export function assertRemoved(removed: boolean, message: string): void {
  if (!removed) {
    throw notFound(message);
  }
}

/**
 * Enforce the polymorphic-target invariant for a Budget/Schedule/Exception
 * write: a row is `overall` exactly when it has no `target_id`, and an
 * `activity`/`group` target must reference an existing row. Throws a precise
 * `400 validation_error` instead of letting a coherence break hit the storage
 * `CHECK` as an opaque error or a budget dangle against a deleted activity.
 * Shared by create and PATCH so the rule lives in one place.
 */
export function assertTarget(db: PolicyDb, kind: Scope, targetId: number | null): void {
  if (kind === "overall") {
    if (targetId !== null) {
      throw new ApiError(
        400,
        "validation_error",
        "targetId must be null when the scope is 'overall'",
      );
    }
    return;
  }
  if (targetId === null) {
    throw new ApiError(400, "validation_error", `targetId is required when the scope is '${kind}'`);
  }
  if (kind === "activity" && repo.getActivity(db, targetId) === undefined) {
    throw new ApiError(400, "validation_error", `Activity ${targetId} not found`);
  }
  if (kind === "group" && repo.getActivityGroup(db, targetId) === undefined) {
    throw new ApiError(400, "validation_error", `Activity group ${targetId} not found`);
  }
}

/**
 * Fan a group-rule mutation out to the push stub: one command per client of
 * every member of the group (#182). A group-targeted schedule/exception affects
 * every member, so it pushes the same way each member's own rule change does —
 * reusing {@link userPushCommands} per member, attributing the push to that
 * member. No new command shape (ADR 0007 §Consequences). A group with no members
 * (or members with no clients) yields an empty list — a no-op push.
 */
export function groupMemberPushCommands(
  db: PolicyDb,
  reason: UserPushReason,
  groupId: number,
  detail: Readonly<Record<string, unknown>>,
): ReturnType<typeof userPushCommands> {
  return repo
    .listGroupMembers(db, groupId)
    .flatMap((member) =>
      userPushCommands(reason, member.id, repo.listUserClientIds(db, member.id), detail),
    );
}

/**
 * Normalize an optional wire timestamp (ISO-8601 string, explicit `null`, or
 * absent) to the `Date | null` the repository stores. The single conversion the
 * create and PATCH paths for schedules/exceptions share, so "null clears the
 * bound, a string sets it" can't drift between them.
 */
export function nullableDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/**
 * Build a Schedule PATCH update-payload from a validated request body:
 * include only the fields the PATCH actually carries (so an omitted field is
 * left unchanged) and normalize the timestamp bounds. Serves both the
 * user-targeted (`/schedules/:id`) and group-targeted (`/group-schedules/:id`)
 * PATCH handlers — {@link repo.ScheduleUpdate} and {@link repo.GroupScheduleUpdate}
 * are structurally identical (#225).
 */
export function buildScheduleUpdatePatch(body: UpdateScheduleRequest): repo.ScheduleUpdate {
  return {
    ...(body.targetKind !== undefined ? { targetKind: body.targetKind } : {}),
    ...(body.targetId !== undefined ? { targetId: body.targetId } : {}),
    ...(body.action !== undefined ? { action: body.action } : {}),
    ...(body.recurrenceDays !== undefined ? { recurrenceDays: body.recurrenceDays } : {}),
    ...(body.recurrenceStartMinute !== undefined
      ? { recurrenceStartMinute: body.recurrenceStartMinute }
      : {}),
    ...(body.recurrenceEndMinute !== undefined
      ? { recurrenceEndMinute: body.recurrenceEndMinute }
      : {}),
    ...(body.effectiveFrom !== undefined
      ? { effectiveFrom: nullableDate(body.effectiveFrom) }
      : {}),
    ...(body.effectiveTo !== undefined ? { effectiveTo: nullableDate(body.effectiveTo) } : {}),
    ...(body.ordinal !== undefined ? { ordinal: body.ordinal } : {}),
  };
}

/**
 * Build an Exception PATCH update-payload from a validated request body: the
 * same conditional-inclusion + timestamp normalization as
 * {@link buildScheduleUpdatePatch}, for the exception fields. Serves both the
 * user-targeted (`/exceptions/:id`) and group-targeted (`/group-exceptions/:id`)
 * PATCH handlers — {@link repo.ExceptionUpdate} and {@link repo.GroupExceptionUpdate}
 * are structurally identical (#225).
 */
export function buildExceptionUpdatePatch(body: UpdateExceptionRequest): repo.ExceptionUpdate {
  return {
    ...(body.targetKind !== undefined ? { targetKind: body.targetKind } : {}),
    ...(body.targetId !== undefined ? { targetId: body.targetId } : {}),
    ...(body.action !== undefined ? { action: body.action } : {}),
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
    ...(body.effectiveFrom !== undefined
      ? { effectiveFrom: nullableDate(body.effectiveFrom) }
      : {}),
    ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
  };
}

/**
 * Compile-time guard that the group-targeted update types stay structurally
 * interchangeable with the user-targeted ones the builders return. The builders
 * emit `repo.ScheduleUpdate` / `repo.ExceptionUpdate` yet their results also feed
 * `updateGroupSchedule` / `updateGroupException` (the shapes are identical
 * today). If a future optional field is added to only one side of a pair — e.g.
 * to `GroupScheduleUpdate` and its schema but not the builder — these assertions
 * fail to compile, rather than the group PATCH path silently dropping the field
 * (the latent risk called out in #225 review). Type-level only; erased at build.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
// These aliases exist only to be type-checked; they are intentionally unreferenced.
/* eslint-disable @typescript-eslint/no-unused-vars */
type _ScheduleUpdatesInterchangeable = AssertTrue<
  MutuallyAssignable<repo.ScheduleUpdate, repo.GroupScheduleUpdate>
>;
type _ExceptionUpdatesInterchangeable = AssertTrue<
  MutuallyAssignable<repo.ExceptionUpdate, repo.GroupExceptionUpdate>
>;
/* eslint-enable @typescript-eslint/no-unused-vars */
