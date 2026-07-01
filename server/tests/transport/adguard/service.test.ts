/**
 * Unit tests for the AdGuard mode router + external-mode preflight (#95).
 *
 * `fetch` is injected (no live AdGuard, no network), so every health-mapping
 * branch is exercised deterministically: ok / unhealthy / unreachable /
 * auth_failed / error (malformed) / error (unreadable credential file). Also
 * covers the inert disabled/managed modes, lazy single client build, snapshot
 * immutability, and the `now` clock.
 */
import { describe, expect, it, vi } from "vitest";

import type { Settings } from "../../../src/config.js";
import {
  createAdGuardService,
  type AdGuardManagedState,
  type AdGuardServiceDeps,
  type FetchLike,
  type ManagedInstanceSource,
  type PreflightLogger,
} from "../../../src/transport/adguard/index.js";

const URL = "http://adguard.lan";
const MANAGED_ENDPOINT = "http://127.0.0.1:3000";

function external(overrides: Record<string, unknown> = {}): Settings["adguard"] {
  return { mode: "external", url: URL, apiTokenFile: "/run/secrets/token", ...overrides };
}

function managed(): Settings["adguard"] {
  return { mode: "managed", bindAddr: "0.0.0.0:53", adminPort: 3000, dataDir: "/data/adguard" };
}

/** A managed-instance source fake at a fixed state/endpoint. */
function managedSource(
  state: AdGuardManagedState,
  detail: string | null = null,
): ManagedInstanceSource {
  return { status: { state, adminEndpoint: MANAGED_ENDPOINT, detail } };
}

/** A `fetch` returning a fixed JSON status body for `GET /control/status`. */
function statusFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): FetchLike {
  return () =>
    Promise.resolve({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.status === 401 ? "Unauthorized" : "OK",
      json: () => Promise.resolve(body),
    });
}

/** Deps that satisfy the credential read and pin the clock. */
function deps(fetch: FetchLike, extra: Partial<AdGuardServiceDeps> = {}): AdGuardServiceDeps {
  return {
    fetch,
    readSecretFile: () => Promise.resolve("token"),
    now: () => new Date("2026-06-19T12:00:00.000Z"),
    ...extra,
  };
}

function recordingLogger(): PreflightLogger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn() };
}

const RUNNING = { version: "v0.107.0", running: true, protection_enabled: true };

describe("AdGuardService — disabled mode", () => {
  it("is inert: not_applicable health, no client, preflight a no-op", async () => {
    const svc = createAdGuardService({ mode: "disabled" });
    expect(svc.mode).toBe("disabled");
    expect(svc.status).toMatchObject({
      mode: "disabled",
      configured: false,
      health: "not_applicable",
      baseUrl: null,
      checkedAt: null,
    });
    expect(svc.getClient()).toBeNull();
    await expect(svc.runPreflight()).resolves.toMatchObject({ health: "not_applicable" });
    // A no-op preflight never stamps checkedAt.
    expect(svc.status.checkedAt).toBeNull();
  });
});

describe("AdGuardService — managed mode (#283)", () => {
  it("with no supervisor wired: null client, preflight stays unknown", async () => {
    const svc = createAdGuardService(managed());
    expect(svc.mode).toBe("managed");
    expect(svc.status).toMatchObject({ mode: "managed", configured: false, health: "unknown" });
    expect(svc.getClient()).toBeNull();
    const status = await svc.runPreflight();
    expect(status.health).toBe("unknown");
    expect(status.detail).toContain("not wired");
  });

  it("getClient returns null while the supervisor is not running", () => {
    const svc = createAdGuardService(managed(), { managed: managedSource("starting") });
    expect(svc.getClient()).toBeNull();
  });

  it("getClient returns a client at the admin endpoint once running, reused across calls", () => {
    const svc = createAdGuardService(managed(), { managed: managedSource("running") });
    const client = svc.getClient();
    expect(client).not.toBeNull();
    expect(client?.baseUrl).toBe(MANAGED_ENDPOINT);
    expect(svc.getClient()).toBe(client);
  });

  it("running + reachable + running probe → ok against the local endpoint", async () => {
    const fetch = vi.fn(statusFetch(RUNNING));
    const svc = createAdGuardService(managed(), { fetch, managed: managedSource("running") });
    const status = await svc.runPreflight();
    expect(status).toMatchObject({
      mode: "managed",
      configured: true,
      health: "ok",
      baseUrl: MANAGED_ENDPOINT,
      detail: null,
    });
    expect(typeof status.checkedAt).toBe("string");
    // The probe used the injected fetch against the managed endpoint.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${MANAGED_ENDPOINT}/control/status`);
  });

  it("running but the instance reports not running → unhealthy", async () => {
    const svc = createAdGuardService(managed(), {
      fetch: statusFetch({ ...RUNNING, running: false }),
      managed: managedSource("running"),
    });
    const status = await svc.runPreflight();
    expect(status.health).toBe("unhealthy");
    expect(status.configured).toBe(true);
    expect(status.detail).toContain("not running");
  });

  it("running but a thrown fetch → unreachable (still configured)", async () => {
    const svc = createAdGuardService(managed(), {
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      managed: managedSource("running"),
    });
    const status = await svc.runPreflight();
    expect(status.health).toBe("unreachable");
    expect(status.configured).toBe(true);
  });

  it("running but a malformed status body → error", async () => {
    const svc = createAdGuardService(managed(), {
      fetch: statusFetch({ not: "a status" }),
      managed: managedSource("running"),
    });
    const status = await svc.runPreflight();
    expect(status.health).toBe("error");
  });

  it.each([
    ["idle", "unknown"],
    ["fetching", "unknown"],
    ["starting", "unknown"],
    ["stopped", "unreachable"],
    ["failed", "error"],
  ] as const)("non-running state %s maps to health %s without a probe", async (state, health) => {
    const fetch = vi.fn(statusFetch(RUNNING));
    const svc = createAdGuardService(managed(), { fetch, managed: managedSource(state) });
    const status = await svc.runPreflight();
    expect(status.health).toBe(health);
    expect(status.configured).toBe(false);
    expect(status.baseUrl).toBe(MANAGED_ENDPOINT);
    expect(fetch).not.toHaveBeenCalled(); // non-running never hits the network
  });

  it("surfaces the supervisor's own detail for a failed state", async () => {
    const svc = createAdGuardService(managed(), {
      managed: managedSource("failed", "exceeded the restart cap (5)"),
    });
    const status = await svc.runPreflight();
    expect(status.health).toBe("error");
    expect(status.detail).toBe("exceeded the restart cap (5)");
  });
});

