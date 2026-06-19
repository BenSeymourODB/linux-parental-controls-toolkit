/**
 * Unit tests for the activity matcher grammar (#178, ADR 0006): the pure
 * predicate compilation + precedence resolution shared by the AW normaliser and
 * the `/api/*` activity DTOs.
 */
import { describe, expect, it } from "vitest";

import {
  compileMatcher,
  compileMatchers,
  isValidMatcher,
  resolveActivityId,
  type MatchableActivity,
} from "../../src/policy/activity-matcher.js";

describe("compileMatcher", () => {
  describe("exact (case-insensitive equality)", () => {
    const test = compileMatcher("exact", "Firefox");
    it("matches the same string regardless of case", () => {
      expect(test?.("firefox")).toBe(true);
      expect(test?.("FIREFOX")).toBe(true);
      expect(test?.("Firefox")).toBe(true);
    });
    it("does not match a substring or a different string", () => {
      expect(test?.("firefox-esr")).toBe(false);
      expect(test?.("fire")).toBe(false);
      expect(test?.("chrome")).toBe(false);
    });
  });

  describe("substring (case-insensitive containment)", () => {
    const test = compileMatcher("substring", "fox");
    it("matches anywhere in the identifier, any case", () => {
      expect(test?.("firefox")).toBe(true);
      expect(test?.("FireFOX-esr")).toBe(true);
      expect(test?.("fox")).toBe(true);
    });
    it("does not match when absent", () => {
      expect(test?.("chrome")).toBe(false);
    });
  });

  describe("glob (whole-string, * and ? only)", () => {
    it("treats * as any run and ? as one char, anchored", () => {
      const star = compileMatcher("glob", "jetbrains*");
      expect(star?.("jetbrains-idea")).toBe(true);
      expect(star?.("jetbrains")).toBe(true);
      expect(star?.("my-jetbrains")).toBe(false); // anchored at the start

      const q = compileMatcher("glob", "log?");
      expect(q?.("log1")).toBe(true);
      expect(q?.("log")).toBe(false); // ? requires exactly one char
      expect(q?.("log12")).toBe(false);
    });
    it("is case-insensitive", () => {
      const test = compileMatcher("glob", "Fire*");
      expect(test?.("firefox")).toBe(true);
    });
    it("escapes regex metacharacters in the literal portion", () => {
      // A '.' is a literal dot, not 'any char'; '+' is literal too.
      const test = compileMatcher("glob", "a.b+*");
      expect(test?.("a.b+c")).toBe(true);
      expect(test?.("axbxc")).toBe(false);
    });
  });

  describe("regex (unanchored, case-insensitive)", () => {
    it("matches a valid pattern unanchored", () => {
      const test = compileMatcher("regex", "(chrome|chromium)");
      expect(test?.("google-chrome")).toBe(true);
      expect(test?.("chromium-browser")).toBe(true);
      expect(test?.("firefox")).toBe(false);
    });
    it("is case-insensitive", () => {
      expect(compileMatcher("regex", "fire")?.("FIREFOX")).toBe(true);
    });
    it("returns null for an uncompilable pattern", () => {
      expect(compileMatcher("regex", "([unterminated")).toBeNull();
    });
  });
});

describe("isValidMatcher", () => {
  it("accepts every non-regex type unconditionally", () => {
    expect(isValidMatcher("exact", "(")).toBe(true);
    expect(isValidMatcher("substring", "[")).toBe(true);
    expect(isValidMatcher("glob", "[unterminated")).toBe(true);
  });
  it("accepts a regex that compiles and rejects one that does not", () => {
    expect(isValidMatcher("regex", "(chrome|chromium)")).toBe(true);
    expect(isValidMatcher("regex", "([unterminated")).toBe(false);
  });
});

describe("compileMatchers", () => {
  it("drops domain-agnostic invalid regex rows and sorts ascending by id", () => {
    const activities: MatchableActivity[] = [
      { id: 9, matchType: "exact", matcher: "code" },
      { id: 3, matchType: "regex", matcher: "([bad" }, // dropped
      { id: 5, matchType: "glob", matcher: "fire*" },
    ];
    const compiled = compileMatchers(activities);
    expect(compiled.map((c) => c.id)).toEqual([5, 9]); // 3 dropped, sorted
  });

  it("flags exact matchers as isExact", () => {
    const compiled = compileMatchers([
      { id: 1, matchType: "exact", matcher: "a" },
      { id: 2, matchType: "substring", matcher: "b" },
    ]);
    expect(compiled.find((c) => c.id === 1)?.isExact).toBe(true);
    expect(compiled.find((c) => c.id === 2)?.isExact).toBe(false);
  });
});

describe("resolveActivityId precedence (ADR 0006 §3)", () => {
  it("returns undefined when nothing matches", () => {
    const compiled = compileMatchers([{ id: 1, matchType: "exact", matcher: "code" }]);
    expect(resolveActivityId(compiled, "firefox")).toBeUndefined();
  });

  it("prefers an exact match over any pattern match, even a lower-id pattern", () => {
    const compiled = compileMatchers([
      { id: 1, matchType: "substring", matcher: "fire" }, // pattern, lower id
      { id: 2, matchType: "exact", matcher: "firefox" }, // exact, higher id
    ]);
    expect(resolveActivityId(compiled, "firefox")).toBe(2);
  });

  it("breaks an exact-vs-exact tie by lowest id", () => {
    const compiled = compileMatchers([
      { id: 8, matchType: "exact", matcher: "Firefox" },
      { id: 4, matchType: "exact", matcher: "firefox" },
    ]);
    expect(resolveActivityId(compiled, "firefox")).toBe(4);
  });

  it("breaks a pattern-vs-pattern tie by lowest id", () => {
    const compiled = compileMatchers([
      { id: 7, matchType: "glob", matcher: "fire*" },
      { id: 3, matchType: "substring", matcher: "fox" },
    ]);
    expect(resolveActivityId(compiled, "firefox")).toBe(3);
  });

  it("falls back to a pattern when no exact matcher matches", () => {
    const compiled = compileMatchers([
      { id: 1, matchType: "exact", matcher: "chrome" }, // no match
      { id: 2, matchType: "regex", matcher: "fire" }, // matches
    ]);
    expect(resolveActivityId(compiled, "firefox")).toBe(2);
  });
});
