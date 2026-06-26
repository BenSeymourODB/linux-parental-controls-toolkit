/**
 * Unit tests for the per-`kind` composite executor (#274): it routes each
 * queued action to the executor registered for its `kind`, and rejects
 * non-retriably for an unregistered kind so the drainer dead-letters it.
 */
import { describe, expect, it, vi } from "vitest";

import { compositeExecutor } from "../../../src/transport/queue/composite.js";
import { isRetriable, type QueuedAction } from "../../../src/transport/queue/types.js";

function action(kind: string): QueuedAction {
  return { clientId: 1, coalesceKey: "k", kind, payload: {} };
}

describe("compositeExecutor", () => {
  it("dispatches to the executor registered for the action's kind", async () => {
    const push = vi.fn<(a: QueuedAction) => Promise<void>>().mockResolvedValue();
    const timeToday = vi.fn<(a: QueuedAction) => Promise<void>>().mockResolvedValue();
    const execute = compositeExecutor({ "policy.push": push, "timekpr.time-today": timeToday });

    await execute(action("timekpr.time-today"));

    expect(timeToday).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });

  it("propagates the chosen executor's rejection unchanged", async () => {
    const boom = Object.assign(new Error("unreachable"), { retriable: true });
    const execute = compositeExecutor({
      "policy.push": () => Promise.reject(boom),
    });

    await expect(execute(action("policy.push"))).rejects.toBe(boom);
  });

  it("rejects non-retriably for an unregistered kind", async () => {
    const execute = compositeExecutor({ "policy.push": () => Promise.resolve() });

    await expect(execute(action("mystery.kind"))).rejects.toMatchObject({
      message: expect.stringContaining("mystery.kind"),
    });
    // Non-retriable ⇒ the drainer dead-letters rather than retrying forever.
    await execute(action("mystery.kind")).catch((err: unknown) => {
      expect(isRetriable(err)).toBe(false);
    });
  });
});