describe("AdGuardService — external preflight", () => {
  it("starts unknown before any preflight runs", () => {
    const svc = createAdGuardService(external(), deps(statusFetch(RUNNING)));
    expect(svc.status).toMatchObject({
      mode: "external",
      configured: true,
      health: "unknown",
      baseUrl: URL,
      checkedAt: null,
    });
    // No client is built until the first preflight.
    expect(svc.getClient()).toBeNull();
  });

  it("ok: reachable + running stamps health ok, checkedAt, and logs info", async () => {
    const logger = recordingLogger();
    const svc = createAdGuardService(external(), deps(statusFetch(RUNNING)));
    const status = await svc.runPreflight(logger);
    expect(status).toMatchObject({
      health: "ok",
      detail: null,
      baseUrl: URL,
      checkedAt: "2026-06-19T12:00:00.000Z",
    });
    expect(svc.getClient()).not.toBeNull();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("unhealthy: reachable but not running, logged at error level", async () => {
    const logger = recordingLogger();
    const svc = createAdGuardService(external(), deps(statusFetch({ ...RUNNING, running: false })));
    const status = await svc.runPreflight(logger);
    expect(status.health).toBe("unhealthy");
    expect(status.detail).toContain("not running");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("unreachable: a thrown fetch maps to unreachable", async () => {
    const logger = recordingLogger();
    const fetch: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
    const svc = createAdGuardService(external(), deps(fetch));
    const status = await svc.runPreflight(logger);
    expect(status.health).toBe("unreachable");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("auth_failed: a 401 maps to auth_failed and is logged loudly", async () => {
    const logger = recordingLogger();
    const svc = createAdGuardService(external(), deps(statusFetch({}, { ok: false, status: 401 })));
    const status = await svc.runPreflight(logger);
    expect(status.health).toBe("auth_failed");
    expect(status.detail).toBeTypeOf("string");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("error: a malformed status body maps to error and is logged loudly", async () => {
    const logger = recordingLogger();
    const svc = createAdGuardService(external(), deps(statusFetch({ not: "a status" })));
    const status = await svc.runPreflight(logger);
    expect(status.health).toBe("error");
    expect(status.detail).toBeTypeOf("string");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("error: an unreadable credential file maps to error and builds no client", async () => {
    const logger = recordingLogger();
    const svc = createAdGuardService(
      external(),
      deps(statusFetch(RUNNING), {
        readSecretFile: () => Promise.reject(new Error("ENOENT")),
      }),
    );
    const status = await svc.runPreflight(logger);
    expect(status.health).toBe("error");
    expect(svc.getClient()).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("builds the REST client once and reuses it across preflights", async () => {
    const fetch = vi.fn(statusFetch(RUNNING));
    const svc = createAdGuardService(external(), deps(fetch));
    await svc.runPreflight();
    const client = svc.getClient();
    await svc.runPreflight();
    expect(svc.getClient()).toBe(client);
    expect(fetch).toHaveBeenCalledTimes(2); // each preflight probes, same client
  });

  it("stamps checkedAt from the real clock when no `now` is injected", async () => {
    const svc = createAdGuardService(external(), {
      fetch: statusFetch(RUNNING),
      readSecretFile: () => Promise.resolve("token"),
    });
    const before = Date.now();
    const status = await svc.runPreflight();
    expect(status.health).toBe("ok");
    expect(status.checkedAt).not.toBeNull();
    const stamped = Date.parse(status.checkedAt ?? "");
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
  });

  it("returns a fresh status snapshot each read (immutable)", async () => {
    const svc = createAdGuardService(external(), deps(statusFetch(RUNNING)));
    await svc.runPreflight();
    const a = svc.status;
    const b = svc.status;
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
