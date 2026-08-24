/**
 * Process entrypoint: build the Fastify app and bind it to a socket.
 *
 * The build (`server/Dockerfile`, #6) runs the compiled output as
 * `node dist/main.js`. Listening on 0.0.0.0 makes the dashboard reachable
 * from outside the container. The bind host/port stay constants for now;
 * 8000 is the documented default.
 *
 * This file is excluded from the coverage gate (vitest.config.ts): it is a
 * thin bootstrap whose only job is to validate settings, build the app,
 * install shutdown signal handlers, and listen.
 */
import { loadSettings } from "./config.js";
import { ensureServerSshKeyPair } from "./setup/ssh-keys.js";
import { startAdGuardHealthPoll } from "./transport/adguard/index.js";
import { startTimekprMirrorRefresh } from "./transport/timekpr-mirror/index.js";
import { buildApp } from "./web/app.js";

const HOST = "0.0.0.0";
const PORT = 8000;

async function main(): Promise<void> {
  // Fail fast on a bad environment before binding a socket. The parsed
  // settings feed the logger (#11) and transports in later phases.
  const settings = loadSettings();
  const app = buildApp({ settings });

  // On `docker stop` (SIGTERM) or Ctrl-C (SIGINT), close the app so Fastify's
  // onClose hooks run — notably closing the policy-store handle the app owns
  // (#49), flushing the WAL cleanly rather than leaning on crash recovery.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void app.close().then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error(err);
          process.exit(1);
        },
      );
    });
  }

  // Generate the server's SSH key pair on first run if absent (#39, Phase-4
  // step). In-process at boot like the migrator (#49), so the image ships no
  // ssh-keygen binary. A keygen failure (e.g. an unwritable data volume) is
  // logged and the dashboard still starts — enrolment just hands back no key
  // (docs/server-deployment.md → "First-run setup") — rather than crashing.
  try {
    ensureServerSshKeyPair({
      privateKeyPath: settings.sshPrivateKeyPath,
      publicKeyPath: settings.sshPublicKeyPath,
      log: app.log,
    });
  } catch (err) {
    app.log.error(err, "server SSH key bootstrap failed; continuing without a key");
  }

  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Bootstrap the first-run Ansible venv (#39, Phase-6 step) in the background,
  // after listen so a slow `pip install ansible-core` never delays the dashboard
  // becoming reachable. `bootstrap()` never throws — a network-less first run
  // records `unavailable` and the reason is surfaced at GET /api/system/ansible
  // (docs/server-deployment.md → "First-run setup") — so a bare `void` is safe.
  void app.ansibleVenv.bootstrap(app.log);

  // Bootstrap the managed AdGuard Home instance (#96, Phase-7 step) in the
  // background too, for the same reason — a first-run release download must not
  // delay startup. Present only when PCT_ADGUARD_MODE=managed; `bootstrap()`
  // never throws (a failed fetch records `failed`, surfaced at
  // GET /api/system/adguard-managed), so a bare `void` is safe. It is stopped
  // on shutdown by the onClose hook in buildApp.
  if (app.adguardManaged !== null) {
    void app.adguardManaged.bootstrap(app.log);
    // Poll the supervised instance's health on a cadence (#283) so a crash/
    // restart surfaces at GET /api/dns. Wired here (not in buildApp) so building
    // the app starts no timer; buildApp's onClose hook stops it on shutdown.
    app.adguardHealthPoll = startAdGuardHealthPoll({ service: app.adguard, log: app.log });
  }

  // Start the Phase-8 enforcement loop (#327): the telemetry pull → #88 usage
  // rollup → per-activity enforcement sweep, on the telemetry cadence. Wired
  // here (not in buildApp) so building the app starts no timer; buildApp's
  // onClose hook stops it. `null` when the SSH key is absent (nothing to reach),
  // so the `?.` keeps a keyless first boot a no-op.
  app.enforcementPipeline?.start();

  // Start the Phase-11 scheduled retention purge (#137) on its cron cadence.
  // Wired here (not in buildApp) so building the app starts no timer; buildApp's
  // onClose teardown stops it. Always present — a purge needs no SSH.
  app.retentionPurge.start();

  // Start the managed-mode timekpr-next mirror refresh scheduler (#392, epic
  // #389) after listen — a first refresh must not delay the dashboard becoming
  // reachable, and the whole point is to keep the fetch off every client's
  // install/enrol critical path. Only in `managed` mode: `external` points
  // clients at a repo the homelab already hosts and `disabled` does nothing.
  // The scheduler's tick never throws (a failed fetch is logged + backed off),
  // and buildApp's onClose hook stops it on shutdown. We kick one tick now to
  // warm the cache immediately.
  const mirror = settings.timekprMirror;
  if (mirror.mode === "managed") {
    app.timekprMirrorRefresh = startTimekprMirrorRefresh({
      config: {
        dataDir: mirror.dataDir,
        package: mirror.package,
        ...(mirror.version !== undefined ? { version: mirror.version } : {}),
      },
      pattern: mirror.refreshCron,
      log: app.log,
    });
    void app.timekprMirrorRefresh.tick();
  }
}

void main();
