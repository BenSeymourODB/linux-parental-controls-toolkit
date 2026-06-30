/**
 * Unit tests for the platform-keyed runner registry (#232): the dispatch table
 * the live executor uses to pick a {@link PlatformPolicyRunner} by
 * `Client.platform`. Exact-match lookup, registration listing, and the
 * duplicate-registration guard.
 */
import { describe, expect, it } from "vitest";

import {
  createPlatformRunnerRegistry,
  type PlatformPolicyRunner,
} from "../../../src/transport/policy-push/platform-runner.js";

/** A do-nothing runner for a given platform (the registry never calls its methods). */
function stubRunner(platform: PlatformPolicyRunner["platform"]): PlatformPolicyRunner {
  return {
    platform,
    enforce: async (): Promise<void> => undefined,
    unmanage: async (): Promise<void> => undefined,
  };
}

describe("createPlatformRunnerRegistry", () => {
  it("resolves a registered platform to its runner", () => {
    const linux = stubRunner("linux");
    const registry = createPlatformRunnerRegistry([linux]);

    expect(registry.resolve("linux")).toBe(linux);
  });

  it("returns undefined for a platform with no registered runner", () => {
    const registry = createPlatformRunnerRegistry([stubRunner("linux")]);

    // `windows` is a valid `Client.platform` value with no runner today.
    expect(registry.resolve("windows")).toBeUndefined();
  });

  it("lists the registered platforms", () => {
    const registry = createPlatformRunnerRegistry([stubRunner("linux"), stubRunner("windows")]);

    expect([...registry.platforms].sort()).toEqual(["linux", "windows"]);
    expect(registry.resolve("windows")).toBeDefined();
  });

  it("is empty when constructed with no runners", () => {
    const registry = createPlatformRunnerRegistry([]);

    expect(registry.platforms).toEqual([]);
    expect(registry.resolve("linux")).toBeUndefined();
  });

  it("throws on a duplicate platform registration (a wiring bug)", () => {
    expect(() => createPlatformRunnerRegistry([stubRunner("linux"), stubRunner("linux")])).toThrow(
      /duplicate transport runner.*linux/i,
    );
  });
});
