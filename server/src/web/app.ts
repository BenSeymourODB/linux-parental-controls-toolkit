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
import { EventHub } from "../events/index.js";
import { createDb, type PolicyDb } from "../policy/db.js";
import { createAnsibleVenvSupervisor, type AnsibleVenvSupervisor } from "../setup/ansible-venv.js";
import { createAdGuardService, type AdGuardService } from "../transport/adguard/index.js";
import {
  createPolicyPushTransport,
  type PolicyPushTransport,
} from "../transport/policy-push/index.js";
import { registerFrontend } from "./frontend.js";
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
   * Inject the outbound {@link PolicyPushTransport} (#201/#257). When omitted,
   * {@link buildApp} builds the live `timekpra`-over-SSH transport from settings
   * (or the logging fallback when no SSH key exists yet). Tests inject one with
   * a fake `adjustTimeToday` to exercise `POST /users/:userId/time-today`
   * without SSH. An injected transport is left for its provider to dispose.
   */
  policyPush?: PolicyPushTransport;
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
  });

  // Open (and migrate) the policy store unless a handle was injected. buildApp
  // owns only the handle it creates: that one is closed on shutdown; an
  // injected handle's lifecycle belongs to its provider (no double-close).
  // `app.log` carries the migrate-on-boot pre-migration backup outcome (#166).
  const db = options.db ?? createDb(settings, { log: app.log });
  const ownsDb = options.db === undefined;
  app.decorate("db", db);

  // Outbound policy-push transport (#201): the live `timekpra`-over-SSH
  // dispatcher when the SSH key exists (#39), else the logging stub. It also
  // owns the offline-queue drainer + pooled SSH connections, torn down on close
  // — before the db it reads from (when buildApp owns that db). A test may
  // inject one (e.g. with a fake `adjustTimeToday`); only the handle buildApp
  // creates is disposed here, mirroring the `db` seam.
  const policyPush =
    options.policyPush ?? createPolicyPushTransport({ settings, db, log: app.log });
  const ownsPolicyPush = options.policyPush === undefined;
  app.addHook("onClose", async () => {
    if (ownsPolicyPush) policyPush.dispose();
    if (ownsDb) db.$client.close();
  });

  // The process-wide event fan-out registry (#100). Created here so it is a
  // single instance shared by the `/api/events/stream` route and every future
  // event producer (`app.eventHub`), regardless of which `/api` sub-scope they
  // live in. Holds no resources of its own (just the live-connection map), so
  // it needs no teardown beyond the sockets the route closes on shutdown.
  const eventHub = new EventHub();
  app.decorate("eventHub", eventHub);

  // Route the configured AdGuard mode (#95) and decorate it so the /api/dns
  // route reads one snapshot. The external-mode preflight runs once the app is
  // ready (after listen/inject triggers onReady); disabled/managed are no-ops.
  const adguard = options.adguard ?? createAdGuardService(settings.adguard);
  app.decorate("adguard", adguard);
  app.addHook("onReady", async () => {
    await adguard.runPreflight(app.log);
  });

  // The first-run Ansible venv bootstrap supervisor (#39), read by
  // GET /api/system/ansible. Built (or injected) here so the route has a status
  // to serialise, but NOT run here: `main.ts` fires `bootstrap()` after `listen`
  // so a slow `pip install` never delays startup, and constructing the app —
  // including every test that builds it — spawns no subprocess.
  const ansibleVenv =
    options.ansibleVenv ??
    createAnsibleVenvSupervisor({
      ansibleDir: settings.ansibleDir,
      coreVersion: settings.ansibleCoreVersion,
      playbookSourceDir: settings.ansiblePlaybookSourceDir,
    });
  app.decorate("ansibleVenv", ansibleVenv);

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
  registerApi(app, settings, eventHub, policyPush.dispatcher, policyPush.adjustTimeToday);

  // Serve the prerendered SvelteKit build at /admin and /app (#40). Skipped
  // (with a warning) when the build directory is absent, so /, /healthz, and
  // unknown routes are unaffected.
  registerFrontend(app, settings);

  return app;
}
