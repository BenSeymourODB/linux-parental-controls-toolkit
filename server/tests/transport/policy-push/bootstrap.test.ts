/**
 * Unit tests for the policy-push transport bootstrap (#201): the boot-time
 * choice between the live `timekpra`-over-SSH dispatcher and the logging
 * fallback, and — with an injected SSH transport — the full assembly pushing
 * audited `timekpra` commands end-to-end.
 */
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings, type Settings } from "../../../src/config.js";
import {
  createBudget,
  createClient,
  createUser,
  upsertLink,
} from "../../../src/policy/repository.js";
import {
  createPolicyPushTransport,
  sshReachabilityProbe,
  type BootstrapSshTransport,
} from "../../../src/transport/policy-push/bootstrap.js";
import { listAuditEntries } from "../../../src/transport/audit/index.js";
import { PUSH_STUB_MESSAGE } from "../../../src/transport/stub.js";
import { SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import type { ExecResult } from "../../../src/transport/ssh/facade.js";
import { buildApp } from "../../../src/web/app.js";
import { testDb, type TestDb } from "../../helpers/db.js";

/** A fake pooled SSH transport that records the checked-exec argv it is handed. */
function fakeSsh(): BootstrapSshTransport & { checked: string[][]; disposed: number } {
  const ok: ExecResult = { stdout: "", stderr: "", code: 0, signal: null };
  return {
    checked: [],
    disposed: 0,
    async exec() {
      return ok;
    },
    async execChecked(_target, argv) {
      this.checked.push([...argv]);
      return ok;
    },
    async execAndParse() {
      throw new Error("not used in these tests");
    },
    disposeAll() {
      this.disposed += 1;
    },
  };
}

describe("createPolicyPushTransport", () => {
  let db: TestDb;
  let app: ReturnType<typeof buildApp>;
  let log: FastifyBaseLogger;
  let lines: Record<string, unknown>[];
  let settings: Settings;

  beforeEach(() => {
    db = testDb();
    lines = [];
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "info", PCT_SECRET_KEY: "test-secret-key" }),
      loggerStream: { write: (msg) => lines.push(JSON.parse(msg) as Record<string, unknown>) },
      db,
    });
    log = app.log;
    settings = loadSettings({ PCT_SECRET_KEY: "test-secret-key" });
  });
  afterEach(async () => {
    await app.close();
    db.$client.close();
  });

  it("falls back to the logging stub when no SSH key is present", () => {
    const transport = createPolicyPushTransport({
      settings,
      db,
      log,
      loadCredentials: () => null,
    });

    transport.dispatcher.push([{ clientId: 1, userId: 1, reason: "user.updated", detail: {} }]);

    expect(
      lines.find((l) => l.msg?.toString().includes("SSH private key not found")),
    ).toBeDefined();
    expect(lines.find((l) => l.msg === PUSH_STUB_MESSAGE)).toBeDefined();
    // The "Add time today" adjuster (#257) is absent in the fallback, so the
    // admin route can report the transport as unavailable rather than no-op.
    expect(transport.adjustTimeToday).toBeUndefined();
    // The health prober (#81) is absent too, so /api/clients/health keeps
    // degrading to `unknown` rather than probing over a non-existent SSH pool.
    expect(transport.prober).toBeUndefined();
    // dispose is callable and harmless on the fallback.
    expect(() => transport.dispose()).not.toThrow();
  });

  it("assembles a live, audited dispatch when credentials and an SSH transport are present", async () => {
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 7200 });

    const ssh = fakeSsh();
    const transport = createPolicyPushTransport({
      settings,
      db,
      log,
      loadCredentials: () => ({ privateKey: "FAKE-KEY" }),
      sshTransport: ssh,
    });

    transport.dispatcher.push([{ clientId, userId, reason: "budget.updated", detail: {} }]);

    // The push reaches the (fake) SSH transport as real timekpra argv. Wait for
    // the allowed-hours push (it runs last, after the limits) so the whole
    // sequence has settled before asserting.
    await vi.waitFor(() => {
      expect(ssh.checked.some((argv) => argv.includes("--setalloweddays"))).toBe(true);
    });
    expect(ssh.checked.some((argv) => argv.includes("--settimelimits"))).toBe(true);

    // ...and each command is recorded in the audit log with attribution.
    const entries = listAuditEntries(db, { limit: 50 });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.outcome === "ok")).toBe(true);
    expect(entries.some((e) => e.clientId === clientId && e.userId === userId)).toBe(true);

    transport.dispose();
    expect(ssh.disposed).toBe(1);
  });

  it("exposes a health prober that probes over the same pooled SSH transport (#81)", async () => {
    // `systemctl is-active` is an unchecked `exec` (a non-zero exit is data, not
    // an error), so have the fake report each probed unit as `active`.
    const ssh = fakeSsh();
    ssh.exec = async () => ({ stdout: "active\n", stderr: "", code: 0, signal: null });
    const transport = createPolicyPushTransport({
      settings,
      db,
      log,
      loadCredentials: () => ({ privateKey: "FAKE-KEY" }),
      sshTransport: ssh,
    });

    const prober = transport.prober;
    expect(prober).toBeDefined();
    if (prober === undefined) throw new Error("expected a live prober");
    const result = await prober.probe({ hostname: "mint-01", sshUser: "pct-agent" });

    expect(result.reachability).toBe("online");
    // The system-service components probed via `systemctl is-active` are `ok`.
    expect(result.components.some((c) => c.component === "timekpr-next" && c.status === "ok")).toBe(
      true,
    );

    transport.dispose();
    expect(ssh.disposed).toBe(1);
  });

  it("exposes an audited 'Add time today' adjuster in live mode (#257)", async () => {
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });

    const ssh = fakeSsh();
    const transport = createPolicyPushTransport({
      settings,
      db,
      log,
      loadCredentials: () => ({ privateKey: "FAKE-KEY" }),
      sshTransport: ssh,
    });

    const adjust = transport.adjustTimeToday;
    expect(adjust).toBeDefined();
    if (adjust === undefined) throw new Error("expected a live adjuster");
    const result = await adjust({ userId, operation: "+", seconds: 1800 });

    expect(result.results).toEqual([{ clientId, osUsername: "alice", status: "applied" }]);
    // The adjustment reaches the fake SSH transport as real `--settimeleft` argv.
    expect(
      ssh.checked.some(
        (argv) => argv.includes("--settimeleft") && argv.includes("+") && argv.includes("1800"),
      ),
    ).toBe(true);
    // ...and it is audited with admin attribution + the time.adjusted reason.
    const entries = listAuditEntries(db, { limit: 50 });
    expect(
      entries.some(
        (e) =>
          e.clientId === clientId &&
          e.userId === userId &&
          e.actor === "admin" &&
          e.reason === "time.adjusted",
      ),
    ).toBe(true);

    transport.dispose();
  });
});

