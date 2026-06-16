/**
 * Shared Fastify test-app helper.
 *
 * `buildTestApp()` constructs the real {@link buildApp} instance (#5) with a
 * silent logger and bundles a fresh {@link testDb}, so HTTP-route tests can
 * exercise the app via `app.inject()` (no sockets, no port binding) while
 * holding the policy DB the routes will read — see `docs/testing.md` →
 * "HTTP routes".
 *
 * Forward-compat note: the Phase-1 {@link buildApp} does not yet accept a
 * `db` option — the runtime DB connection is wired in Phase 2 (see #34/#39).
 * Until then the db is created and returned alongside the app; once
 * `buildApp` gains a `db` option this helper passes it through. Bundling both
 * here means Phase 2 / Phase 4 tests don't each re-derive the wiring.
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
    settings: loadSettings({ PCT_LOG_LEVEL: "silent" }),
    ...options.appOptions,
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
