/**
 * Shared subprocess-mock helper.
 *
 * Phase-4 transport unit tests must never invoke a real `timekpra` or
 * `ansible-playbook` (the GPL tools are driven only as subprocesses across a
 * process boundary — see `CLAUDE.md` → "License boundaries"). This helper
 * wraps the `vi.mock("node:child_process")` pattern from `docs/testing.md` →
 * "Mock patterns by layer → Transport — subprocess": it supplies the
 * `execFile`/`spawn` mock functions, the `module` object to hand back from
 * the mock factory, and recorders that normalise the captured invocations
 * for assertion.
 *
 * `vi.mock` is hoisted above imports, so its factory cannot reference an
 * imported helper directly (the import isn't initialised yet) and `vi.hoisted`
 * can only see `vi` itself — not `mockSubprocess`. Instead, assign the mock to
 * a `mock`-prefixed top-level binding (which Vitest allows the factory to
 * reference) and load anything that imports `node:child_process` — the code
 * under test, or `node:child_process` itself — via a top-level `await import`,
 * so the factory runs after the mock exists:
 *
 * ```ts
 * import { mockSubprocess } from "../helpers/subprocess.js";
 *
 * const mockCp = mockSubprocess();
 * vi.mock("node:child_process", () => mockCp.module);
 *
 * // Deferred import so the mock is registered before the module resolves.
 * const { setDailyLimit } = await import("../../src/transport/ssh/index.js");
 *
 * it("invokes timekpra with the right arguments", async () => {
 *   await setDailyLimit({ user: "alice", seconds: 7200 });
 *   expect(mockCp.execFileCalls()).toEqual([
 *     { command: "timekpra", args: ["--settimelimitforday", "alice", "7200"] },
 *   ]);
 * });
 * ```
 */
import { vi, type Mock } from "vitest";

/** A captured subprocess invocation, reduced to the bits tests assert on. */
export interface RecordedCall {
  /** The executable name/path (first argument to `execFile`/`spawn`). */
  command: string;
  /** The positional CLI arguments, or `[]` when none were passed. */
  args: string[];
}

/** A configured `node:child_process` mock plus its recorders. */
export interface SubprocessMock {
  /** Mock for `child_process.execFile`. */
  execFile: Mock;
  /** Mock for `child_process.spawn`. */
  spawn: Mock;
  /** Object to return from `vi.mock("node:child_process", () => …)`. */
  module: { execFile: Mock; spawn: Mock };
  /** Recorded `execFile` invocations, in call order. */
  execFileCalls(): RecordedCall[];
  /** Recorded `spawn` invocations, in call order. */
  spawnCalls(): RecordedCall[];
  /** Clear recorded calls and any configured implementations. */
  reset(): void;
}

/** Normalise a mock's raw `.mock.calls` into `{ command, args }` records. */
function toRecordedCalls(mock: Mock): RecordedCall[] {
  return mock.mock.calls.map((call): RecordedCall => {
    const command = call[0] as unknown;
    const maybeArgs = call[1] as unknown;
    return {
      command: String(command),
      args: Array.isArray(maybeArgs) ? maybeArgs.map((arg: unknown) => String(arg)) : [],
    };
  });
}

/**
 * Create a `node:child_process` mock that records `execFile`/`spawn` calls.
 *
 * Assign the result to a `mock`-prefixed top-level binding and hand `module`
 * to `vi.mock("node:child_process", …)` — see the module docstring for the
 * canonical wiring (and why `vi.hoisted` can't be used here).
 */
export function mockSubprocess(): SubprocessMock {
  const execFile = vi.fn();
  const spawn = vi.fn();

  return {
    execFile,
    spawn,
    module: { execFile, spawn },
    execFileCalls: () => toRecordedCalls(execFile),
    spawnCalls: () => toRecordedCalls(spawn),
    reset: () => {
      execFile.mockReset();
      spawn.mockReset();
    },
  };
}
