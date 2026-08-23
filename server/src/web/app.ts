/**
 * Fastify app composition.
 *
 * `buildApp()` is a factory (not a module-level singleton) so tests can
 * construct isolated instances and exercise routes via `app.inject()`
 * without binding a socket — see docs/testing.md → "HTTP routes".
 *
 * Beyond the Phase 1 slice — a "hello, no policy yet" landing route and a
 * `/healthz` probe, plus the shared pino logging configuration (#11) — this
 * now also mounts the JSON API at `/api` (#50) and the prerendered SvelteKit
 * build at `/admin` and `/app` (#40). The policy/integrations routes land on
 * top of the `/api` conventions in later phases.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { registerApi } from "../api/index.js";
import { loadSettings, type Settings } from "../config.js";
import { type EventStreamOptions } from "../events/index.js";
import { type PolicyDb } from "../policy/db.js";
import type { EnforcementPipelineHandle } from "../enforcement/index.js";
import type { RetentionPurgeSchedulerHandle } from "../retention/index.js";
import { type AnsibleVenvSupervisor } from "../setup/ansible-venv.js";
import {
  type AdGuardHealthPollHandle,
  type AdGuardManagedSupervisor,
  type AdGuardService,
} from "../transport/adguard/index.js";
import { type PolicyPushTransport } from "../transport/policy-push/index.js";
import { buildAppServices } from "./app-services.js";
import { registerFrontend } from "./frontend.js";
import { registerInstallScript } from "./install-script.js";
import { REQUEST_ID_HEADER, buildLoggerOptions, genRequestId, type LogStream } from "./logger.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * The shared policy-store connection (#49). Routes and the policy service
     * read and write through this single Drizzle handle. Created from settings
     * (migrated on boot) unless one is injected via {@link BuildAppOptions.db}.
     */
    db: PolicyDb;
    /**
     * The DNS mode router + external-mode preflight state (#95). Routes read its
     * `status` snapshot; later DNS producers (#97) read its client. Built from
     * `settings.adguard` unless injected via {@link BuildAppOptions.adguard}.
     */
    adguard: AdGuardService;
    /**
     * The first-run Ansible venv bootstrap supervisor (#39). `GET
     * /api/system/ansible` reads its `status` snapshot. Built from settings
     * here but **not** run by `buildApp`: `main.ts` fires `bootstrap()` after
     * `listen` (a slow `pip install` must not block startup), so building the
     * app — including in tests — spawns nothing.
     */
    ansibleVenv: AnsibleVenvSupervisor;
    /**
     * The managed-mode AdGuard Home supervisor (#96), or `null` when
     * `PCT_ADGUARD_MODE` is not `managed`. `GET /api/system/adguard-managed`
     * reads its `status`. Built (or injected) here so the route has a snapshot
     * to serialise, but **not** run by `buildApp`: `main.ts` fires `bootstrap()`
     * after `listen` (a first-run download must not block startup), and it is
     * `stop()`ped on `app.close()`.
     */
    adguardManaged: AdGuardManagedSupervisor | null;
    /**
     * The managed-mode AdGuard health poller handle (#283), or `null` until
     * wired. Like the other schedulers it is **not** started by `buildApp` (so
     * building the app — including tests — starts no timer); `main.ts` assigns
     * it after `listen` in `managed` mode. `buildApp` only owns its teardown: an
     * `onClose` hook stops it if set.
     */
    adguardHealthPoll: AdGuardHealthPollHandle | null;
    /**
     * The Phase-8 enforcement pipeline (#327): telemetry pull → #88 usage
     * rollup → per-activity enforcement sweep, or `null` when the dashboard has
     * no SSH key yet (nothing is reachable). Like the other schedulers it is
     * **constructed** here but **not** started by `buildApp` (so building the
     * app — including every test — starts no timer); `main.ts` calls `start()`
     * after `listen`, and `buildApp`'s `onClose` hook stops it.
     */
    enforcementPipeline: EnforcementPipelineHandle | null;
    /**
     * The Phase-11 scheduled retention purge (#137): the croner job that
     * enforces the configured retention windows and records each run. Always
     * present (a purge is pure DB maintenance, needing no SSH). **Constructed**
     * here but **not** started by `buildApp` (so building the app — including
     * every test — starts no timer); `main.ts` calls `start()` after `listen`,
     * and `buildApp`'s `onClose` teardown stops it.
     */
    retentionPurge: RetentionPurgeSchedulerHandle;
  }
}

