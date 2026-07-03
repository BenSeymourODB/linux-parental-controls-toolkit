/**
 * Policy CRUD composition root (#51/#148/#225).
 *
 * `registerPolicyRoutes` was a single ~1330-line function registering 5–7 CRUD
 * endpoints for each of ~13 entities. It is now a thin composition that calls
 * one focused registrar per entity (under `./routes/`), in the original
 * registration order; the shared error mappers, existence guards,
 * target-coherence check, group push fan-out, and PATCH update-payload builders
 * live in `./routes/shared.ts`.
 *
 * All routes register inside the `/api` plugin scope (after `registerAuth`) so
 * each inherits the zod validator compiler + shared error envelope and sits
 * behind the `requireAdmin` guard — anonymous requests get a `401` envelope,
 * never an unguarded read/write (`CLAUDE.md` → "no privileged in-process
 * shortcuts"). Handlers stay thin: validate via the DTOs, delegate to the
 * `policy/repository` service over `app.db`, and map "missing row" → `404` and
 * unique-constraint collisions → `409`.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import { createPolicyPushStub, type PolicyPushStub } from "../../transport/stub.js";
import { registerActivityRoutes } from "./routes/activities.js";
import { registerActivityGroupRoutes } from "./routes/activity-groups.js";
import { registerBudgetRoutes } from "./routes/budgets.js";
import { registerClientRoutes } from "./routes/clients.js";
import { registerExceptionRoutes } from "./routes/exceptions.js";
import { registerGroupBudgetRoutes } from "./routes/group-budgets.js";
import { registerGroupExceptionRoutes } from "./routes/group-exceptions.js";
import { registerGroupScheduleRoutes } from "./routes/group-schedules.js";
import { registerLinkRoutes } from "./routes/links.js";
import { registerNotificationPolicyRoutes } from "./routes/notification-policy.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerUserGroupRoutes } from "./routes/user-groups.js";
import { registerUserRoutes } from "./routes/users.js";

// The 404 helpers keep their historical `./routes.js` import path (a test and
// potential integrators import them from here) even though they now live in the
// shared registrar module.
export { assertFound, assertRemoved, notFound } from "./routes/shared.js";

/**
 * Register the policy CRUD routes on an already-`/api`-prefixed scope. Call
 * after {@link registerAuth} so `scope.requireAdmin` is decorated.
 *
 * Every successful mutation hands the intended per-client effect to `push`. In
 * production that is the live `timekpra`-over-SSH dispatcher (#201, wired in
 * `buildApp`), which pushes to reachable clients and queues for offline ones
 * (#84) — see `transport/policy-push/` and `docs/architecture.md` → "Outbound
 * (server → client) — policy push". When no dispatcher is injected (no SSH key
 * yet, #39; or a test), it defaults to the logging stub (#54), so CRUD still
 * works and the change is logged rather than dispatched.
 *
 * The registrars are called in the original registration order. Activities,
 * activity-groups, and user-groups take no `push` — grouping definitions has no
 * per-client effect until a budget/schedule references them.
 */
export function registerPolicyRoutes(scope: FastifyInstance, push?: PolicyPushStub): void {
  const pushStub = push ?? createPolicyPushStub(scope.log);

  registerUserRoutes(scope, pushStub);
  registerClientRoutes(scope, pushStub);
  registerLinkRoutes(scope, pushStub);
  registerActivityRoutes(scope);
  registerActivityGroupRoutes(scope);
  registerUserGroupRoutes(scope);
  registerGroupScheduleRoutes(scope, pushStub);
  registerGroupExceptionRoutes(scope, pushStub);
  registerGroupBudgetRoutes(scope, pushStub);
  registerBudgetRoutes(scope, pushStub);
  registerScheduleRoutes(scope, pushStub);
  registerExceptionRoutes(scope, pushStub);
  registerNotificationPolicyRoutes(scope, pushStub);
}
