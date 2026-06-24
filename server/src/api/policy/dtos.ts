/**
 * zod DTOs for the policy-model CRUD surface: request bodies, URL params, and
 * response shapes for `User` / `Client` / `UserOnClient` (slice 1, #51) and
 * `Activity` / `ActivityGroup` (+ membership) / `Budget` / `Schedule` /
 * `Exception` (slice 2, #148). As with every `/api/*` DTO these are the single
 * contract shared with the SvelteKit frontend and external integrators — types
 * are inferred from the schemas, never hand-written twice (`CLAUDE.md` → "api/
 * — zod DTOs ..."). Enum and recurrence invariants are imported from
 * `policy/enums.ts` and `policy/recurrence.ts` so the storage `CHECK`
 * constraints and the request validation share one source.
 *
 * Storage uses epoch-second `Date` columns (see `policy/schema.ts`); the
 * response mappers below serialize them as ISO-8601 UTC strings so the wire
 * contract is unambiguous and human-readable.
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

import { isValidMatcher } from "../../policy/activity-matcher.js";
import { isValidTimeZone } from "../../policy/budget-window.js";
import {
  activityKindSchema,
  budgetWindowSchema,
  matchTypeSchema,
  scheduleActionSchema,
  scopeSchema,
  soundProfileSchema,
  type MatchType,
} from "../../policy/enums.js";
import {
  defaultNotificationPolicy,
  notificationGraceSecondsSchema,
} from "../../policy/notification.js";
import {
  scheduleRecurrenceSchema,
  minuteOfDaySchema,
  weekdayMaskSchema,
} from "../../policy/recurrence.js";
import type {
  ActivityGroupRow,
  ActivityRow,
  BudgetRow,
  ClientRow,
  ExceptionRow,
  GroupExceptionRow,
  GroupScheduleRow,
  NotificationPolicyRow,
  ScheduleRow,
  UserGroupRow,
  UserOnClientRow,
  UserRow,
} from "../../policy/repository.js";

/** An IANA timezone name, validated against the host's tz database (ADR-0001). */
export const tzSchema = z.string().refine(isValidTimeZone, { message: "Unknown IANA timezone" });

/** `:id` path param, coerced from the string Fastify provides. */
export const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/** Reject a PATCH that carries no updatable fields with a clear 400. */
function nonEmpty(value: object): boolean {
  return Object.keys(value).length > 0;
}

// --- Users -----------------------------------------------------------------

export const createUserSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  tz: tzSchema.nullable().optional(),
});

export const updateUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    tz: tzSchema.nullable().optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const userResponseSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
  tz: z.string().nullable(),
  createdAt: z.string(),
});

export type CreateUserRequest = z.infer<typeof createUserSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;

