/**
 * Smoke test for the {@link mockSubprocess} helper: a `vi.mock`-ed
 * `node:child_process` routes `execFile`/`spawn` through the helper's mocks
 * and the recorders normalise the captured invocations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSubprocess } from "./subprocess.js";

// `mock`-prefixed so the hoisted `vi.mock` factory below may reference it.
const mockCp = mockSubprocess();
vi.mock("node:child_process", () => mockCp.module);

// Deferred import so the mock is registered before the module resolves —
// the canonical wiring documented in subprocess.ts.
const { execFile, spawn } = await import("node:child_process");

describe("mockSubprocess helper", () => {
  beforeEach(() => mockCp.reset());

  it("intercepts execFile and records the command and args", () => {
    execFile("timekpra", ["--settimelimitforday", "alice", "7200"]);

    expect(mockCp.execFileCalls()).toEqual([
      { command: "timekpra", args: ["--settimelimitforday", "alice", "7200"] },
    ]);
  });

  it("records spawn calls and an argument-less invocation as []", () => {
    spawn("ansible-playbook", ["site.yml"]);
    spawn("true");

    expect(mockCp.spawnCalls()).toEqual([
      { command: "ansible-playbook", args: ["site.yml"] },
      { command: "true", args: [] },
    ]);
  });

  it("reset() clears recorded calls", () => {
    execFile("timekpra", ["--version"]);
    expect(mockCp.execFileCalls().length).toBeGreaterThan(0);

    mockCp.reset();

    expect(mockCp.execFileCalls()).toEqual([]);
  });
});
