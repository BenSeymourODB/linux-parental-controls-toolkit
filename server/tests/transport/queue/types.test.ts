/**
 * Unit tests for the offline-queue's retriability/error helpers (#84). These
 * classify what an injected {@link ActionExecutor} throws without importing the
 * `transport/ssh` error classes, so they're pinned independently here.
 */
import { describe, expect, it } from "vitest";

import {
  SshCommandError,
  SshParseError,
  SshUnreachableError,
  SshExecTimeoutError,
} from "../../../src/transport/ssh/errors.js";
import { errorMessage, isRetriable } from "../../../src/transport/queue/types.js";

const target = { host: "mint-01", port: 22, username: "pct-agent" } as const;

describe("isRetriable", () => {
  it("is true for the SSH retriable errors (unreachable, timeout)", () => {
    expect(isRetriable(new SshUnreachableError(target))).toBe(true);
    expect(isRetriable(new SshExecTimeoutError(target, ["timekpra"], 30_000))).toBe(true);
  });

  it("is false for the SSH non-retriable errors (command failed, parse)", () => {
    const cmdErr = new SshCommandError(target, ["timekpra"], {
      code: 1,
      signal: null,
      stdout: "",
      stderr: "boom",
    });
    expect(isRetriable(cmdErr)).toBe(false);
    expect(isRetriable(new SshParseError(target, ["timekpra"], "garbage"))).toBe(false);
  });

  it("treats an unclassifiable rejection as non-retriable", () => {
    expect(isRetriable(new Error("plain"))).toBe(false);
    expect(isRetriable("a string")).toBe(false);
    expect(isRetriable(null)).toBe(false);
    expect(isRetriable({ retriable: "yes" })).toBe(false); // only a true boolean counts
    expect(isRetriable({ retriable: true })).toBe(true);
  });
});

describe("errorMessage", () => {
  it("uses Error.message and stringifies anything else", () => {
    expect(errorMessage(new Error("host unreachable"))).toBe("host unreachable");
    expect(errorMessage("raw string")).toBe("raw string");
    expect(errorMessage(42)).toBe("42");
  });
});
