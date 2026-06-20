/**
 * Unit tests for the periodic re-apply scheduler (#93): the backoff-gated,
 * probe-gated, per-client re-apply pass, per-(client, playbook) audit
 * recording, per-client exponential backoff, error isolation, and the
 * start/stop lifecycle. The cron schedule itself isn't fired — `tick()` (the
 * same function each cron tick invokes) is driven directly.
 */
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "../../../src/config.js";
import { createClient } from "../../../src/policy/repository.js";
import {
  AnsiblePlaybookFailedError,
  AnsibleUnavailableError,
  AnsibleUnreachableError,
  type AnsibleRunner,
  type AnsibleRunResult,
} from "../../../src/transport/ansible/index.js";
import {
  DrizzleAuditSink,
  listAuditEntries,
  type AuditEntry,
  type AuditSink,
} from "../../../src/transport/audit/index.js";
import {
  DEFAULT_REAPPLY_BACKOFF,
  DEFAULT_REAPPLY_PATTERN,
  REAPPLY_AUDIT_REASON,
  REAPPLY_LOG_COMPONENT,
  startPeriodicReapply,
  type PeriodicReapplyHandle,
  type PeriodicReapplyOptions,
  type ReapplyTarget,
} from "../../../src/transport/reapply/index.js";
import { buildApp } from "../../../src/web/app.js";
import { testDb, type TestDb } from "../../helpers/db.js";

/** A runner whose `runPlaybook` is a controllable spy. */
function fakeRunner(impl: AnsibleRunner["runPlaybook"]): AnsibleRunner {
  return { runPlaybook: vi.fn(impl) };
}

/** A runner that always succeeds. */
const ok: AnsibleRunner["runPlaybook"] = async ({ playbook }): Promise<AnsibleRunResult> => ({
  playbook,
  exitCode: 0,
  stdout: "",
  stderr: "",
});

/** A capturing audit sink. */
function capturingSink(): { sink: AuditSink; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { sink: { record: (entry) => entries.push(entry) }, entries };
}

const HOSTS: readonly ReapplyTarget[] = [{ id: 1, hostname: "mint-01", sshUser: "pct-agent" }];

