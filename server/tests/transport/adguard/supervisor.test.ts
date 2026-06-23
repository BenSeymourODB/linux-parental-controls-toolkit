/**
 * Tests for the AdGuard Home managed-mode supervisor (#96).
 *
 * The acquisition, config seed, process spawn, clock, and backoff/stop delays
 * are all injected, so no test spawns a real process or waits on real time: a
 * controllable fake process drives exit/error, and a fake `delay` either
 * resolves immediately (restart backoff) or never (stop grace) per test.
 */
import { describe, expect, it, vi } from "vitest";

import type { AcquireResult } from "../../../src/transport/adguard/acquire.js";
import {
  createAdGuardManagedSupervisor,
  type ManagedProcess,
  type SpawnManaged,
} from "../../../src/transport/adguard/supervisor.js";

const CONFIG = { dataDir: "/data/adguard", bindAddr: "0.0.0.0:53", adminPort: 3000 };

/** A fully-controllable {@link ManagedProcess} for tests. */
class FakeProcess implements ManagedProcess {
  pid: number | undefined = 4242;
  #exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  #error: ((err: Error) => void) | null = null;
  readonly kills: NodeJS.Signals[] = [];
  /** When set, killing with this signal auto-fires `exit`. */
  autoExitOn: NodeJS.Signals | null = null;

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#exit = listener;
  }
  onError(listener: (err: Error) => void): void {
    this.#error = listener;
  }
  kill(signal: NodeJS.Signals): void {
    this.kills.push(signal);
    if (signal === this.autoExitOn) this.triggerExit(null, signal);
  }
  triggerExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#exit?.(code, signal);
  }
  triggerError(err: Error): void {
    this.#error?.(err);
  }
}

/** A spawn factory recording every spawned fake process. */
function fakeSpawn(): { spawn: SpawnManaged; procs: FakeProcess[] } {
  const procs: FakeProcess[] = [];
  const spawn: SpawnManaged = () => {
    const proc = new FakeProcess();
    procs.push(proc);
    return proc;
  };
  return { spawn, procs };
}

/** Index into a process list, asserting presence (keeps tests free of `!`). */
function only(procs: FakeProcess[], index: number): FakeProcess {
  const proc = procs[index];
  if (proc === undefined) throw new Error(`no spawned process at index ${index}`);
  return proc;
}

const okAcquire = async (): Promise<AcquireResult> => ({
  binaryPath: "/data/adguard/AdGuardHome",
  version: "v0.107.65",
  fetched: true,
});

