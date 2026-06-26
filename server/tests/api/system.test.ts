/**
 * HTTP tests for the system-status read route `GET /api/system/ansible` (#39),
 * driven through the real app via `app.inject()` with a genuine admin session
 * cookie — per docs/testing.md → "HTTP routes". Covers the anonymous-401 guard
 * and the serialised snapshot for the ready and unavailable cases, with an
 * injected {@link AnsibleVenvSupervisor} (fake runner) so no test spawns Python.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import {
  createAnsibleVenvSupervisor,
  type AnsibleVenvSupervisor,
  type RunCommand,
} from "../../src/setup/ansible-venv.js";
import {
  createAdGuardManagedSupervisor,
  type AdGuardManagedSupervisor,
  type SpawnManaged,
} from "../../src/transport/adguard/index.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

const CORE_VERSION = "2.18.1";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pct-system-route-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "system-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
    PCT_ANSIBLE_DIR: dir,
    PCT_ANSIBLE_CORE_VERSION: CORE_VERSION,
  });
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie set");
  return match.split(";")[0] ?? "";
}

/** A runner that simulates Python creating the venv on `-m venv`. */
const okRunner: RunCommand = async (_file, args) => {
  if (args.includes("venv")) {
    const venvDir = args[args.length - 1] as string;
    mkdirSync(join(venvDir, "bin"), { recursive: true });
    writeFileSync(join(venvDir, "bin", "ansible-playbook"), "#!/bin/sh\n");
  }
  return { stdout: "", stderr: "" };
};

const failingRunner: RunCommand = async () => {
  throw new Error("no network to PyPI");
};

/** Build the test app around an injected supervisor and log in as admin. */
async function harnessWith(
  ansibleVenv: AnsibleVenvSupervisor,
): Promise<{ harness: TestApp; cookie: string }> {
  const harness = buildTestApp({ appOptions: { settings: configuredSettings(), ansibleVenv } });
  await harness.app.ready();
  const login = await harness.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "ben", password: "hunter2" },
  });
  return { harness, cookie: sessionCookie(login) };
}

describe("GET /api/system/ansible", () => {
  it("rejects an anonymous request with 401", async () => {
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: okRunner },
    );
    const { harness } = await harnessWith(supervisor);
    try {
      const res = await harness.app.inject({ method: "GET", url: "/api/system/ansible" });
      expect(res.statusCode).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("serialises a ready snapshot for an admin", async () => {
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: okRunner },
    );
    await supervisor.bootstrap();
    const { harness, cookie } = await harnessWith(supervisor);
    try {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/system/ansible",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.state).toBe("ready");
      expect(body.coreVersion).toBe(CORE_VERSION);
      expect(body.binaryPath).toBe(join(dir, "venv", "bin", "ansible-playbook"));
      expect(body.playbooksDir).toBe(join(dir, "playbooks"));
      expect(body.detail).toBeNull();
      expect(typeof body.checkedAt).toBe("string");
    } finally {
      await harness.close();
    }
  });

  it("surfaces an unavailable snapshot with the failure reason", async () => {
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: failingRunner },
    );
    await supervisor.bootstrap();
    const { harness, cookie } = await harnessWith(supervisor);
    try {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/system/ansible",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.state).toBe("unavailable");
      expect(body.detail).toContain("no network to PyPI");
    } finally {
      await harness.close();
    }
  });

  it("reports idle before bootstrap has run", async () => {
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: okRunner },
    );
    const { harness, cookie } = await harnessWith(supervisor);
    try {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/system/ansible",
        headers: { cookie },
      });
      expect(res.json().state).toBe("idle");
    } finally {
      await harness.close();
    }
  });
});

/**
 * A spawn whose child exits cleanly on `SIGTERM`, so the managed supervisor
 * reaches `running` and the app's `onClose` `stop()` resolves promptly (paired
 * with an immediate `delay` below) rather than waiting on the real stop timer.
 */
const gracefulSpawn: SpawnManaged = () => {
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  return {
    pid: 1,
    onExit: (listener) => {
      onExit = listener;
    },
    onError: () => undefined,
    kill: (signal) => onExit?.(0, signal),
  };
};

/** Build the test app around an injected managed supervisor (or null) + admin login. */
async function harnessWithManaged(
  adguardManaged: AdGuardManagedSupervisor | null,
): Promise<{ harness: TestApp; cookie: string }> {
  const harness = buildTestApp({
    appOptions: { settings: configuredSettings(), adguardManaged },
  });
  await harness.app.ready();
  const login = await harness.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "ben", password: "hunter2" },
  });
  return { harness, cookie: sessionCookie(login) };
}

describe("GET /api/system/adguard-managed", () => {
  it("rejects an anonymous request with 401", async () => {
    const { harness } = await harnessWithManaged(null);
    try {
      const res = await harness.app.inject({ method: "GET", url: "/api/system/adguard-managed" });
      expect(res.statusCode).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("reports enabled:false with null fields when not in managed mode", async () => {
    const { harness, cookie } = await harnessWithManaged(null);
    try {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/system/adguard-managed",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(false);
      expect(body.state).toBeNull();
      expect(body.adminEndpoint).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("serialises a running managed snapshot for an admin", async () => {
    const supervisor = createAdGuardManagedSupervisor(
      { dataDir: "/data/adguard", bindAddr: "0.0.0.0:53", adminPort: 3000 },
      {
        acquire: async () => ({
          binaryPath: "/data/adguard/AdGuardHome",
          version: "v0.107.65",
          fetched: true,
        }),
        writeSeedConfig: () => true,
        spawn: gracefulSpawn,
        delay: () => Promise.resolve(),
      },
    );
    await supervisor.bootstrap();
    const { harness, cookie } = await harnessWithManaged(supervisor);
    try {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/system/adguard-managed",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(true);
      expect(body.state).toBe("running");
      expect(body.version).toBe("v0.107.65");
      expect(body.adminEndpoint).toBe("http://127.0.0.1:3000");
      expect(typeof body.checkedAt).toBe("string");
    } finally {
      await harness.close();
    }
  });
});
