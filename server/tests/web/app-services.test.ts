/**
 * Unit tests for the app composition root (#309).
 *
 * `buildAppServices` was extracted from `buildApp` so service construction and
 * ownership-scoped teardown are independently testable without standing up the
 * whole Fastify app. These tests pin the inject-or-build seams and the teardown
 * ownership rules `buildApp` used to inline — the behaviours `main.ts` and every
 * route test depend on.
 */
import Fastify, { type FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSettings, type Settings } from "../../src/config.js";
import { EventHub } from "../../src/events/index.js";
import { createAnsibleVenvSupervisor } from "../../src/setup/ansible-venv.js";
import {
  createAdGuardManagedSupervisor,
  createAdGuardService,
} from "../../src/transport/adguard/index.js";
import { createPolicyPushTransport } from "../../src/transport/policy-push/index.js";
import { buildAppServices } from "../../src/web/app-services.js";
import { testDb, type TestDb } from "../helpers/db.js";

/** A valid no-op {@link FastifyBaseLogger} (Fastify's abstract-logging noop). */
const log: FastifyBaseLogger = Fastify({ logger: false }).log;

/** Disabled-AdGuard settings; no SSH key, so policy-push falls back to the stub. */
function disabledSettings(): Settings {
  return loadSettings({ PCT_LOG_LEVEL: "silent", PCT_SECRET_KEY: "app-services-test" });
}

/** Managed-AdGuard settings (defaults fill bindAddr/adminPort/dataDir). */
function managedSettings(): Settings {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "app-services-test",
    PCT_ADGUARD_MODE: "managed",
  });
}

