/**
 * Unit tests for the Ansible runner.
 *
 * `node:child_process` is mocked at the module level (per `docs/testing.md` →
 * "Transport — subprocess") so no real `ansible-playbook` is ever spawned —
 * the subprocess boundary is the license boundary and the unit suite must not
 * cross it. The mock both records the invocation (asserting the exact argv we
 * hand Ansible) and reads back the per-run inventory file the runner wrote.
 */
import { existsSync, readFileSync } from "node:fs";

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSubprocess } from "../../helpers/subprocess.js";

// `mock`-prefixed so the hoisted `vi.mock` factory may reference it.
const mockCp = mockSubprocess();
vi.mock("node:child_process", () => mockCp.module);

// Deferred import so the mock is registered before the module resolves.
const {
  createAnsibleRunner,
  AnsibleError,
  AnsibleInventoryError,
  AnsiblePlaybookFailedError,
  AnsibleUnavailableError,
  AnsibleUnreachableError,
} = await import("../../../src/transport/ansible/index.js");

const ANSIBLE_DIR = "/data/ansible";
const BINARY = "/data/ansible/venv/bin/ansible-playbook";
const PLAYBOOK_PATH = "/data/ansible/playbooks/site.yml";

// A no-op FastifyBaseLogger (logger:false), so the runner's structured logging
// runs without producing output or needing a hand-built logger stub.
const logger = Fastify({ logger: false }).log;

function makeRunner() {
  return createAnsibleRunner({ ansibleDir: ANSIBLE_DIR, logger });
}

/** The inventory path inside the recorded argv (`-i <path>`). */
function inventoryArg(): string {
  const [call] = mockCp.execFileCalls();
  if (call === undefined) throw new Error("execFile was not called");
  const idx = call.args.indexOf("-i");
  const path = call.args[idx + 1];
  if (path === undefined) throw new Error("no -i argument recorded");
  return path;
}

beforeEach(() => {
  mockCp.reset();
  // Default: a clean, successful run that echoes back the inventory it saw.
  mockCp.execFile.mockImplementation((_cmd, args, _opts, cb) => {
    const invPath = args[args.indexOf("-i") + 1];
    cb(null, `read inventory:\n${readFileSync(invPath, "utf8")}`, "");
  });
});

describe("createAnsibleRunner.runPlaybook — happy path", () => {
  it("invokes the venv binary with -i, the playbook path, and a generated inventory", async () => {
    const runner = makeRunner();

    const result = await runner.runPlaybook({
      playbook: "site.yml",
      hosts: [{ hostname: "mint-01.lan", sshUser: "pct-agent" }],
    });

    expect(result.exitCode).toBe(0);

    const [call] = mockCp.execFileCalls();
    expect(call?.command).toBe(BINARY);
    expect(call?.args.slice(0, 3)).toEqual(["-i", inventoryArg(), PLAYBOOK_PATH]);
    // The inventory the runner wrote (echoed back by the mock) has the host.
    expect(result.stdout).toContain("mint-01.lan ansible_user=pct-agent");
  });

  it("appends --limit and --extra-vars (as JSON) when provided", async () => {
    const runner = makeRunner();

    await runner.runPlaybook({
      playbook: "site.yml",
      hosts: [{ hostname: "box", sshUser: "pct-agent" }],
      limit: "box",
      extraVars: { filter_group: "kids", enabled: true },
    });

    const [call] = mockCp.execFileCalls();
    expect(call?.args).toContain("--limit");
    expect(call?.args).toContain("box");
    const evIndex = call?.args.indexOf("--extra-vars") ?? -1;
    expect(evIndex).toBeGreaterThan(-1);
    expect(JSON.parse(call?.args[evIndex + 1] ?? "{}")).toEqual({
      filter_group: "kids",
      enabled: true,
    });
  });

  it("removes the per-run temp inventory afterwards", async () => {
    const runner = makeRunner();
    await runner.runPlaybook({ playbook: "site.yml", hosts: [] });

    expect(existsSync(inventoryArg())).toBe(false);
  });
});

