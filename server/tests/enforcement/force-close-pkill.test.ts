/**
 * Tests for the pure `pkill` argv builder (#99). Asserts the user-scoping
 * invariant, the per-`matchType` flag/pattern mapping, ERE-escaping of literal
 * matchers, glob→ERE translation, and the empty-pattern guard.
 */
import { describe, expect, it } from "vitest";

import { buildPkillArgv } from "../../src/enforcement/force-close-pkill.js";

describe("buildPkillArgv", () => {
  it("always scopes to the supervised account with -u", () => {
    for (const argv of [
      buildPkillArgv("1001", "firefox", "exact"),
      buildPkillArgv("1001", "chrome", "substring"),
      buildPkillArgv("1001", "*game*", "glob"),
      buildPkillArgv("1001", "node.*", "regex"),
    ]) {
      expect(argv?.slice(0, 3)).toEqual(["pkill", "-u", "1001"]);
    }
  });

  it("exact → -x with the whole name, ERE-escaped", () => {
    expect(buildPkillArgv("1001", "firefox", "exact")).toEqual([
      "pkill",
      "-u",
      "1001",
      "-x",
      "firefox",
    ]);
    // Dots in an exact app name must be matched literally, not as ERE `.`.
    expect(buildPkillArgv("1001", "org.gnome.Foo", "exact")).toEqual([
      "pkill",
      "-u",
      "1001",
      "-x",
      "org\\.gnome\\.Foo",
    ]);
  });

  it("substring → -f over the command line, ERE-escaped", () => {
    expect(buildPkillArgv("42", "steam", "substring")).toEqual([
      "pkill",
      "-u",
      "42",
      "-f",
      "steam",
    ]);
    expect(buildPkillArgv("42", "a+b", "substring")).toEqual(["pkill", "-u", "42", "-f", "a\\+b"]);
  });

  it("glob → -f with * and ? translated and other metachars escaped", () => {
    expect(buildPkillArgv("7", "*minecraft*", "glob")).toEqual([
      "pkill",
      "-u",
      "7",
      "-f",
      ".*minecraft.*",
    ]);
    expect(buildPkillArgv("7", "game?.bin", "glob")).toEqual([
      "pkill",
      "-u",
      "7",
      "-f",
      "game.\\.bin",
    ]);
  });

  it("regex → -f with the matcher passed through verbatim", () => {
    expect(buildPkillArgv("7", "^(chrome|chromium)$", "regex")).toEqual([
      "pkill",
      "-u",
      "7",
      "-f",
      "^(chrome|chromium)$",
    ]);
  });

  it("rejects an empty matcher (nothing safe to run)", () => {
    expect(buildPkillArgv("1001", "", "exact")).toBeUndefined();
    expect(buildPkillArgv("1001", "", "regex")).toBeUndefined();
  });
});