/** Options for {@link buildApp}. */
export interface BuildAppOptions {
  /** Parsed settings; defaults to {@link loadSettings} reading `process.env`. */
  settings?: Settings;
  /**
   * Test seam: capture log output via a pino destination stream. Takes
   * precedence over the `pino-pretty` transport.
   */
  loggerStream?: LogStream;
  /**
   * Inject a policy-store handle (tests pass the in-memory `testDb()`). When
   * omitted, {@link buildApp} opens and migrates one from `settings` via
   * {@link createDb} and owns its lifecycle — closing it on `app.close()`. An
   * injected handle is left open; its owner closes it.
   */
  db?: PolicyDb;
  /**
   * Inject an {@link AdGuardService} (tests pass one wired to a fake `fetch`).
   * When omitted, {@link buildApp} builds one from `settings.adguard` using the
   * real `fetch`/filesystem. The external-mode preflight runs in an `onReady`
   * hook; for the default `disabled` mode it is an inert no-op (no network), so
   * existing tests make no AdGuard calls.
   */
  adguard?: AdGuardService;
  /**
   * Inject an {@link AnsibleVenvSupervisor} (tests pass one with a fake runner).
   * When omitted, {@link buildApp} builds one from settings. Either way
   * `buildApp` never calls `bootstrap()`, so no subprocess is spawned by
   * constructing the app.
   */
  ansibleVenv?: AnsibleVenvSupervisor;
  /**
   * Inject an {@link AdGuardManagedSupervisor} (tests pass one with fake
   * acquire/spawn seams), or `null` to force the not-managed contract. When
   * omitted, {@link buildApp} builds one only in `managed` mode (else `null`)
   * and never calls `bootstrap()`, so constructing the app spawns nothing.
   */
  adguardManaged?: AdGuardManagedSupervisor | null;
  /**
   * Inject the outbound {@link PolicyPushTransport} (#201/#257). When omitted,
   * {@link buildApp} builds the live `timekpra`-over-SSH transport from settings
   * (or the logging fallback when no SSH key exists yet). Tests inject one with
   * a fake `adjustTimeToday` to exercise `POST /users/:userId/time-today`
   * without SSH. An injected transport is left for its provider to dispose.
   */
  policyPush?: PolicyPushTransport;
  /**
   * Tuning/test seam for the `/api/events/stream` handshake (heartbeat
   * interval, hello timeout, negotiated server protocol). Omitted in
   * production; tests use it to exercise the N-1 refusal branches.
   */
  eventStream?: EventStreamOptions;
  /**
   * Inject the {@link EnforcementPipelineHandle} (#327), or `null` to force the
   * not-wired contract. When omitted, {@link buildApp} builds it from settings —
   * which yields `null` unless the SSH key exists — and never starts its timer
   * (that is `main.ts`'s job after `listen`). Tests inject a fake to assert boot
   * start/stop without a live SSH transport.
   */
  enforcementPipeline?: EnforcementPipelineHandle | null;
  /**
   * Inject the {@link RetentionPurgeSchedulerHandle} (#137). When omitted,
   * {@link buildApp} builds it from settings and never starts its timer (that
   * is `main.ts`'s job after `listen`). Tests inject a fake to assert boot
   * start/stop, or a real one over an in-memory DB.
   */
  retentionPurge?: RetentionPurgeSchedulerHandle;
}

