/**
 * Tests for the Ansible venv bootstrap (#39, Phase-6 first-run step).
 *
 * The subprocess runner (`python3 -m venv` / `pip install`) is injected so no
 * test spawns Python or touches PyPI; the filesystem work (dir creation,
 * version sentinel, playbook sync) runs for real against a temp `ansibleDir`,
 * and the fake runner simulates Python creating the venv binary so the
 * default-deps paths (sentinel read/write) are exercised end to end.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAnsibleVenvSupervisor, type RunCommand } from "../../src/setup/ansible-venv.js";

const CORE_VERSION = "2.18.1";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pct-ansible-venv-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const venvBinary = (ansibleDir: string): string =>
  join(ansibleDir, "venv", "bin", "ansible-playbook");
const sentinel = (ansibleDir: string): string =>
  join(ansibleDir, "venv", ".pct-ansible-core-version");
const playbooksDest = (ansibleDir: string): string => join(ansibleDir, "playbooks");

interface Recorder {
  calls: { file: string; args: string[] }[];
  run: RunCommand;
}

/**
 * A runner that records every call and, on a `python -m venv <dir>` call,
 * simulates the interpreter by creating the venv's `bin/ansible-playbook` — so
 * the real default sentinel writer (which writes inside the venv) succeeds.
 */
function recordingRunner(opts: { failOn?: "venv" | "pip" } = {}): Recorder {
  const calls: { file: string; args: string[] }[] = [];
  const run: RunCommand = async (file, args) => {
    calls.push({ file, args });
    const isVenv = args.includes("venv");
    const isPip = args.includes("pip");
    if ((opts.failOn === "venv" && isVenv) || (opts.failOn === "pip" && isPip)) {
      throw new Error(`simulated ${opts.failOn} failure`);
    }
    if (isVenv) {
      const venvDir = args[args.length - 1] as string;
      mkdirSync(join(venvDir, "bin"), { recursive: true });
      writeFileSync(join(venvDir, "bin", "ansible-playbook"), "#!/bin/sh\n");
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

function fakeLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe("AnsibleVenvSupervisor construction", () => {
  it("reports idle, spawns nothing, and exposes the resolved paths", () => {
    const runCommand = vi.fn();
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand },
    );
    const status = supervisor.status;
    expect(status.state).toBe("idle");
    expect(status.checkedAt).toBeNull();
    expect(status.binaryPath).toBe(venvBinary(dir));
    expect(status.playbooksDir).toBe(playbooksDest(dir));
    expect(status.coreVersion).toBe(CORE_VERSION);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("returns a copy from status (snapshot is immutable from outside)", () => {
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: vi.fn() },
    );
    expect(supervisor.status).not.toBe(supervisor.status);
  });
});

describe("AnsibleVenvSupervisor.bootstrap — venv creation", () => {
  it("creates the venv and pip-installs the pinned ansible-core when absent", async () => {
    const recorder = recordingRunner();
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: recorder.run },
    );

    const status = await supervisor.bootstrap();

    expect(status.state).toBe("ready");
    expect(status.checkedAt).not.toBeNull();
    expect(status.detail).toBeNull();
    // python -m venv <venvDir>, then <venv>/bin/python -m pip install …==<version>.
    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[0]?.file).toBe("python3");
    expect(recorder.calls[0]?.args).toEqual(["-m", "venv", join(dir, "venv")]);
    expect(recorder.calls[1]?.file).toBe(join(dir, "venv", "bin", "python"));
    expect(recorder.calls[1]?.args).toContain(`ansible-core==${CORE_VERSION}`);
    // The version sentinel is recorded for later drift detection.
    expect(readFileSync(sentinel(dir), "utf8").trim()).toBe(CORE_VERSION);
  });

  it("honours a configured python interpreter", async () => {
    const recorder = recordingRunner();
    const supervisor = createAnsibleVenvSupervisor(
      {
        ansibleDir: dir,
        coreVersion: CORE_VERSION,
        playbookSourceDir: join(dir, "src"),
        pythonBin: "python3.11",
      },
      { runCommand: recorder.run },
    );
    await supervisor.bootstrap();
    expect(recorder.calls[0]?.file).toBe("python3.11");
  });
});