/** Let queued microtasks (immediate-`delay` restarts) settle. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("AdGuardManagedSupervisor.bootstrap", () => {
  it("acquires, seeds config, and reaches running", async () => {
    const { spawn, procs } = fakeSpawn();
    const seeds: string[] = [];
    const sup = createAdGuardManagedSupervisor(CONFIG, {
      acquire: okAcquire,
      writeSeedConfig: (path) => {
        seeds.push(path);
        return true;
      },
      spawn,
    });

    const status = await sup.bootstrap();

    expect(status.state).toBe("running");
    expect(status.version).toBe("v0.107.65");
    expect(status.adminEndpoint).toBe("http://127.0.0.1:3000");
    expect(procs).toHaveLength(1);
    expect(seeds).toEqual(["/data/adguard/conf/AdGuardHome.yaml"]);
  });

  it("records failed (never throws) when acquisition fails", async () => {
    const { spawn, procs } = fakeSpawn();
    const sup = createAdGuardManagedSupervisor(CONFIG, {
      acquire: () => Promise.reject(new Error("network down")),
      writeSeedConfig: () => true,
      spawn,
    });

    const status = await sup.bootstrap();

    expect(status.state).toBe("failed");
    expect(status.detail).toContain("network down");
    expect(procs).toHaveLength(0);
  });

  it("records failed on a spawn error", async () => {
    const { spawn, procs } = fakeSpawn();
    const sup = createAdGuardManagedSupervisor(CONFIG, {
      acquire: okAcquire,
      writeSeedConfig: () => true,
      spawn,
    });

    await sup.bootstrap();
    expect(sup.status.state).toBe("running");

    only(procs, 0).triggerError(new Error("ENOENT"));
    expect(sup.status.state).toBe("failed");
    expect(sup.status.detail).toContain("ENOENT");
  });
});

describe("AdGuardManagedSupervisor restart-on-exit", () => {
  it("restarts with backoff on an unexpected exit", async () => {
    const { spawn, procs } = fakeSpawn();
    const delays: number[] = [];
    const sup = createAdGuardManagedSupervisor(CONFIG, {
      acquire: okAcquire,
      writeSeedConfig: () => true,
      spawn,
      delay: async (ms) => {
        delays.push(ms);
      },
      backoffBaseMs: 1000,
      stableMs: 60_000,
      now: () => new Date(0), // every run looks instantaneous → no stable reset
    });

    await sup.bootstrap();
    only(procs, 0).triggerExit(1, null);
    await flush();

    expect(delays).toEqual([1000]); // base backoff, first attempt
    expect(procs).toHaveLength(2); // restarted
    expect(sup.status.state).toBe("running");
    expect(sup.status.restarts).toBe(1);
  });

  it("gives up to failed after exceeding the restart cap", async () => {
    const { spawn, procs } = fakeSpawn();
    const sup = createAdGuardManagedSupervisor(CONFIG, {
      acquire: okAcquire,
      writeSeedConfig: () => true,
      spawn,
      delay: () => Promise.resolve(),
      maxRestarts: 2,
      stableMs: 60_000,
      now: () => new Date(0),
    });

    await sup.bootstrap();
    // Crash repeatedly: 2 restarts allowed, the 3rd unexpected exit gives up.
    for (let i = 0; i < 3; i++) {
      only(procs, procs.length - 1).triggerExit(1, null);
      await flush();
    }

    expect(sup.status.state).toBe("failed");
    expect(sup.status.detail).toContain("restart cap");
    expect(procs).toHaveLength(3); // initial + 2 restarts; no 4th spawn
  });

  it("resets the restart counter after a stable run", async () => {
    const { spawn, procs } = fakeSpawn();
    let clock = 0;
    const sup = createAdGuardManagedSupervisor(CONFIG, {
      acquire: okAcquire,
      writeSeedConfig: () => true,
      spawn,
      delay: () => Promise.resolve(),
      maxRestarts: 2,
      stableMs: 1000,
      now: () => new Date(clock),
    });

    await sup.bootstrap();
    // First crash is immediate (uptime 0 < stableMs) → restarts = 1.
    only(procs, procs.length - 1).triggerExit(1, null);
    await flush();
    expect(sup.status.restarts).toBe(1);

    // Advance the clock past stableMs before the next crash → counter resets to 0
    // then increments to 1, never reaching the cap.
    clock = 5000;
    only(procs, procs.length - 1).triggerExit(1, null);
    await flush();
    expect(sup.status.restarts).toBe(1);
    expect(sup.status.state).toBe("running");
  });
});

describe("AdGuardManagedSupervisor.stop", () => {
  it("sends SIGTERM and resolves when the child exits", async () => {
    const { spawn, procs } = fakeSpawn();
    const sup = createAdGuardManagedSupervisor(CONFIG, {
      acquire: okAcquire,
      writeSeedConfig: () => true,
      spawn,
      delay: () => new Promise<void>(() => undefined), // stop grace never elapses
    });

    await sup.bootstrap();
    const stopping = sup.stop();
    only(procs, 0).triggerExit(0, "SIGTERM");
    await stopping;

    expect(only(procs, 0).kills).toEqual(["SIGTERM"]);
    expect(sup.status.state).toBe("stopped");
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const { spawn, procs } = fakeSpawn();
    const sup = createAdGuardManagedSupervisor(CONFIG, {
      acquire: okAcquire,
      writeSeedConfig: () => true,
      spawn,
      delay: () => Promise.resolve(), // stop grace elapses immediately
    });

    await sup.bootstrap();
    only(procs, 0).autoExitOn = "SIGKILL"; // dies only on the hard kill
    await sup.stop();

    expect(only(procs, 0).kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(sup.status.state).toBe("stopped");
  });

  it("is a no-op when nothing is running", async () => {
    const sup = createAdGuardManagedSupervisor(CONFIG, {
      acquire: okAcquire,
      writeSeedConfig: () => true,
      spawn: fakeSpawn().spawn,
    });

    await sup.stop();
    expect(sup.status.state).toBe("stopped");
  });

  it("does not restart after a stop-initiated exit", async () => {
    const { spawn, procs } = fakeSpawn();
    const sup = createAdGuardManagedSupervisor(CONFIG, {
      acquire: okAcquire,
      writeSeedConfig: () => true,
      spawn,
      delay: () => Promise.resolve(),
    });

    await sup.bootstrap();
    const stopping = sup.stop();
    only(procs, 0).triggerExit(0, "SIGTERM");
    await stopping;
    await flush();

    expect(procs).toHaveLength(1); // no restart spawned
    expect(sup.status.state).toBe("stopped");
  });
});

describe("createAdGuardManagedSupervisor", () => {
  it("starts idle before bootstrap and spawns nothing", () => {
    const spy = vi.fn();
    const sup = createAdGuardManagedSupervisor(CONFIG, { spawn: spy });
    expect(sup.status.state).toBe("idle");
    expect(sup.status.binaryPath).toBe("/data/adguard/AdGuardHome");
    expect(spy).not.toHaveBeenCalled();
  });
});