/** Map a stored user row to its wire DTO. */
export function toUserResponse(row: UserRow): UserResponse {
  return {
    id: row.id,
    displayName: row.displayName,
    tz: row.tz,
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Clients ---------------------------------------------------------------

export const createClientSchema = z.object({
  hostname: z.string().trim().min(1).max(253),
  sshUser: z.string().trim().min(1).max(64),
});

export const updateClientSchema = z
  .object({
    hostname: z.string().trim().min(1).max(253).optional(),
    sshUser: z.string().trim().min(1).max(64).optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const clientResponseSchema = z.object({
  id: z.number().int(),
  hostname: z.string(),
  sshUser: z.string(),
  enrolledAt: z.string(),
  lastSeen: z.string().nullable(),
});

export type CreateClientRequest = z.infer<typeof createClientSchema>;
export type UpdateClientRequest = z.infer<typeof updateClientSchema>;
export type ClientResponse = z.infer<typeof clientResponseSchema>;

/** Map a stored client row to its wire DTO. */
export function toClientResponse(row: ClientRow): ClientResponse {
  return {
    id: row.id,
    hostname: row.hostname,
    sshUser: row.sshUser,
    enrolledAt: row.enrolledAt.toISOString(),
    lastSeen: row.lastSeen === null ? null : row.lastSeen.toISOString(),
  };
}

// --- User-on-client links --------------------------------------------------

/** `:userId` path param for the nested link routes. */
export const userIdParamsSchema = z.object({ userId: z.coerce.number().int().positive() });

/** `:userId`/`:clientId` path params for a single link. */
export const userClientParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
  clientId: z.coerce.number().int().positive(),
});

export const upsertLinkSchema = z.object({
  osUsername: z.string().trim().min(1).max(32),
  // OS account reference: a uid on Linux, a SID on Windows (#230). A string so
  // the published contract is stable across platforms; the charset forbids
  // `"`/`\`/control chars. On Linux this is the numeric uid as a decimal string
  // ("0" for root is permitted at the type level even if policy never uses it).
  osUserRef: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(
      /^[A-Za-z0-9._:-]+$/,
      "must be an OS account reference (a uid on Linux, a SID on Windows)",
    ),
});

export const linkResponseSchema = z.object({
  userId: z.number().int(),
  clientId: z.number().int(),
  osUsername: z.string(),
  osUserRef: z.string(),
});

export type UpsertLinkRequest = z.infer<typeof upsertLinkSchema>;
export type LinkResponse = z.infer<typeof linkResponseSchema>;

/** Map a stored link row to its wire DTO. */
export function toLinkResponse(row: UserOnClientRow): LinkResponse {
  return {
    userId: row.userId,
    clientId: row.clientId,
    osUsername: row.osUsername,
    osUserRef: row.osUserRef,
  };
}

// --- Shared policy-target field --------------------------------------------

/**
 * The polymorphic `target_id`: an `activity.id` (scope `activity`), an
 * `activity_group.id` (scope `group`), or `null` (scope `overall`). JSON
 * bodies carry real numbers, so no coercion. Coherence with the scope and the
 * existence of the referent are enforced in the route layer (it needs DB
 * access), shared by create and PATCH so the rule lives in one place.
 */
const targetIdSchema = z.number().int().positive().nullable();

// --- Activities ------------------------------------------------------------

/**
 * Reject a `regex` matcher that does not compile (ADR 0006 §4). Attached only to
 * `create`, where both fields are always present; the partial-update case is
 * validated in the route layer against the merged row (it needs the stored
 * `match_type`/`matcher` to know the effective pair).
 */
const matcherCompiles = (
  value: { matchType: MatchType; matcher: string },
  ctx: z.RefinementCtx,
): void => {
  if (!isValidMatcher(value.matchType, value.matcher)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "matcher is not a valid regular expression",
      path: ["matcher"],
    });
  }
};

export const createActivitySchema = z
  .object({
    kind: activityKindSchema,
    matcher: z.string().trim().min(1).max(512),
    // How `matcher` is interpreted (ADR 0006); defaults to the v1 `exact`.
    matchType: matchTypeSchema.default("exact"),
  })
  .superRefine(matcherCompiles);

export const updateActivitySchema = z
  .object({
    kind: activityKindSchema.optional(),
    matcher: z.string().trim().min(1).max(512).optional(),
    matchType: matchTypeSchema.optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const activityResponseSchema = z.object({
  id: z.number().int(),
  kind: activityKindSchema,
  matcher: z.string(),
  matchType: matchTypeSchema,
});

export type CreateActivityRequest = z.infer<typeof createActivitySchema>;
export type UpdateActivityRequest = z.infer<typeof updateActivitySchema>;
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

/** Map a stored activity row to its wire DTO. */
export function toActivityResponse(row: ActivityRow): ActivityResponse {
  return { id: row.id, kind: row.kind, matcher: row.matcher, matchType: row.matchType };
}

// --- Activity groups -------------------------------------------------------

export const createActivityGroupSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const updateActivityGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const activityGroupResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});

export type CreateActivityGroupRequest = z.infer<typeof createActivityGroupSchema>;
export type UpdateActivityGroupRequest = z.infer<typeof updateActivityGroupSchema>;
export type ActivityGroupResponse = z.infer<typeof activityGroupResponseSchema>;

/** Map a stored activity-group row to its wire DTO. */
export function toActivityGroupResponse(row: ActivityGroupRow): ActivityGroupResponse {
  return { id: row.id, name: row.name };
}

/** `:groupId` path param for the membership routes. */
export const groupIdParamsSchema = z.object({ groupId: z.coerce.number().int().positive() });

/** `:groupId`/`:activityId` path params for a single membership. */
export const groupActivityParamsSchema = z.object({
  groupId: z.coerce.number().int().positive(),
  activityId: z.coerce.number().int().positive(),
});