describe("AnsibleVenvSupervisor.bootstrap — idempotency & reconciliation", () => {
  function seedVenv(version: string): void {
    mkdirSync(join(dir, "venv", "bin"), { recursive: true });
    writeFileSync(venvBinary(dir), "#!/bin/sh\n");
    writeFileSync(sentinel(dir), `${version}\n`);
  }

  it("is a no-op when the binary is present and the version matches", async () => {
    seedVenv(CORE_VERSION);
    const recorder = recordingRunner();
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: recorder.run },
    );

    const status = await supervisor.bootstrap();

    expect(status.state).toBe("ready");
    expect(recorder.calls).toHaveLength(0); // no venv create, no pip install
  });

  it("reinstalls (no venv recreate) when the recorded version drifts from the pin", async () => {
    seedVenv("2.17.0");
    const recorder = recordingRunner();
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: recorder.run },
    );

    const status = await supervisor.bootstrap();

    expect(status.state).toBe("ready");
    // Exactly one call — the pip reinstall — and not a `venv` recreate.
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.args).toContain("pip");
    expect(recorder.calls[0]?.args).toContain(`ansible-core==${CORE_VERSION}`);
    expect(recorder.calls[0]?.args).not.toContain("venv");
    expect(readFileSync(sentinel(dir), "utf8").trim()).toBe(CORE_VERSION);
  });

  it("reinstalls when the binary is present but the sentinel is missing", async () => {
    mkdirSync(join(dir, "venv", "bin"), { recursive: true });
    writeFileSync(venvBinary(dir), "#!/bin/sh\n");
    const recorder = recordingRunner();
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: recorder.run },
    );

    const status = await supervisor.bootstrap();

    expect(status.state).toBe("ready");
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.args).toContain("pip");
  });
});

describe("AnsibleVenvSupervisor.bootstrap — failure handling", () => {
  it("records unavailable with a reason and never throws when venv creation fails", async () => {
    const recorder = recordingRunner({ failOn: "venv" });
    const log = fakeLogger();
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: recorder.run },
    );

    const status = await supervisor.bootstrap(log);

    expect(status.state).toBe("unavailable");
    expect(status.detail).toContain("simulated venv failure");
    expect(status.checkedAt).not.toBeNull();
    expect(log.error).toHaveBeenCalled();
    expect(existsSync(sentinel(dir))).toBe(false);
  });

  it("records unavailable when the pip install fails (e.g. no network)", async () => {
    const recorder = recordingRunner({ failOn: "pip" });
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      { runCommand: recorder.run },
    );

    const status = await supervisor.bootstrap();

    expect(status.state).toBe("unavailable");
    expect(status.detail).toContain("simulated pip failure");
  });
});

describe("AnsibleVenvSupervisor.bootstrap — playbook sync", () => {
  it("copies playbooks from the in-image source into <ansibleDir>/playbooks", async () => {
    const source = join(dir, "image-playbooks");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "activitywatch.yml"), "---\n");
    const log = fakeLogger();
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: source },
      { runCommand: recordingRunner().run },
    );

    await supervisor.bootstrap(log);

    expect(existsSync(join(playbooksDest(dir), "activitywatch.yml"))).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ansible_playbook_sync" }),
      expect.stringContaining("synced"),
    );
  });

  it("no-ops the sync (and still bootstraps the venv) when the source is absent", async () => {
    const recorder = recordingRunner();
    const log = fakeLogger();
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "missing") },
      { runCommand: recorder.run },
    );

    const status = await supervisor.bootstrap(log);

    expect(status.state).toBe("ready");
    expect(existsSync(playbooksDest(dir))).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ansible_playbook_sync" }),
      expect.stringContaining("no in-image"),
    );
  });

  it("continues to bootstrap the venv when the playbook sync throws", async () => {
    const recorder = recordingRunner();
    const log = fakeLogger();
    const supervisor = createAnsibleVenvSupervisor(
      { ansibleDir: dir, coreVersion: CORE_VERSION, playbookSourceDir: join(dir, "src") },
      {
        runCommand: recorder.run,
        syncPlaybooks: () => {
          throw new Error("disk full");
        },
      },
    );

    const status = await supervisor.bootstrap(log);

    expect(status.state).toBe("ready");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ansible_playbook_sync" }),
      expect.stringContaining("disk full"),
    );
  });
});
