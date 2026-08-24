/**
 * App composition root.
 *
 * `buildAppServices()` constructs the long-lived subsystems the dashboard
 * orchestrates — the policy store, the outbound policy-push transport, the
 * event fan-out hub, the managed-AdGuard supervisor, the AdGuard mode router,
 * and the first-run Ansible venv supervisor — applying the same
 * inject-or-build seams `buildApp` exposes via {@link BuildAppOptions}. It is
 * split out of `./app.ts` so `buildApp` reads as a thin builder (build services
 * → decorate → register routes/hooks) and so service construction +
 * ownership-scoped teardown are independently testable.
 *
 * Construction only: like `buildApp`, this starts **no** subprocess and **no**
 * timer. The Ansible venv, managed AdGuard, and AdGuard health poll are
 * bootstrapped/started by `main.ts` after `listen`; the services here merely
 * hold the handles their routes serialise.
 */
import type { FastifyBaseLogger } from "fastify";

import type { Settings } from "../config.js";
import { createEnforcementPipeline, type EnforcementPipelineHandle } from "../enforcement/index.js";
import { EventHub } from "../events/index.js";
import {
  createRetentionPurgeScheduler,
  type RetentionPurgeSchedulerHandle,
} from "../retention/index.js";
import { createDb, type PolicyDb } from "../policy/db.js";
import { DrizzleAuditSink } from "../transport/audit/index.js";
import { loadSshCredentials } from "../transport/ssh/index.js";
import { createAnsibleVenvSupervisor, type AnsibleVenvSupervisor } from "../setup/ansible-venv.js";
import {
  createAdGuardManagedSupervisor,
  createAdGuardService,
  type AdGuardManagedSupervisor,
  type AdGuardService,
} from "../transport/adguard/index.js";
import {
  createPolicyPushTransport,
  type PolicyPushTransport,
} from "../transport/policy-push/index.js";

// Type-only import (erased at runtime, so no import cycle with ./app.ts, which
// owns BuildAppOptions and the Fastify decorator augmentation).
import type { BuildAppOptions } from "./app.js";

/**
 * The long-lived services `buildApp` decorates onto the Fastify instance, plus
 * a teardown that disposes exactly the resources this composition root created.
 */
export interface AppServices {
  /** The shared policy-store connection (#49). */
  db: PolicyDb;
  /** The outbound `timekpra`-over-SSH policy-push transport (#201/#257). */
  policyPush: PolicyPushTransport;
  /** The process-wide event fan-out registry (#100). */
  eventHub: EventHub;
  /** The DNS mode router + external-mode preflight state (#95). */
  adguard: AdGuardService;
  /** The managed-mode AdGuard Home supervisor (#96), or `null` when not managed. */
  adguardManaged: AdGuardManagedSupervisor | null;
  /** The first-run Ansible venv bootstrap supervisor (#39). */
  ansibleVenv: AnsibleVenvSupervisor;
  /**
   * The Phase-8 enforcement pipeline (#327): telemetry pull → #88 usage rollup →
   * per-activity enforcement sweep, or `null` when no SSH key exists (nothing is
   * reachable). Constructed here but started by `main.ts` after `listen`; stopped
   * by {@link AppServices.teardown}.
   */
  enforcementPipeline: EnforcementPipelineHandle | null;
  /**
   * The Phase-11 scheduled retention purge (#137): the croner job that enforces
   * the configured retention windows and records each run. Always present (a
   * purge needs no SSH). Constructed here but started by `main.ts` after
   * `listen`; stopped by {@link AppServices.teardown}.
   */
  retentionPurge: RetentionPurgeSchedulerHandle;
  /**
   * Dispose the resources this composition root owns, on `app.close()`, in the
   * pre-refactor order:
   *
   * - `adguardManaged.stop()` runs first whenever the supervisor is non-null,
   *   including an injected one (it owns a spawned process either way).
   * - `policyPush.dispose()` and `db.$client.close()` run **only** when
   *   `buildAppServices` created them (an injected handle's lifecycle belongs to
   *   its provider — no double-close); `policyPush` is disposed before the db it
   *   reads from.
   *
   * The managed AdGuard **health poll** is torn down by `buildApp` instead: it
   * is assigned onto the decorator by `main.ts` after `listen`, so its teardown
   * must read the live decorator value rather than a handle captured here.
   */
  teardown: () => Promise<void>;
}

/**
 * Construct the app's long-lived services from `options` (inject-or-build) and
 * `settings`, logging construction-time output (e.g. the migrate-on-boot backup
 * outcome, #166) through `log`.
 *
 * The managed supervisor is built **before** the AdGuard service so it can be
 * wired in as the service's running-instance source in `managed` mode (#283).
 */