/**
 * `?userId=` filter shared by the user-scoped policy collections (budgets,
 * schedules, exceptions): present ⇒ restrict to that user, absent ⇒ list all.
 */
export const userIdQuerySchema = z.object({
  userId: z.coerce.number().int().positive().optional(),
});

// --- User groups (#124) ----------------------------------------------------

export const createUserGroupSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const updateUserGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const userGroupResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  createdAt: z.string(),
});

export type CreateUserGroupRequest = z.infer<typeof createUserGroupSchema>;
export type UpdateUserGroupRequest = z.infer<typeof updateUserGroupSchema>;
export type UserGroupResponse = z.infer<typeof userGroupResponseSchema>;

/** Map a stored user-group row to its wire DTO. */
export function toUserGroupResponse(row: UserGroupRow): UserGroupResponse {
  return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
}

/**
 * `:groupId`/`:userId` path params for a single user-group membership. (The
 * `:groupId`-only routes reuse {@link groupIdParamsSchema}, which is the same
 * `{ groupId }` shape the activity-group membership routes already use.)
 */
export const userGroupMemberParamsSchema = z.object({
  groupId: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
});

// --- Budgets ---------------------------------------------------------------

export const createBudgetSchema = z.object({
  userId: z.number().int().positive(),
  scope: scopeSchema,
  targetId: targetIdSchema.default(null),
  window: budgetWindowSchema,
  secondsAllowed: z.number().int().min(0),
});

export const updateBudgetSchema = z
  .object({
    scope: scopeSchema.optional(),
    // Present (incl. explicit null) ⇒ change; absent ⇒ leave unchanged. No
    // default, so the route can tell "not provided" from "set to null".
    targetId: targetIdSchema.optional(),
    window: budgetWindowSchema.optional(),
    secondsAllowed: z.number().int().min(0).optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const budgetResponseSchema = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  scope: scopeSchema,
  targetId: z.number().int().nullable(),
  window: budgetWindowSchema,
  secondsAllowed: z.number().int(),
});

export type CreateBudgetRequest = z.infer<typeof createBudgetSchema>;
export type UpdateBudgetRequest = z.infer<typeof updateBudgetSchema>;
export type BudgetResponse = z.infer<typeof budgetResponseSchema>;

/** Map a stored budget row to its wire DTO. */
export function toBudgetResponse(row: BudgetRow): BudgetResponse {
  return {
    id: row.id,
    userId: row.userId,
    scope: row.scope,
    targetId: row.targetId,
    window: row.window,
    secondsAllowed: row.secondsAllowed,
  };
}

// --- Schedules -------------------------------------------------------------

/**
 * Schedule create body: the rule's target/action/order, intersected with the
 * shared recurrence + date-scoping fields ({@link scheduleRecurrenceSchema},
 * #146). The intersection runs both validators, so the recurrence invariants
 * (both-or-neither minutes, `start < end`, `effectiveFrom < effectiveTo`) are
 * enforced here from their single source. `ordinal` is optional (defaults to
 * the column default); the drag-reorder editor (#63) owns reordering.
 */
export const createScheduleSchema = z.intersection(
  z.object({
    userId: z.number().int().positive(),
    targetKind: scopeSchema,
    targetId: targetIdSchema.default(null),
    action: scheduleActionSchema,
    ordinal: z.number().int().min(0).optional(),
  }),
  scheduleRecurrenceSchema,
);

/**
 * Schedule PATCH body: each field optional. Per-field bounds are enforced here;
 * the cross-field recurrence invariants are re-checked against the merged row
 * by the storage `CHECK` constraints (mapped to a 400), since a PATCH may set
 * only one half of a pair.
 */
export const updateScheduleSchema = z
  .object({
    targetKind: scopeSchema.optional(),
    targetId: targetIdSchema.optional(),
    action: scheduleActionSchema.optional(),
    // Reuse the single-source recurrence bounds (recurrence.ts), so the PATCH
    // per-field checks can't drift from the create path or the storage CHECK.
    recurrenceDays: weekdayMaskSchema.nullable().optional(),
    recurrenceStartMinute: minuteOfDaySchema.nullable().optional(),
    recurrenceEndMinute: minuteOfDaySchema.nullable().optional(),
    effectiveFrom: z.string().datetime().nullable().optional(),
    effectiveTo: z.string().datetime().nullable().optional(),
    ordinal: z.number().int().min(0).optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const scheduleResponseSchema = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  targetKind: scopeSchema,
  targetId: z.number().int().nullable(),
  action: scheduleActionSchema,
  recurrenceDays: z.number().int().nullable(),
  recurrenceStartMinute: z.number().int().nullable(),
  recurrenceEndMinute: z.number().int().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  ordinal: z.number().int(),
});

