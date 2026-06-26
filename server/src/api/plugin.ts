/**
 * The `/api` Fastify plugin: one encapsulated scope that installs the shared
 * validation/envelope conventions and mounts the JSON routes. Mounting it
 * under the `/api` prefix keeps the conventions (and the auth/policy/
 * integration routes) from touching `/`, `/healthz`, `/admin`, or `/app`.
 *
 * License boundary: none touched.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import { registerAuth } from "../auth/index.js";
import type { Settings } from "../config.js";
import { registerEventStream, type EventHub, type EventStreamOptions } from "../events/index.js";
import type { TimeTodayAdjuster } from "../transport/policy-push/index.js";
import type { PolicyPushStub } from "../transport/stub.js";
import { registerAuditRoutes } from "./audit/index.js";
import { registerClientEnrolmentRoutes, registerClientHealthRoutes } from "./clients/index.js";
import { registerDnsRoutes } from "./dns/index.js";
import { registerIntegrationRoutes } from "./integrations/index.js";
import { registerMetaRoute } from "./meta.js";
import {
  registerEffectiveRoutes,
  registerPolicyRoutes,
  registerScheduleOrderRoutes,
  registerPreviewRoutes,
  registerTimeTodayRoutes,
} from "./policy/index.js";
import { registerRetentionRoutes } from "./retention/index.js";
import { registerSystemRoutes } from "./system/index.js";
import { registerUsageRoutes } from "./usage/index.js";
import { installApiConventions } from "./validation.js";

/** Options the `/api` plugin needs from its host app. */
export interface ApiPluginOptions {
  /** Parsed settings (auth keys, etc.) threaded in from {@link registerApi}. */
  settings: Settings;
  /**
   * The process-wide event fan-out registry (#100), created in `buildApp` and
   * decorated as `app.eventHub`. Threaded in so the `/api/events/stream` route
   * registers against the same instance producers publish onto.
   */
  eventHub: EventHub;
  /**
   * The outbound policy-push dispatcher (#201) the CRUD routes dispatch through.
   * Omitted in tests / before the SSH-key bootstrap (#39), where the routes fall
   * back to the logging stub (#54).
   */
  policyPush?: PolicyPushStub;
  /**
   * The awaitable "Add time today" adjuster (#257), present only when the live
   * transport is wired (SSH key exists). Absent in tests / before the SSH-key
   * bootstrap (#39), where `POST /users/:userId/time-today` returns a
   * `503 transport_unavailable`.
   */
  timeToday?: TimeTodayAdjuster;
  /**
   * Tuning/test seam for the event-stream handshake (heartbeat interval, hello
   * timeout, negotiated server protocol). Omitted in production, where the
   * route uses its defaults.
   */
  eventStream?: EventStreamOptions;
}

/**
 * The encapsulated `/api` plugin: conventions first, then auth (cookie plugin,
 * the `requireAdmin` guard, bootstrap, and the auth routes), then the rest of
 * the routes. Auth is installed before other routes so its `requireAdmin`
 * decoration is available to them within this scope.
 */
export const apiPlugin: FastifyPluginAsync<ApiPluginOptions> = async (scope, opts) => {
  installApiConventions(scope);
  await registerAuth(scope, opts.settings);
  registerMetaRoute(scope);
  // Policy CRUD (#51) — registered after auth so `scope.requireAdmin` exists.
  // The live SSH dispatcher (#201) is injected from buildApp; absent it, the
  // routes log the intended push (the Phase-2 stub) instead of dispatching.
  registerPolicyRoutes(scope, opts.policyPush);
  // "Add time today" same-day lever (#257): POST /users/:userId/time-today.
  // The live `timekpra`-over-SSH adjuster is injected from buildApp; absent it,
  // the route reports the transport as unavailable (503).
  registerTimeTodayRoutes(scope, opts.timeToday);
  // Effective-policy preview (#143): GET /users/:userId/effective. Needs
  // `settings` for the server-default timezone of users with no `tz`.
  registerEffectiveRoutes(scope, opts.settings);
  // Schedule drag-to-reorder editor support (#63): GET/PUT
  // /users/:userId/schedules/order. Needs `settings` for the server-default
  // timezone used to resolve which rule is in effect "right now".
  registerScheduleOrderRoutes(scope, opts.settings);
  // Usage views (#62): admin-only read of per-budget burndown + the
  // per-activity timeline, the data source for the Phase-5 chart components.
  // Needs `settings` for the server-default timezone of users with no `tz`.
  registerUsageRoutes(scope, opts.settings);
  // Save-and-push preview (#64): POST /users/:userId/policy-preview — the
  // side-effect-free "what will change on each client" diff before a save.
  registerPreviewRoutes(scope, opts.settings);
  // Client enrolment (#77): admin-minted token + the install script's enrol
  // exchange. `settings` carries the SSH-public-key path the enrol response returns.
  registerClientEnrolmentRoutes(scope, opts.settings);
  // Event stream (#100): GET /api/events/stream WebSocket, per-client bearer
  // auth. Registered against the shared event hub so producers publish onto
  // the same registry. Async because it registers @fastify/websocket.
  await registerEventStream(scope, opts.eventHub, opts.eventStream ?? {});
  // Client health/status (#81): the read-only Clients-page reads. The live SSH
  // prober is injected once the SSH-key bootstrap (#39) plumbs credentials;
  // until then the routes degrade to `unknown` reachability/components while
  // still surfacing real enrolment + offline-queue state. The fan-out bounds
  // (#198) are passed now so they're ready when the prober lands.
  registerClientHealthRoutes(scope, {
    probeConcurrency: opts.settings.clientHealth.probeConcurrency,
    probeDeadlineMs: opts.settings.clientHealth.probeDeadlineMs,
  });
  // Transport audit log (#85): admin-only read of every command issued to a client.
  registerAuditRoutes(scope);
  // Retention config (#136): admin-only read/write of data-retention windows.
  // Needs `settings` for the global default window.
  registerRetentionRoutes(scope, opts.settings);
  // DNS status (#95): admin-only read of the active AdGuard mode + health.
  registerDnsRoutes(scope);
  // System status (#39): admin-only read of first-run subsystem health (the
  // Ansible venv bootstrap, so the admin sees when/why Ansible is unavailable).
  registerSystemRoutes(scope);
  // Integration tokens (#114): admin-only mint/list/revoke of per-integration
  // bearer tokens, and the `scope.requireIntegrationToken` guard the inbound
  // `/api/integrations/*` endpoints (#113) authenticate with.
  registerIntegrationRoutes(scope);
};

/** Mount the JSON API under `/api` on the given app. */
export function registerApi(
  app: FastifyInstance,
  settings: Settings,
  eventHub: EventHub,
  policyPush?: PolicyPushStub,
  timeToday?: TimeTodayAdjuster,
  eventStream?: EventStreamOptions,
): void {
  app.register(apiPlugin, {
    prefix: "/api",
    settings,
    eventHub,
    // Spread only when present: under exactOptionalPropertyTypes an explicit
    // `undefined` is not assignable to the optional `policyPush?` field.
    ...(policyPush !== undefined ? { policyPush } : {}),
    ...(timeToday !== undefined ? { timeToday } : {}),
    ...(eventStream !== undefined ? { eventStream } : {}),
  });
}