export function buildAppServices(
  options: BuildAppOptions,
  settings: Settings,
  log: FastifyBaseLogger,
): AppServices {
  // Open (and migrate) the policy store unless a handle was injected. We own
  // only the handle we create: that one is closed on shutdown; an injected
  // handle's lifecycle belongs to its provider (no double-close). `log` carries
  // the migrate-on-boot pre-migration backup outcome (#166).
  const db = options.db ?? createDb(settings, { log });
  const ownsDb = options.db === undefined;

  // Outbound policy-push transport (#201): the live `timekpra`-over-SSH
  // dispatcher when the SSH key exists (#39), else the logging stub. It also
  // owns the offline-queue drainer + pooled SSH connections, torn down on close
  // — before the db it reads from (when we own that db). When live it also
  // exposes the client health prober (#81), built over that same pooled SSH
  // transport and injected into the /api/clients/health routes. A test may
  // inject one; only the handle we create is disposed here, mirroring `db`.
  const policyPush = options.policyPush ?? createPolicyPushTransport({ settings, db, log });
  const ownsPolicyPush = options.policyPush === undefined;

  // The process-wide event fan-out registry (#100): a single instance shared by
  // the `/api/events/stream` route and every event producer, regardless of
  // which `/api` sub-scope they live in. Holds no resources of its own (just
  // the live-connection map), so it needs no teardown beyond the sockets the
  // route closes on shutdown.
  const eventHub = new EventHub();

  // The managed-mode AdGuard Home supervisor (#96). Built only in `managed`
  // mode (else null); like ansibleVenv it is bootstrapped by main.ts after
  // listen, so constructing it spawns no process. An explicitly-injected value
  // (including null) is honoured as-is.
  const adguardManaged =
    options.adguardManaged !== undefined
      ? options.adguardManaged
      : settings.adguard.mode === "managed"
        ? createAdGuardManagedSupervisor({
            dataDir: settings.adguard.dataDir,
            bindAddr: settings.adguard.bindAddr,
            adminPort: settings.adguard.adminPort,
            ...(settings.adguard.version !== undefined
              ? { version: settings.adguard.version }
              : {}),
          })
        : null;

  // Route the configured AdGuard mode (#95). In `managed` mode the supervisor
  // above is wired in as the service's running-instance source (#283), so
  // getClient()/runPreflight target the supervised endpoint.
  const adguard =
    options.adguard ??
    createAdGuardService(
      settings.adguard,
      adguardManaged !== null ? { managed: adguardManaged } : {},
    );

  // The first-run Ansible venv bootstrap supervisor (#39). Built (or injected)
  // here so its route has a status to serialise, but NOT run here: `main.ts`
  // fires `bootstrap()` after `listen`, so constructing it spawns no subprocess.
  const ansibleVenv =
    options.ansibleVenv ??
    createAnsibleVenvSupervisor({
      ansibleDir: settings.ansibleDir,
      coreVersion: settings.ansibleCoreVersion,
      playbookSourceDir: settings.ansiblePlaybookSourceDir,
    });

  // The Phase-8 enforcement pipeline (#327): telemetry pull → #88 usage rollup →
  // per-activity enforcement sweep, sharing the db + event hub. Built (or
  // injected) here but NOT started — main.ts calls start() after listen, and
  // teardown stops it. createEnforcementPipeline returns null when the SSH key
  // is absent (nothing is reachable — dev/CI/tests/pre-keygen), so constructing
  // it spawns no SSH transport in that case. An injected value (including null)
  // is honoured as-is.
  const enforcementPipeline =
    options.enforcementPipeline !== undefined
      ? options.enforcementPipeline
      : createEnforcementPipeline({
          db,
          eventHub,
          sink: new DrizzleAuditSink(db, log),
          log,
          defaultTz: settings.defaultTz,
          credentials: loadSshCredentials(settings.sshPrivateKeyPath),
          pullCron: settings.telemetry.pullCron,
          pullConcurrency: settings.telemetry.pullConcurrency,
          cooldownSeconds: settings.enforcement.cooldownSeconds,
          initialLookbackSeconds: settings.enforcement.initialLookbackSeconds,
        });

  // The Phase-11 scheduled retention purge (#137): the croner job that enforces
  // the configured retention windows (env default + persisted overrides) and
  // records each run. Built (or injected) here but NOT started — main.ts calls
  // start() after listen, and teardown stops it. Always constructed: a purge is
  // pure DB maintenance with no SSH/keyless case. Constructing it starts no
  // timer (the Cron is created lazily in start()).
  const retentionPurge =
    options.retentionPurge ??
    createRetentionPurgeScheduler({
      db,
      defaultDays: settings.retention.defaultDays,
      pattern: settings.retention.purgeCron,
      batchSize: settings.retention.purgeBatchSize,
      log,
    });

  const teardown = async (): Promise<void> => {
    // Stop the scheduled timers before tearing down the deps they read.
    retentionPurge.stop();
    if (enforcementPipeline !== null) enforcementPipeline.stop();
    // Order mirrors the pre-refactor buildApp onClose hooks (Fastify runs them
    // LIFO): stop the managed supervisor first, then dispose the policy-push
    // transport before closing the db it reads from. Only the push→db step is
    // load-bearing (the drainer reads the db); adguardManaged holds no handle
    // into either, so its position is not — but keeping it identical avoids any
    // behavioural drift from the extraction.
    if (adguardManaged !== null) await adguardManaged.stop();
    if (ownsPolicyPush) policyPush.dispose();
    if (ownsDb) db.$client.close();
  };

  return {
    db,
    policyPush,
    eventHub,
    adguard,
    adguardManaged,
    ansibleVenv,
    enforcementPipeline,
    retentionPurge,
    teardown,
  };
}