export type CreateScheduleRequest = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleRequest = z.infer<typeof updateScheduleSchema>;
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

/** Map a stored schedule row to its wire DTO (timestamps → ISO-8601 UTC). */
export function toScheduleResponse(row: ScheduleRow): ScheduleResponse {
  return {
    id: row.id,
    userId: row.userId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    action: row.action,
    recurrenceDays: row.recurrenceDays,
    recurrenceStartMinute: row.recurrenceStartMinute,
    recurrenceEndMinute: row.recurrenceEndMinute,
    effectiveFrom: row.effectiveFrom === null ? null : row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo === null ? null : row.effectiveTo.toISOString(),
    ordinal: row.ordinal,
  };
}

// --- Schedule ordering (#63) -----------------------------------------------

/**
 * Atomic reorder body: the user's schedule ids in their new evaluation order
 * (first wins). Completeness and uniqueness against the user's actual rows are
 * checked server-side by `reorder()` (a 409 on mismatch), which gives a precise
 * error a per-field schema can't — so this only asserts a non-empty list of ids.
 */
export const reorderSchedulesSchema = z.object({
  orderedIds: z.array(z.number().int().positive()).min(1),
});
export type ReorderSchedulesRequest = z.infer<typeof reorderSchedulesSchema>;

/**
 * A later schedule rule that an earlier one renders unreachable — the wire form
 * of `policy/schedule-precedence.ts`'s `ShadowFinding`, feeding the editor's
 * "this rule will never apply" warning.
 */
export const shadowFindingSchema = z.object({
  shadowedId: z.number().int(),
  shadowedById: z.number().int(),
});
export type ShadowFindingDto = z.infer<typeof shadowFindingSchema>;

/**
 * A user's schedules in evaluation order, plus the two derived facts the
 * drag-to-reorder editor (#63) renders without re-implementing precedence:
 * `shadows` — rules an earlier rule provably pre-empts — and `effectiveIds` —
 * the rule in effect *right now* for each distinct target. Both are computed
 * server-side from the shared precedence module so every surface agrees.
 */
export const scheduleOrderViewSchema = z.object({
  schedules: z.array(scheduleResponseSchema),
  shadows: z.array(shadowFindingSchema),
  effectiveIds: z.array(z.number().int()),
});
export type ScheduleOrderView = z.infer<typeof scheduleOrderViewSchema>;

/** Assemble a {@link ScheduleOrderView} from ordered rows + the derived facts. */
export function toScheduleOrderView(
  rows: readonly ScheduleRow[],
  shadows: readonly ShadowFindingDto[],
  effectiveIds: readonly number[],
): ScheduleOrderView {
  return {
    schedules: rows.map(toScheduleResponse),
    shadows: shadows.map((s) => ({ shadowedId: s.shadowedId, shadowedById: s.shadowedById })),
    effectiveIds: [...effectiveIds],
  };
}

// --- Exceptions ------------------------------------------------------------

/**
 * Exception create body. The override is active during
 * `[effectiveFrom ?? createdAt, expiresAt)` (ADR 0005 §2); the superRefine
 * enforces `effectiveFrom < expiresAt` when a pre-schedule instant is given.
 */
export const createExceptionSchema = z
  .object({
    userId: z.number().int().positive(),
    targetKind: scopeSchema,
    targetId: targetIdSchema.default(null),
    action: scheduleActionSchema,
    reason: z.string().trim().min(1).max(500).nullable().default(null),
    effectiveFrom: z.string().datetime().nullable().default(null),
    expiresAt: z.string().datetime(),
  })
  .superRefine((value, ctx) => {
    if (
      value.effectiveFrom !== null &&
      Date.parse(value.effectiveFrom) >= Date.parse(value.expiresAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expiresAt must be after effectiveFrom",
        path: ["expiresAt"],
      });
    }
  });