describe("createAnsibleRunner.runPlaybook — error taxonomy", () => {
  it("maps a spawn ENOENT to AnsibleUnavailableError (venv not bootstrapped)", async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error("spawn ansible-playbook ENOENT"), { code: "ENOENT" }), "", "");
    });

    const runner = makeRunner();
    await expect(runner.runPlaybook({ playbook: "site.yml", hosts: [] })).rejects.toBeInstanceOf(
      AnsibleUnavailableError,
    );
  });

  it("maps a spawn EACCES (binary not executable) to AnsibleUnavailableError", async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error("spawn EACCES"), { code: "EACCES" }), "", "");
    });

    const runner = makeRunner();
    await expect(runner.runPlaybook({ playbook: "site.yml", hosts: [] })).rejects.toBeInstanceOf(
      AnsibleUnavailableError,
    );
  });

  it("maps an exit code with the unreachable bit (4) to AnsibleUnreachableError", async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(
        Object.assign(new Error("unreachable"), { code: 4 }),
        "RECAP unreachable=1",
        "ssh: timeout",
      );
    });

    const runner = makeRunner();
    const error = await runner
      .runPlaybook({ playbook: "site.yml", hosts: [] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AnsibleUnreachableError);
    if (error instanceof AnsibleUnreachableError) {
      expect(error.exitCode).toBe(4);
      expect(error.stdout).toContain("RECAP unreachable=1");
      expect(error.stderr).toBe("ssh: timeout");
    }
  });

  it("treats a combined failed+unreachable code (6) as unreachable", async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error("mixed"), { code: 6 }), "", "");
    });

    const runner = makeRunner();
    await expect(runner.runPlaybook({ playbook: "site.yml", hosts: [] })).rejects.toBeInstanceOf(
      AnsibleUnreachableError,
    );
  });

  it("maps a plain non-zero exit (2) to AnsiblePlaybookFailedError, keeping stdout+stderr", async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error("failed"), { code: 2 }), "PLAY RECAP failed=1", "a task failed");
    });

    const runner = makeRunner();
    const error = await runner
      .runPlaybook({ playbook: "site.yml", hosts: [] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AnsiblePlaybookFailedError);
    if (error instanceof AnsiblePlaybookFailedError) {
      expect(error.exitCode).toBe(2);
      // The PLAY RECAP and task output live in stdout, not stderr.
      expect(error.stdout).toContain("PLAY RECAP failed=1");
      expect(error.stderr).toBe("a task failed");
    }
  });

  it("treats a kill-by-signal (code null) as a failure with no numeric exit code", async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(
        Object.assign(new Error("killed"), { code: null, killed: true, signal: "SIGTERM" }),
        "",
        "",
      );
    });

    const runner = makeRunner();
    const error = await runner
      .runPlaybook({ playbook: "site.yml", hosts: [] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AnsiblePlaybookFailedError);
    if (error instanceof AnsiblePlaybookFailedError) {
      expect(error.exitCode).toBeNull();
      expect(error.message).toContain("SIGTERM");
    }
  });

  it("treats a maxBuffer overflow (string code, no exit code) as a failure, not exit 1", async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(
        Object.assign(new Error("stdout maxBuffer exceeded"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        }),
        "",
        "",
      );
    });

    const runner = makeRunner();
    const error = await runner
      .runPlaybook({ playbook: "site.yml", hosts: [] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AnsiblePlaybookFailedError);
    if (error instanceof AnsiblePlaybookFailedError) {
      expect(error.exitCode).toBeNull();
      expect(error.message).toContain("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    }
  });

  it("falls back to 'unknown error' when there is neither an exit code nor a signal", async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error("mystery"), { code: null }), "", "");
    });

    const runner = makeRunner();
    const error = await runner
      .runPlaybook({ playbook: "site.yml", hosts: [] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AnsiblePlaybookFailedError);
    if (error instanceof AnsiblePlaybookFailedError) {
      expect(error.exitCode).toBeNull();
      expect(error.message).toContain("unknown error");
    }
  });
});

describe("createAnsibleRunner.runPlaybook — input validation", () => {
  it("rejects a playbook name that escapes the playbooks directory", async () => {
    const runner = makeRunner();

    await expect(
      runner.runPlaybook({ playbook: "../../etc/passwd", hosts: [] }),
    ).rejects.toBeInstanceOf(AnsibleError);
    // Nothing was spawned: the guard fires before any subprocess.
    expect(mockCp.execFileCalls()).toEqual([]);
  });

  it("rejects an unsafe host before spawning anything", async () => {
    const runner = makeRunner();

    await expect(
      runner.runPlaybook({
        playbook: "site.yml",
        hosts: [{ hostname: "a b", sshUser: "pct-agent" }],
      }),
    ).rejects.toBeInstanceOf(AnsibleInventoryError);
    expect(mockCp.execFileCalls()).toEqual([]);
  });
});
