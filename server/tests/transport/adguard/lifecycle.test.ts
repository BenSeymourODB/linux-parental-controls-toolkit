/**
 * Tests for the managed AdGuard Home lifecycle state machine (#310).
 *
 * The transition table is verified as pure data, and the machine's advisory
 * (never-throwing) `onInvalid` behaviour is exercised directly.
 */
import { describe, expect, it, vi } from "vitest";

import {
  LifecycleMachine,
  STATE_TRANSITIONS,
  isValidTransition,
  type AdGuardManagedState,
} from "../../../src/transport/adguard/lifecycle.js";

const ALL_STATES: readonly AdGuardManagedState[] = [
  "idle",
  "fetching",
  "starting",
  "running",
  "stopped",
  "failed",
];

describe("isValidTransition", () => {
  it("accepts every declared edge", () => {
    for (const from of ALL_STATES) {
      for (const to of STATE_TRANSITIONS[from]) {
        expect(isValidTransition(from, to)).toBe(true);
      }
    }
  });

  it("rejects edges absent from the table", () => {
    // A representative sample of transitions the supervisor never makes.
    expect(isValidTransition("idle", "running")).toBe(false);
    expect(isValidTransition("running", "fetching")).toBe(false);
    expect(isValidTransition("stopped", "running")).toBe(false);
    expect(isValidTransition("failed", "running")).toBe(false);
    expect(isValidTransition("starting", "stopped")).toBe(false);
  });

  it("declares the supervisor's real happy path", () => {
    expect(isValidTransition("idle", "fetching")).toBe(true);
    expect(isValidTransition("fetching", "starting")).toBe(true);
    expect(isValidTransition("starting", "running")).toBe(true);
    expect(isValidTransition("running", "stopped")).toBe(true);
    // Restart-after-crash and re-bootstrap edges.
    expect(isValidTransition("running", "starting")).toBe(true);
    expect(isValidTransition("failed", "fetching")).toBe(true);
  });
});

describe("LifecycleMachine", () => {
  it("starts idle by default and tracks the current state", () => {
    const machine = new LifecycleMachine();
    expect(machine.state).toBe("idle");

    machine.transition("fetching");
    expect(machine.state).toBe("fetching");
    machine.transition("starting");
    machine.transition("running");
    expect(machine.state).toBe("running");
  });

  it("accepts an explicit initial state", () => {
    expect(new LifecycleMachine("running").state).toBe("running");
  });

  it("does not call onInvalid for a declared transition", () => {
    const onInvalid = vi.fn();
    const machine = new LifecycleMachine("idle");
    machine.transition("fetching", onInvalid);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("calls onInvalid for an undeclared transition but still applies it", () => {
    const onInvalid = vi.fn();
    const machine = new LifecycleMachine("idle");
    machine.transition("running", onInvalid); // idle -> running is undeclared
    expect(onInvalid).toHaveBeenCalledWith("idle", "running");
    expect(machine.state).toBe("running"); // advisory: still applied
  });

  it("treats a self-transition as a silent no-op change", () => {
    const onInvalid = vi.fn();
    const machine = new LifecycleMachine("running");
    machine.transition("running", onInvalid);
    expect(onInvalid).not.toHaveBeenCalled();
    expect(machine.state).toBe("running");
  });

  it("never throws even without an onInvalid callback", () => {
    const machine = new LifecycleMachine("idle");
    expect(() => machine.transition("running")).not.toThrow();
    expect(machine.state).toBe("running");
  });
});