/**
 * Exception PATCH body: each field optional. The `effectiveFrom < expiresAt`
 * window is re-checked against the merged row by the storage `CHECK` (mapped to
 * a 400), since a PATCH may move only one bound.
 */
export const updateExceptionSchema = z
  .object({
    targetKind: scopeSchema.optional(),
    targetId: targetIdSchema.optional(),
    action: scheduleActionSchema.optional(),
    reason: z.string().trim().min(1).max(500).nullable().optional(),
    effectiveFrom: z.string().datetime().nullable().optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const exceptionResponseSchema = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  targetKind: scopeSchema,
  targetId: z.number().int().nullable(),
  action: scheduleActionSchema,
  reason: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

export type CreateExceptionRequest = z.infer<typeof createExceptionSchema>;
export type UpdateExceptionRequest = z.infer<typeof updateExceptionSchema>;
export type ExceptionResponse = z.infer<typeof exceptionResponseSchema>;

/** Map a stored exception row to its wire DTO (timestamps → ISO-8601 UTC). */
export function toExceptionResponse(row: ExceptionRow): ExceptionResponse {
  return {
    id: row.id,
    userId: row.userId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    action: row.action,
    reason: row.reason,
    effectiveFrom: row.effectiveFrom === null ? null : row.effectiveFrom.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Notification policy (#104) --------------------------------------------

/**
 * Per-user notification settings (`docs/client-notifications.md` →
 * "Configuration knobs"). Bounds and the sound-profile enum come from their
 * single source (`policy/notification.ts`, `policy/enums.ts`) so the wire
 * contract, the storage `CHECK`, and the synthesized defaults can't drift.
 *
 * `cadenceOverrides` is an optional object of per-budget warning-cadence
 * overrides (the override grammar itself is the agent's concern, #103); `null`
 * means "use the built-in 15/5/1-minute cadence".
 */
const cadenceOverridesSchema = z.record(z.string(), z.unknown());

/**
 * Notification-policy upsert body (`PUT`). Every field is optional: an omitted
 * field takes the documented default on first write, or is left unchanged on a
 * later write. The body must carry at least one field.
 */
export const upsertNotificationPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    soundProfile: soundProfileSchema.optional(),
    graceSeconds: notificationGraceSecondsSchema.optional(),
    // Present (incl. explicit null) ⇒ change; absent ⇒ leave unchanged.
    cadenceOverrides: cadenceOverridesSchema.nullable().optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const notificationPolicyResponseSchema = z.object({
  userId: z.number().int(),
  enabled: z.boolean(),
  soundProfile: soundProfileSchema,
  graceSeconds: z.number().int(),
  cadenceOverrides: cadenceOverridesSchema.nullable(),
});

export type UpsertNotificationPolicyRequest = z.infer<typeof upsertNotificationPolicySchema>;
export type NotificationPolicyResponse = z.infer<typeof notificationPolicyResponseSchema>;

/** Map a stored notification-policy row to its wire DTO. */
export function toNotificationPolicyResponse(
  row: NotificationPolicyRow,
): NotificationPolicyResponse {
  return {
    userId: row.userId,
    enabled: row.enabled,
    soundProfile: row.soundProfile,
    graceSeconds: row.graceSeconds,
    cadenceOverrides: row.cadenceOverridesJson ?? null,
  };
}

/**
 * The effective notification policy for a user when no row is persisted — the
 * documented defaults. Every user always *has* an effective policy; it sits at
 * defaults until the admin customises it.
 */
export function defaultNotificationPolicyResponse(userId: number): NotificationPolicyResponse {
  const defaults = defaultNotificationPolicy();
  return { userId, ...defaults };
}

// --- Group schedules (#182) ------------------------------------------------
// Group-targeted recurring rules (ADR 0007). Identical to the user-keyed
// schedule DTOs minus `userId` — the owning group comes from the
// `/user-groups/:groupId/schedules` path. The PATCH body is identical to a
// user schedule's ({@link updateScheduleSchema}) and is reused there.

/**
 * Group-schedule create body: the rule's target/action/order, intersected with
 * the shared recurrence + date-scoping fields ({@link scheduleRecurrenceSchema}).
 * No `userId` — the group is the path param.
 */
export const createGroupScheduleSchema = z.intersection(
  z.object({
    targetKind: scopeSchema,
    targetId: targetIdSchema.default(null),
    action: scheduleActionSchema,
    ordinal: z.number().int().min(0).optional(),
  }),
  scheduleRecurrenceSchema,
);

export const groupScheduleResponseSchema = z.object({
  id: z.number().int(),
  userGroupId: z.number().int(),
  targetKind: scopeSchema,
  targetId: z.number().int().nullable(),
  action: scheduleActionSchema,
  recurrenceDays: z.number().int().nullable(),
  recurrenceStartMinute: z.number().int().nullable(),
  recurrenceEndMinute: z.number().int().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  ordinal: z.number().int(),
});

export type CreateGroupScheduleRequest = z.infer<typeof createGroupScheduleSchema>;
export type GroupScheduleResponse = z.infer<typeof groupScheduleResponseSchema>;

/** Map a stored group-schedule row to its wire DTO (timestamps → ISO-8601 UTC). */
export function toGroupScheduleResponse(row: GroupScheduleRow): GroupScheduleResponse {
  return {
    id: row.id,
    userGroupId: row.userGroupId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    action: row.action,
    recurrenceDays: row.recurrenceDays,
    recurrenceStartMinute: row.recurrenceStartMinute,
    recurrenceEndMinute: row.recurrenceEndMinute,
    effectiveFrom: row.effectiveFrom === null ? null : row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo === null ? null : row.effectiveTo.toISOString(),
    ordinal: row.ordinal,
  };
}

// --- Group schedule ordering (#270) ----------------------------------------

/**
 * A group's schedules in evaluation order, plus the **structural** shadow
 * findings — the group counterpart of {@link ScheduleOrderView} (#63),
 * consumed by the group drag-to-reorder editor.
 *
 * It deliberately omits `effectiveIds`: a group has no single timezone (members
 * may sit in different zones), so "in effect right now" is only meaningful once
 * resolved per member (`GET /users/:userId/effective`), not for the group as a
 * whole. `shadows` is purely structural (identical recurrence window + target
 * superset; no tz, no instant — see `policy/schedule-precedence.ts`), so it
 * stays fully meaningful here. The precedence math stays in one place; this
 * view never re-derives it.
 */
export const groupScheduleOrderViewSchema = z.object({
  schedules: z.array(groupScheduleResponseSchema),
  shadows: z.array(shadowFindingSchema),
});
export type GroupScheduleOrderView = z.infer<typeof groupScheduleOrderViewSchema>;

/** Assemble a {@link GroupScheduleOrderView} from ordered rows + the shadow facts. */
export function toGroupScheduleOrderView(
  rows: readonly GroupScheduleRow[],
  shadows: readonly ShadowFindingDto[],
): GroupScheduleOrderView {
  return {
    schedules: rows.map(toGroupScheduleResponse),
    shadows: shadows.map((s) => ({ shadowedId: s.shadowedId, shadowedById: s.shadowedById })),
  };
}

// --- Group exceptions (#182) -----------------------------------------------
// Group-targeted one-off overrides (ADR 0007). Identical to the user-keyed
// exception DTOs minus `userId`; the PATCH body reuses {@link updateExceptionSchema}.

/**
 * Group-exception create body. Active during `[effectiveFrom ?? createdAt,
 * expiresAt)`; the superRefine enforces `effectiveFrom < expiresAt`. No
 * `userId` — the group is the path param.
 */
export const createGroupExceptionSchema = z
  .object({
    targetKind: scopeSchema,
    targetId: targetIdSchema.default(null),
    action: scheduleActionSchema,
    reason: z.string().trim().min(1).max(500).nullable().default(null),
    effectiveFrom: z.string().datetime().nullable().default(null),
    expiresAt: z.string().datetime(),
  })
  .superRefine((value, ctx) => {
    if (
      value.effectiveFrom !== null &&
      Date.parse(value.effectiveFrom) >= Date.parse(value.expiresAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expiresAt must be after effectiveFrom",
        path: ["expiresAt"],
      });
    }
  });

export const groupExceptionResponseSchema = z.object({
  id: z.number().int(),
  userGroupId: z.number().int(),
  targetKind: scopeSchema,
  targetId: z.number().int().nullable(),
  action: scheduleActionSchema,
  reason: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

export type CreateGroupExceptionRequest = z.infer<typeof createGroupExceptionSchema>;
export type GroupExceptionResponse = z.infer<typeof groupExceptionResponseSchema>;

/** Map a stored group-exception row to its wire DTO (timestamps → ISO-8601 UTC). */
export function toGroupExceptionResponse(row: GroupExceptionRow): GroupExceptionResponse {
  return {
    id: row.id,
    userGroupId: row.userGroupId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    action: row.action,
    reason: row.reason,
    effectiveFrom: row.effectiveFrom === null ? null : row.effectiveFrom.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// --- "Add time today" same-day adjustment (#257) ---------------------------

/**
 * The most a single adjustment may add, subtract, or set — one day in seconds.
 * `timekpra` tracks today's remaining time, so anything beyond a day is a
 * fat-finger rather than a real intent; the bound keeps the lever sane.
 */
export const TIME_TODAY_MAX_SECONDS = 86_400;

/**
 * Body of `POST /users/:userId/time-today`: adjust the user's **remaining time
 * for today** on their linked client(s), without touching the standing daily
 * `Budget` (#257). Exactly one of:
 *
 * - `deltaSeconds` — a signed, non-zero adjustment (`+1800` = "+30 min",
 *   `-600` = "take back 10 min"), or
 * - `setSeconds` — set today's remaining time outright (`0` = lock out now).
 *
 * `clientId`, when given, restricts the adjustment to that one linked client;
 * omitted, it applies to every client the user is linked to.
 */
export const adjustTimeTodaySchema = z
  .object({
    deltaSeconds: z
      .number()
      .int()
      .min(-TIME_TODAY_MAX_SECONDS)
      .max(TIME_TODAY_MAX_SECONDS)
      .refine((n) => n !== 0, { message: "deltaSeconds must be non-zero" })
      .optional(),
    setSeconds: z.number().int().min(0).max(TIME_TODAY_MAX_SECONDS).optional(),
    clientId: z.number().int().positive().optional(),
  })
  .refine((b) => (b.deltaSeconds === undefined) !== (b.setSeconds === undefined), {
    message: "Provide exactly one of deltaSeconds or setSeconds",
  });

/** The `timekpra --settimeleft` operation: `+`/`-` delta, or `=` set. */
export const timeLeftOperationSchema = z.enum(["+", "-", "="]);

/** Per-client outcome of an adjustment (mirrors the transport service result). */
export const clientAdjustmentResultSchema = z.object({
  clientId: z.number().int(),
  osUsername: z.string(),
  status: z.enum(["applied", "unreachable", "failed"]),
  error: z.string().optional(),
});

/** Response of `POST /users/:userId/time-today`: the resolved op + per-client results. */
export const timeTodayResponseSchema = z.object({
  userId: z.number().int(),
  operation: timeLeftOperationSchema,
  // The applied magnitude in seconds — always the non-negative count passed to
  // `--settimeleft`, bounded like the request (one day max).
  seconds: z.number().int().min(0).max(TIME_TODAY_MAX_SECONDS),
  results: z.array(clientAdjustmentResultSchema),
});

export type AdjustTimeTodayRequest = z.infer<typeof adjustTimeTodaySchema>;
export type ClientAdjustmentResultDto = z.infer<typeof clientAdjustmentResultSchema>;
export type TimeTodayResponse = z.infer<typeof timeTodayResponseSchema>;

/**
 * Resolve the request body to the `timekpra --settimeleft` operation + a
 * non-negative second count. A positive delta adds (`+`), a negative delta
 * subtracts (`-`) its magnitude, and `setSeconds` sets outright (`=`). The DTO's
 * `refine` guarantees exactly one branch applies.
 */
export function toTimeLeftCommand(body: AdjustTimeTodayRequest): {
  operation: z.infer<typeof timeLeftOperationSchema>;
  seconds: number;
} {
  if (body.deltaSeconds !== undefined) {
    return body.deltaSeconds >= 0
      ? { operation: "+", seconds: body.deltaSeconds }
      : { operation: "-", seconds: -body.deltaSeconds };
  }
  // The refine guarantees setSeconds is present when deltaSeconds is not.
  return { operation: "=", seconds: body.setSeconds ?? 0 };
}
