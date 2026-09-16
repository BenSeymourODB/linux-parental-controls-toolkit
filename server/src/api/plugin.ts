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
import type { ClientProber } from "../transport/health/index.js";
import type { PolicyPushNow, TimeTodayAdjuster } from "../transport/policy-push/index.js";
import type { PolicyPushStub } from "../transport/stub.js";
import { registerAppAuthRoutes } from "./app/index.js";
import { registerAuditRoutes } from "./audit/index.js";
import { registerClientEnrolmentRoutes, registerClientHealthRoutes } from "./clients/index.js";
import { registerDnsRoutes } from "./dns/index.js";
import { registerIntegrationGrantRoutes, registerIntegrationRoutes } from "./integrations/index.js";
import { registerMetaRoute } from "./meta.js";
import {
  registerEffectiveRoutes,
  registerPolicyRoutes,
  registerPushNowRoutes,
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
   * The manual "push saved policy now" lever (#304), present only when the live
   * transport is wired (SSH key exists). Absent in tests / before the SSH-key
   * bootstrap (#39), where `POST /users/:userId/policy-push` returns a
   * `503 transport_unavailable`.
   */
  pushPolicyNow?: PolicyPushNow;
  /**
   * The live SSH client health prober (#81), present only when the live
   * transport is wired (SSH key exists). Injected into the
   * `/api/clients/health` routes; absent, those routes report
   * reachability/components as `unknown` (queue + enrolment state stays real).
   */
  prober?: ClientProber;
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
  // Per-user PIN auth (#112): admin set/reset/clear of a child's PIN, the
  // `/app` PIN session (login/logout/whoami), and the first own-data-only read
  // (`GET /api/app/me`). Registered after auth so `scope.requireAdmin` /
  // `scope.requirePinSession` exist and the cookie plugin is installed.
  registerAppAuthRoutes(scope, opts.settings);
  registerMetaRoute(scope);
  // Policy CRUD (#51) — registered after auth so `scope.requireAdmin` exists.
  // The live SSH dispatcher (#201) is injected from buildApp; absent it, the
  // routes log the intended push (the Phase-2 stub) instead of dispatching.
  registerPolicyRoutes(scope, opts.policyPush);
  // "Add time today" same-day lever (#257): POST /users/:userId/time-today.
  // The live `timekpra`-over-SSH adjuster is injected from buildApp; absent it,
  // the route reports the transport as unavailable (503).
  registerTimeTodayRoutes(scope, opts.timeToday);
  // Manual "push saved policy now" lever (#304): POST /users/:userId/policy-push.
  // The live pusher is injected from buildApp; absent it, the route reports the
  // transport as unavailable (503).
  registerPushNowRoutes(scope, opts.pushPolicyNow);
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
  // "what will change on each client" diff before a save. Side-effect-free by
  // default; the live prober (injected like the Clients routes, absent pre-#39)
  // powers the opt-in `probe: true` live-reachability marker (#281).
  registerPreviewRoutes(scope, opts.settings, opts.prober);
  // Client enrolment (#77): admin-minted token + the install script's enrol
  // exchange. `settings` carries the SSH-public-key path the enrol response returns.
  registerClientEnrolmentRoutes(scope, opts.settings);
  // Event stream (#100): GET /api/events/stream WebSocket, per-client bearer
  // auth. Registered against the shared event hub so producers publish onto
  // the same registry. Async because it registers @fastify/websocket.
  // The compatibility window is threaded from settings (the single source of
  // truth, #352) unless a test injects a full `eventStream` override.
  await registerEventStream(scope, opts.eventHub, {
    compatWindow: opts.settings.protocolCompatWindow,
    ...(opts.eventStream ?? {}),
  });
  // Client health/status (#81): the read-only Clients-page reads. The live SSH
  // prober is injected from buildApp when the SSH-key bootstrap (#39) has run
  // and the policy-push transport is live; without it (dev/CI/tests, or a
  // server before first-run keygen) the routes degrade to `unknown`
  // reachability/components while still surfacing real enrolment +
  // offline-queue state. The fan-out bounds (#198) bound the live probe walk.
  registerClientHealthRoutes(scope, {
    ...(opts.prober !== undefined ? { prober: opts.prober } : {}),
    probeConcurrency: opts.settings.clientHealth.probeConcurrency,
    probeDeadlineMs: opts.settings.clientHealth.probeDeadlineMs,
    ...(opts.settings.serverVersion !== undefined
      ? { serverVersion: opts.settings.serverVersion }
      : {}),
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
  // Inbound integration grants (#113, ADR 0014): external integrators record
  // screen-time grants via a `grants:write` bearer token. Must follow
  // `registerIntegrationRoutes`, which decorates `scope.requireIntegrationToken`.
  registerIntegrationGrantRoutes(scope);
};

/** Mount the JSON API under `/api` on the given app. */
export function registerApi(
  app: FastifyInstance,
  settings: Settings,
  eventHub: EventHub,
  policyPush?: PolicyPushStub,
  timeToday?: TimeTodayAdjuster,
  pushPolicyNow?: PolicyPushNow,
  prober?: ClientProber,
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
    ...(pushPolicyNow !== undefined ? { pushPolicyNow } : {}),
    ...(prober !== undefined ? { prober } : {}),
    ...(eventStream !== undefined ? { eventStream } : {}),
  });
}
