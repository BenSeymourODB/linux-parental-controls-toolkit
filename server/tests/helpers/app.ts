/**
 * Shared Fastify test-app helper.
 *
 * `buildTestApp()` constructs the real {@link buildApp} instance (#5) with a
 * silent logger and bundles a fresh {@link testDb}, so HTTP-route tests can
 * exercise the app via `app.inject()` (no sockets, no port binding) while
 * holding the policy DB the routes will read — see `docs/testing.md` →
 * "HTTP routes".
 *
 * The in-memory `db` is passed through to {@link buildApp} (#49), so
 * `app.db` and the returned `db` are the same handle; `close()` closes the
 * app and then the database. Bundling both here means policy / route tests
 * don't each re-derive the wiring.
 */
import type { FastifyInstance } from "fastify";

import { loadSettings } from "../../src/config.js";
import { buildApp, type BuildAppOptions } from "../../src/web/app.js";
import { testDb, type TestDb } from "./db.js";

/** A test app paired with its in-memory policy database. */
export interface TestApp {
  /** The configured Fastify instance; drive it with `app.inject()`. */
  app: FastifyInstance;
  /** The in-memory policy database (migrations applied). */
  db: TestDb;
  /** Close the Fastify app and the underlying in-memory database. */
  close(): Promise<void>;
}

/** Options for {@link buildTestApp}. */
export interface BuildTestAppOptions {
  /** Override the in-memory policy DB (defaults to a fresh {@link testDb}). */
  db?: TestDb;
  /**
   * Extra {@link buildApp} options (e.g. a custom `settings` or a
   * `loggerStream` to capture log output). The default settings use a silent
   * log level to keep test output clean.
   */
  appOptions?: BuildAppOptions;
}

/**
 * Build a Fastify test app wired to an in-memory policy database.
 *
 * Defaults to a silent logger so route assertions aren't drowned in log
 * lines; pass `appOptions` to override (logging behaviour itself is covered
 * in `tests/web/logging.test.ts`).
 */
export function buildTestApp(options: BuildTestAppOptions = {}): TestApp {
  const db = options.db ?? testDb();
  const app = buildApp({
    // A secret so auth (#52) is "configured" in the common path — guarded
    // routes and the auth endpoints work without each test re-supplying one.
    // Tests that need the unconfigured path pass their own settings via
    // appOptions. No admin is seeded by default (no PCT_ADMIN_* here), so
    // login tests opt in by supplying those.
    settings: loadSettings({ PCT_LOG_LEVEL: "silent", PCT_SECRET_KEY: "test-secret-key" }),
    ...options.appOptions,
    // Inject the bundled db last so app.db is the handle this helper returns,
    // regardless of any db passed via appOptions.
    db,
  });

  return {
    app,
    db,
    close: async () => {
      await app.close();
      db.$client.close();
    },
  };
}