describe("startPeriodicReapply", () => {
  let log: FastifyBaseLogger;
  let lines: Record<string, unknown>[];
  let app: ReturnType<typeof buildApp>;
  let db: TestDb;
  let handles: PeriodicReapplyHandle[];

  beforeEach(() => {
    db = testDb();
    lines = [];
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "debug", PCT_SECRET_KEY: "test-secret-key" }),
      loggerStream: {
        write: (msg) => {
          lines.push(JSON.parse(msg) as Record<string, unknown>);
        },
      },
      db,
    });
    log = app.log;
    handles = [];
  });
  afterEach(async () => {
    for (const handle of handles) handle.stop();
    await app.close();
    db.$client.close();
  });

  function start(overrides: Partial<PeriodicReapplyOptions> = {}): PeriodicReapplyHandle {
    const handle = startPeriodicReapply({
      loadClients: () => HOSTS,
      probe: async () => true,
      runner: fakeRunner(ok),
      playbooks: ["e2guardian.yml"],
      audit: capturingSink().sink,
      log,
      ...overrides,
    });
    handles.push(handle);
    return handle;
  }

  it("re-applies every playbook against a reachable client and audits each", async () => {
    const runner = fakeRunner(ok);
    const { sink, entries } = capturingSink();

    await start({
      runner,
      audit: sink,
      playbooks: ["e2guardian.yml", "activitywatch.yml"],
    }).tick();

    expect(runner.runPlaybook).toHaveBeenCalledTimes(2);
    expect(runner.runPlaybook).toHaveBeenNthCalledWith(1, {
      playbook: "e2guardian.yml",
      hosts: [HOSTS[0]],
      limit: "mint-01",
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      target: { host: "mint-01", port: 22, username: "pct-agent" },
      command: ["ansible-playbook", "e2guardian.yml", "--limit", "mint-01"],
      outcome: "ok",
      exitCode: 0,
      context: { clientId: 1, userId: null, actor: "system", reason: REAPPLY_AUDIT_REASON },
    });

    expect(lines.find((l) => l.msg === "re-apply pass succeeded")).toMatchObject({
      component: REAPPLY_LOG_COMPONENT,
      clientId: 1,
      playbooks: 2,
    });
  });

  it("skips an offline client without running or auditing anything", async () => {
    const runner = fakeRunner(ok);
    const { sink, entries } = capturingSink();

    await start({ runner, audit: sink, probe: async () => false }).tick();

    expect(runner.runPlaybook).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
  });

  it("is a complete no-op (no probe) when no playbooks are configured", async () => {
    const probe = vi.fn(async () => true);
    const runner = fakeRunner(ok);

    await start({ probe, runner, playbooks: [] }).tick();

    expect(probe).not.toHaveBeenCalled();
    expect(runner.runPlaybook).not.toHaveBeenCalled();
  });

  it("records a failed playbook and backs the client off until the delay elapses", async () => {
    let clock = 1_000_000;
    const now = (): number => clock;
    const runner = fakeRunner(async () => {
      throw new AnsiblePlaybookFailedError(2, "TASK failed", "");
    });
    const { sink, entries } = capturingSink();

    const handle = start({ runner, audit: sink, now });
    await handle.tick();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "failed", exitCode: 2 });
    expect(lines.find((l) => l.msg === "re-apply failed; backing off client")).toMatchObject({
      component: REAPPLY_LOG_COMPONENT,
      clientId: 1,
      failures: 1,
      nextRetryMs: DEFAULT_REAPPLY_BACKOFF.baseMs,
    });

    // Still inside the backoff window: the next tick skips the client entirely.
    clock += DEFAULT_REAPPLY_BACKOFF.baseMs - 1;
    (runner.runPlaybook as ReturnType<typeof vi.fn>).mockClear();
    await handle.tick();
    expect(runner.runPlaybook).not.toHaveBeenCalled();

    // Once the delay has elapsed the client is retried.
    clock += 2;
    await handle.tick();
    expect(runner.runPlaybook).toHaveBeenCalledTimes(1);
  });

  it("clears the backoff after a clean pass so the client returns to cadence", async () => {
    let clock = 0;
    const now = (): number => clock;
    let shouldFail = true;
    const runner = fakeRunner(async ({ playbook }) => {
      if (shouldFail) throw new AnsiblePlaybookFailedError(2, "boom", "");
      return { playbook, exitCode: 0, stdout: "", stderr: "" };
    });

    const handle = start({ runner, now });
    await handle.tick(); // fails → backoff

    clock += DEFAULT_REAPPLY_BACKOFF.baseMs;
    shouldFail = false;
    await handle.tick(); // succeeds → backoff cleared
    expect(lines.find((l) => l.msg === "re-apply pass succeeded")).toBeDefined();

    // No backoff remains: an immediate subsequent tick runs again.
    (runner.runPlaybook as ReturnType<typeof vi.fn>).mockClear();
    await handle.tick();
    expect(runner.runPlaybook).toHaveBeenCalledTimes(1);
  });

  it("treats an unreachable host as transient: audits it but never backs off", async () => {
    const clock = 0;
    const now = (): number => clock;
    const runner = fakeRunner(async () => {
      throw new AnsibleUnreachableError(4, "", "unreachable");
    });
    const { sink, entries } = capturingSink();

    const handle = start({
      runner,
      audit: sink,
      now,
      playbooks: ["e2guardian.yml", "activitywatch.yml"],
    });
    await handle.tick();

    // The first playbook came back unreachable → the pass stops there (the
    // second playbook isn't attempted against a host that's now down).
    expect(runner.runPlaybook).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "unreachable", exitCode: 4 });
    expect(lines.find((l) => l.msg === "re-apply failed; backing off client")).toBeUndefined();

    // No backoff was recorded, so an immediate tick retries (no clock advance).
    (runner.runPlaybook as ReturnType<typeof vi.fn>).mockClear();
    await handle.tick();
    expect(runner.runPlaybook).toHaveBeenCalledTimes(1);
  });

  it("attempts later playbooks after a non-unreachable failure, then backs off", async () => {
    const runner = fakeRunner(async ({ playbook }) => {
      if (playbook === "first.yml") throw new AnsiblePlaybookFailedError(2, "boom", "");
      return { playbook, exitCode: 0, stdout: "", stderr: "" };
    });
    const { sink, entries } = capturingSink();

    await start({ runner, audit: sink, playbooks: ["first.yml", "second.yml"] }).tick();

    expect(runner.runPlaybook).toHaveBeenCalledTimes(2);
    expect(entries.map((e) => e.outcome)).toEqual(["failed", "ok"]);
    expect(lines.find((l) => l.msg === "re-apply failed; backing off client")).toBeDefined();
  });

  it("records AnsibleUnavailableError (no venv) as a failure and backs off", async () => {
    const runner = fakeRunner(async () => {
      throw new AnsibleUnavailableError("/data/ansible/venv/bin/ansible-playbook");
    });
    const { sink, entries } = capturingSink();

    await start({ runner, audit: sink }).tick();

    expect(entries[0]).toMatchObject({ outcome: "failed", exitCode: null });
    expect(entries[0]?.errorMessage).toContain("ansible-playbook is not available");
    expect(lines.find((l) => l.msg === "re-apply failed; backing off client")).toBeDefined();
  });

  it("isolates one client's probe failure and still re-applies the others", async () => {
    const clients: ReapplyTarget[] = [
      { id: 1, hostname: "mint-01", sshUser: "pct-agent" },
      { id: 2, hostname: "mint-02", sshUser: "pct-agent" },
    ];
    const runner = fakeRunner(ok);
    const probe = vi.fn(async (id: number) => {
      if (id === 1) throw new Error("probe exploded");
      return true;
    });

    await start({ loadClients: () => clients, probe, runner }).tick();

    expect(runner.runPlaybook).toHaveBeenCalledTimes(1);
    expect(runner.runPlaybook).toHaveBeenCalledWith(
      expect.objectContaining({ hosts: [clients[1]] }),
    );
    expect(lines.find((l) => l.msg === "re-apply error")).toMatchObject({
      component: REAPPLY_LOG_COMPONENT,
      clientId: 1,
    });
  });

  it("persists a readable audit row via the real DrizzleAuditSink", async () => {
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const clients: ReapplyTarget[] = [{ id: clientId, hostname: "mint-01", sshUser: "pct-agent" }];

    await start({
      loadClients: () => clients,
      runner: fakeRunner(ok),
      audit: new DrizzleAuditSink(db),
    }).tick();

    const rows = listAuditEntries(db, { clientId, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetHost: "mint-01",
      targetPort: 22,
      targetUser: "pct-agent",
      clientId,
      actor: "system",
      reason: REAPPLY_AUDIT_REASON,
      outcome: "ok",
      exitCode: 0,
    });
    expect(rows[0]?.command).toContain("e2guardian.yml");
  });

  it("records a non-Error rejection as a failure with a stringified message", async () => {
    const runner = fakeRunner(async () => {
      // A runner that rejects with a non-Error value (defensive path).
      throw "spawn glitch";
    });
    const { sink, entries } = capturingSink();

    await start({ runner, audit: sink }).tick();

    expect(entries[0]).toMatchObject({
      outcome: "failed",
      exitCode: null,
      errorMessage: "spawn glitch",
    });
  });

  it("truncates an oversized error message before recording it", async () => {
    const runner = fakeRunner(async () => {
      throw new AnsiblePlaybookFailedError(2, "", "", "x".repeat(3000));
    });
    const { sink, entries } = capturingSink();

    await start({ runner, audit: sink }).tick();

    const message = entries[0]?.errorMessage ?? "";
    expect(message.length).toBeLessThan(3000);
    expect(message.endsWith("…")).toBe(true);
  });

  it("stops cleanly and exposes the default cadence", () => {
    expect(DEFAULT_REAPPLY_PATTERN).toBe("0 * * * *");
    const handle = start();
    expect(() => handle.stop()).not.toThrow();
  });
});