describe("buildAppServices", () => {
  // Track handles opened per-test so they are freed even when an assertion
  // throws before the test's own cleanup runs.
  const openDbs: TestDb[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of openDbs.splice(0)) db.$client.close();
  });

  it("builds all six services from disabled settings + an injected db", async () => {
    const db = testDb();
    openDbs.push(db);
    const services = buildAppServices({ db }, disabledSettings(), log);

    expect(services.db).toBe(db);
    expect(services.eventHub).toBeInstanceOf(EventHub);
    expect(services.adguardManaged).toBeNull(); // disabled mode
    expect(typeof services.adguard.runPreflight).toBe("function");
    expect(typeof services.ansibleVenv.bootstrap).toBe("function");
    expect(services.policyPush.dispatcher).toBeDefined();
    expect(typeof services.policyPush.dispose).toBe("function");

    // Owned policy-push disposed; injected db left open for the harness to close.
    await services.teardown();
  });

  it("returns injected instances as-is (each seam honoured)", async () => {
    const db = testDb();
    openDbs.push(db);
    const settings = disabledSettings();
    const policyPush = createPolicyPushTransport({ settings, db, log });
    const adguard = createAdGuardService(settings.adguard, {});
    const ansibleVenv = createAnsibleVenvSupervisor({
      ansibleDir: settings.ansibleDir,
      coreVersion: settings.ansibleCoreVersion,
      playbookSourceDir: settings.ansiblePlaybookSourceDir,
    });

    const services = buildAppServices(
      { db, policyPush, adguard, ansibleVenv, adguardManaged: null },
      settings,
      log,
    );

    expect(services.db).toBe(db);
    expect(services.policyPush).toBe(policyPush);
    expect(services.adguard).toBe(adguard);
    expect(services.ansibleVenv).toBe(ansibleVenv);
    expect(services.adguardManaged).toBeNull(); // explicit null honoured, not built

    // Nothing here is owned by the composition root, so teardown is a no-op for
    // these; dispose/close them ourselves.
    await services.teardown();
    policyPush.dispose();
  });

  it("builds a managed supervisor in managed mode", async () => {
    const db = testDb();
    openDbs.push(db);
    const services = buildAppServices({ db }, managedSettings(), log);

    const managed = services.adguardManaged;
    expect(managed).not.toBeNull();
    if (managed === null) throw new Error("expected a managed supervisor in managed mode");

    // teardown stops the (owned) supervisor; stub stop() — it was never
    // bootstrapped, but we assert wiring, not the real stop path.
    const stop = vi.spyOn(managed, "stop").mockResolvedValue();
    await services.teardown();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("builds a managed supervisor with a pinned version", async () => {
    const db = testDb();
    openDbs.push(db);
    const settings = loadSettings({
      PCT_LOG_LEVEL: "silent",
      PCT_SECRET_KEY: "app-services-test",
      PCT_ADGUARD_MODE: "managed",
      PCT_ADGUARD_VERSION: "v0.107.99",
    });
    const services = buildAppServices({ db }, settings, log);

    const managed = services.adguardManaged;
    expect(managed).not.toBeNull();
    if (managed === null) throw new Error("expected a managed supervisor in managed mode");

    vi.spyOn(managed, "stop").mockResolvedValue();
    await services.teardown();
  });

  describe("teardown ownership", () => {
    it("stops the managed supervisor, then disposes policy-push, then closes the db", async () => {
      // Own db + policy-push (:memory: db, backup off = no file I/O), plus an
      // injected managed supervisor, to pin the full pre-refactor teardown order.
      const settings = loadSettings({
        PCT_LOG_LEVEL: "silent",
        PCT_SECRET_KEY: "app-services-test",
        DATABASE_URL: ":memory:",
        PCT_PRE_MIGRATION_BACKUP: "false",
      });
      const managed = createAdGuardManagedSupervisor({
        dataDir: "/tmp/pct-app-services-test",
        bindAddr: "127.0.0.1",
        adminPort: 3000,
      });
      const stopSpy = vi.spyOn(managed, "stop").mockResolvedValue();

      const services = buildAppServices({ adguardManaged: managed }, settings, log);
      const disposeSpy = vi.spyOn(services.policyPush, "dispose");
      const closeSpy = vi.spyOn(services.db.$client, "close");

      await services.teardown();

      expect(stopSpy).toHaveBeenCalledOnce();
      expect(disposeSpy).toHaveBeenCalledOnce();
      expect(closeSpy).toHaveBeenCalledOnce();
      // Order: managed supervisor first, then policy-push (which reads the db),
      // then the db — mirroring the pre-refactor buildApp onClose (LIFO) hooks.
      const [stopOrder] = stopSpy.mock.invocationCallOrder;
      const [disposeOrder] = disposeSpy.mock.invocationCallOrder;
      const [closeOrder] = closeSpy.mock.invocationCallOrder;
      if (stopOrder === undefined || disposeOrder === undefined || closeOrder === undefined) {
        throw new Error("expected all three teardown steps to have run");
      }
      expect(stopOrder).toBeLessThan(disposeOrder);
      expect(disposeOrder).toBeLessThan(closeOrder);
    });

    it("does not close an injected db or dispose an injected policy-push", async () => {
      const db = testDb();
      openDbs.push(db);
      const settings = disabledSettings();
      const injectedPush = createPolicyPushTransport({ settings, db, log });

      const services = buildAppServices({ db, policyPush: injectedPush }, settings, log);
      const disposeSpy = vi.spyOn(injectedPush, "dispose");
      const closeSpy = vi.spyOn(db.$client, "close");

      await services.teardown();

      // db is injected → not closed; policy-push is injected → not disposed.
      expect(disposeSpy).not.toHaveBeenCalled();
      expect(closeSpy).not.toHaveBeenCalled();

      injectedPush.dispose(); // owned by this test
    });

    it("disposes an owned policy-push but not an injected db", async () => {
      const db = testDb();
      openDbs.push(db);
      const services = buildAppServices({ db }, disabledSettings(), log);

      const disposeSpy = vi.spyOn(services.policyPush, "dispose");
      const closeSpy = vi.spyOn(db.$client, "close");

      await services.teardown();

      expect(disposeSpy).toHaveBeenCalledOnce();
      expect(closeSpy).not.toHaveBeenCalled(); // injected db
    });

    it("stops a non-null managed supervisor even when it was injected", async () => {
      const db = testDb();
      openDbs.push(db);
      const managed = createAdGuardManagedSupervisor({
        dataDir: "/tmp/pct-app-services-test",
        bindAddr: "127.0.0.1",
        adminPort: 3000,
      });
      const stop = vi.spyOn(managed, "stop").mockResolvedValue();

      const services = buildAppServices({ db, adguardManaged: managed }, disabledSettings(), log);
      expect(services.adguardManaged).toBe(managed);

      await services.teardown();
      expect(stop).toHaveBeenCalledOnce();
    });
  });
});