/**
 * Build and configure a Fastify instance.
 *
 * The logger follows the shared conventions in `./logger.ts` (#11): JSON by
 * default at `PCT_LOG_LEVEL`, an inbound `X-Request-Id` honoured with a UUID
 * fallback, and `reqId` bound to every request-scoped log line.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const settings = options.settings ?? loadSettings();

  const app = Fastify({
    logger: buildLoggerOptions(settings, options.loggerStream),
    // Honour an inbound X-Request-Id; genReqId supplies the UUID fallback.
    // Either way the id is bound to every request-scoped log line as `reqId`.
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: genRequestId,
    // Opt-in trust of `X-Forwarded-*` so `request.ip` is the real client IP
    // behind a trusted reverse proxy, keeping the per-IP failed-attempt
    // limiter (auth login, /api/clients/enrol) per-attacker (#235). Default
    // `false` is identical to Fastify's default — never trust a direct
    // caller's forwarded headers on a LAN deployment.
    trustProxy: settings.trustProxy,
  });

  // Build the long-lived services (policy DB, policy-push transport, event hub,
  // managed AdGuard, AdGuard mode router, Ansible venv) via the composition
  // root, then decorate them onto the instance. Construction only — no
  // subprocess, no timer; main.ts bootstraps/starts those after `listen`.
  const services = buildAppServices(options, settings, app.log);
  app.decorate("db", services.db);
  app.decorate("eventHub", services.eventHub);
  app.decorate("adguardManaged", services.adguardManaged);
  app.decorate("adguard", services.adguard);
  app.decorate("ansibleVenv", services.ansibleVenv);
  // The Phase-8 enforcement pipeline (#327), or null when no SSH key exists.
  // Constructed by the composition root; main.ts calls start() after listen and
  // services.teardown stops it. Decorated here so main.ts reads it off the app.
  app.decorate("enforcementPipeline", services.enforcementPipeline);
  // The Phase-11 scheduled retention purge (#137). Constructed by the
  // composition root; main.ts calls start() after listen and services.teardown
  // stops it. Decorated here so main.ts reads it off the app.
  app.decorate("retentionPurge", services.retentionPurge);

  // Dispose the resources the composition root owns (owned policy-push + db, a
  // non-null managed supervisor, and the enforcement pipeline). See
  // AppServices.teardown for the ownership rules preserved here.
  app.addHook("onClose", services.teardown);

  // Route the configured AdGuard mode's preflight once the app is ready (after
  // listen/inject triggers onReady); disabled mode is a no-op.
  app.addHook("onReady", async () => {
    await services.adguard.runPreflight(app.log);
  });

  // The managed-mode health poller (#283) is started by main.ts after listen
  // (not here, so building the app starts no timer); buildApp owns only its
  // teardown. Initialised null and stopped on close if main.ts wired it — read
  // from the decorator so the value main.ts assigns after listen is the one torn
  // down. Registered after the owned-resource teardown so it stops first.
  app.decorate("adguardHealthPoll", null);
  app.addHook("onClose", async () => {
    app.adguardHealthPoll?.stop();
  });

  app.get("/", async (_request, reply) => {
    return reply.type("text/plain").send("hello, no policy yet");
  });

  app.get("/healthz", async () => {
    return { status: "ok" };
  });

  // Mount the JSON API at /api (#50). Encapsulated: the zod validation hook,
  // the shared error envelope, and the /api not-found envelope apply only
  // within this prefix, leaving /, /healthz, /admin and /app untouched. Auth
  // (#52) is wired inside this scope and needs the settings (PCT_SECRET_KEY,
  // first-admin bootstrap) threaded through.
  registerApi(
    app,
    settings,
    services.eventHub,
    services.policyPush.dispatcher,
    services.policyPush.adjustTimeToday,
    services.policyPush.pushPolicyNow,
    services.policyPush.prober,
    options.eventStream,
  );

  // Serve the client install script at /install-client.sh. Skipped (with a
  // warning) when the bundled file is absent, so other routes are unaffected.
  registerInstallScript(app, settings);

  // Serve the prerendered SvelteKit build at /admin and /app (#40). Skipped
  // (with a warning) when the build directory is absent, so /, /healthz, and
  // unknown routes are unaffected.
  registerFrontend(app, settings);

  return app;
}
