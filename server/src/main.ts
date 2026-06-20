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
}

void main();