describe("sshReachabilityProbe", () => {
  let db: TestDb;
  let clientId: number;
  const creds = { privateKey: "FAKE-KEY" } as const;

  beforeEach(() => {
    db = testDb();
    clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
  });
  afterEach(() => db.$client.close());

  it("reports a client online when the probe command succeeds", async () => {
    const probe = sshReachabilityProbe(db, fakeSsh(), creds);
    expect(await probe(clientId)).toBe(true);
  });

  it("reports a client offline on an SSH error", async () => {
    const ssh = fakeSsh();
    ssh.exec = async () => {
      throw new SshUnreachableError({ host: "mint-01", port: 22, username: "pct-agent" });
    };
    const probe = sshReachabilityProbe(db, ssh, creds);
    expect(await probe(clientId)).toBe(false);
  });

  it("reports a non-existent client offline without probing", async () => {
    const probe = sshReachabilityProbe(db, fakeSsh(), creds);
    expect(await probe(9999)).toBe(false);
  });

  it("rethrows an unexpected (non-SSH) error", async () => {
    const ssh = fakeSsh();
    ssh.exec = async () => {
      throw new Error("kaboom");
    };
    const probe = sshReachabilityProbe(db, ssh, creds);
    await expect(probe(clientId)).rejects.toThrow("kaboom");
  });
});
