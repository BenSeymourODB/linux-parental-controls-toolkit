/**
 * The inbound integration grant endpoint (#113), pinned by ADR 0014.
 *
 * `POST /api/integrations/grants` — an external integrator (first:
 * next-digital-wall-calendar) records a screen-time grant. Registered inside the
 * `/api` plugin scope **after** {@link registerIntegrationRoutes} (which
 * decorates `scope.requireIntegrationToken`), so it can gate itself on a scoped
 * bearer token with `{ preHandler: scope.requireIntegrationToken("grants:write") }`.
 *
 * Scope is **record + dedupe only** (ADR 0014): it writes an immutable, additive
 * `Grant` row, idempotent by the integrator-supplied `source_ref`. Emitting
 * `grant.applied` + recomputing/pushing the effective budget is #117; per-token
 * rate limiting is #115; the ledger admin UI is #116.
 *
 * The handler maps the snake_case external wire DTO onto the camelCase policy
 * repository at the boundary, resolves `user_ref` → `User`, validates the
 * `target` against existing rows, checks `expires_at` is in the future, and
 * stamps `source` from the authenticated token — none of which the DTO can do on
 * its own.
 *
 * License boundary: none touched — plain TypeScript + zod + Fastify + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import { ApiError } from "../errors.js";
import type { PolicyDb } from "../../policy/db.js";
import type { Scope } from "../../policy/enums.js";
import { createGrant, findGrantBySourceRef, type GrantRow } from "../../policy/grants.js";
import { isCheckViolation, isUniqueViolation } from "../../policy/repository.js";
import * as repo from "../../policy/repository.js";
import type { ZodTypeProvider } from "../validation.js";
import { createGrantSchema, type GrantResponse } from "./grant-dtos.js";

/** Serialise a stored grant row to its snake_case wire response. */
function toGrantResponse(row: GrantRow): GrantResponse {
  return {
    id: row.id,
    user_id: row.userId,
    scope: row.scope,
    target: row.targetId,
    seconds: row.secondsGranted,
    expires_at: row.expiresAt.toISOString(),
    source: row.source,
    source_ref: row.sourceRef,
    reason: row.reason,
    granted_at: row.grantedAt.toISOString(),
    revoked_at: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Resolve the wire `user_ref` to a dashboard `User.id`. v1: `user_ref` is the
 * id in decimal-string form (ADR 0014 §1). A non-decimal or unknown ref is a
 * `404` — the same code either way so the contract stays forward-compatible when
 * a future release also accepts a human alias.
 */
function resolveUserRef(db: PolicyDb, userRef: string): number {
  const isDecimal = /^\d+$/.test(userRef);
  const id = isDecimal ? Number(userRef) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0 || repo.getUser(db, id) === undefined) {
    throw new ApiError(404, "not_found", `No user matches user_ref "${userRef}"`);
  }
  return id;
}

/**
 * Resolve the `target` for a scoped grant to its `target_id`, validating that
 * the referenced row exists. `overall` ⇒ `null`; `activity` ⇒ `activities.id`;
 * `group` ⇒ `activity_groups.id`. The DTO has already enforced target
 * presence/absence coherence, so `target` is defined here iff scope needs it.
 */
function resolveTargetId(db: PolicyDb, scope: Scope, target: number | undefined): number | null {
  if (scope === "overall") return null;
  // Coherence guaranteed by the DTO's superRefine (non-overall ⇒ target set);
  // this guard narrows the type without an unchecked cast and is a defensive
  // 400 should that invariant ever change.
  if (target === undefined) {
    throw new ApiError(400, "validation_error", `target is required for the '${scope}' scope`);
  }
  const exists =
    scope === "activity"
      ? repo.getActivity(db, target) !== undefined
      : repo.getActivityGroup(db, target) !== undefined;
  if (!exists) {
    const kind = scope === "activity" ? "activity" : "activity group";
    throw new ApiError(404, "not_found", `No ${kind} matches target ${target}`);
  }
  return target;
}

/**
 * Register the inbound integration grant route on an already-`/api`-prefixed
 * scope. Call **after** {@link registerIntegrationRoutes} so
 * `scope.requireIntegrationToken` is decorated.
 */
export function registerIntegrationGrantRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/integrations/grants",
    {
      preHandler: scope.requireIntegrationToken("grants:write"),
      schema: { body: createGrantSchema },
    },
    async (request, reply): Promise<GrantResponse> => {
      const {
        user_ref,
        scope: grantScope,
        target,
        seconds,
        expires_at,
        source_ref,
        reason,
      } = request.body;

      // The guard sets `request.integration` on success; null is defensive.
      const integration = request.integration;
      if (integration === null) {
        throw new ApiError(401, "unauthorized", "Integration token did not authenticate");
      }

      // Idempotent replay: a source_ref already in the ledger returns the
      // recorded grant unchanged, with 200 (ADR 0014 §5).
      const existing = findGrantBySourceRef(scope.db, source_ref);
      if (existing !== undefined) {
        request.log.info(
          { event: "integration_grant_replayed", grantId: existing.id, sourceRef: source_ref },
          "integration grant replayed (idempotent)",
        );
        reply.code(200);
        return toGrantResponse(existing);
      }

      const userId = resolveUserRef(scope.db, user_ref);
      const targetId = resolveTargetId(scope.db, grantScope, target);

      if (new Date(expires_at).getTime() <= Date.now()) {
        throw new ApiError(400, "validation_error", "expires_at must be in the future");
      }

      let created: GrantRow;
      try {
        created = createGrant(scope.db, {
          userId,
          scope: grantScope,
          targetId,
          secondsGranted: seconds,
          expiresAt: new Date(expires_at),
          source: `integration:${integration.name}`,
          sourceRef: source_ref,
          reason: reason ?? null,
        });
      } catch (err) {
        // Lost a race to a concurrent first-sighting of the same source_ref:
        // the UNIQUE index rejected the insert — return the winner's row (200).
        if (isUniqueViolation(err)) {
          const winner = findGrantBySourceRef(scope.db, source_ref);
          if (winner !== undefined) {
            reply.code(200);
            return toGrantResponse(winner);
          }
        }
        // A storage invariant (seconds > 0, target coherence, source shape) the
        // DTO didn't catch → 400 rather than a leaked 500.
        if (isCheckViolation(err)) {
          throw new ApiError(400, "validation_error", "Grant violates a storage constraint");
        }
        throw err;
      }

      request.log.info(
        {
          event: "integration_grant_created",
          grantId: created.id,
          userId,
          scope: grantScope,
          source: created.source,
          sourceRef: source_ref,
        },
        "integration grant recorded",
      );
      reply.code(201);
      return toGrantResponse(created);
    },
  );
}
