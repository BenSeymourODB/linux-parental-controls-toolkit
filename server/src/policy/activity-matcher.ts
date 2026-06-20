/**
 * The activity matcher grammar (#178, ADR 0006).
 *
 * An {@link Activity} pairs a `matcher` string with a `match_type` discriminator
 * that says how to interpret it against a telemetry identifier — the
 * ActivityWatch foreground `app` today, a web-request host once web-proxy
 * telemetry lands. This module is the **single, pure** implementation of that
 * grammar, shared by:
 *  - the AW normaliser (`transport/activitywatch/normalise.ts`), which resolves
 *    each window event's `app` to one activity, and
 *  - the `/api/*` activity DTOs, which reject an uncompilable `regex` at write
 *    time ({@link isValidMatcher}).
 *
 * It lives under `policy/` (not `transport/`) because "how a matcher is
 * interpreted" is a policy-model concept; the transport layer already depends on
 * `policy/enums`, so this keeps the dependency arrow pointing the same way.
 *
 * All matching is **case-insensitive** (ADR 0006). License boundary: none —
 * plain TypeScript, no GPL surface, no I/O.
 */
import type { MatchType } from "./enums.js";

/** Escape a string for safe literal inclusion in a `RegExp` source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a glob (`*` = any run, `?` = any one char; every other character
 * literal) into a whole-string, case-insensitive `RegExp`. Bounded by
 * construction — no alternation or backtracking surface (ADR 0006 §4).
 */
function compileGlob(glob: string): RegExp {
  const body = glob
    .split(/([*?])/)
    .map((part) => (part === "*" ? ".*" : part === "?" ? "." : escapeRegExp(part)))
    .join("");
  return new RegExp(`^${body}$`, "i");
}

/**
 * A compiled, case-insensitive predicate for one activity's matcher, tagged with
 * whether it is an `exact` match (which outranks any pattern — ADR 0006 §3) and
 * the owning activity id (the precedence tiebreak).
 */
export interface CompiledMatcher {
  readonly id: number;
  readonly isExact: boolean;
  readonly test: (candidate: string) => boolean;
}

/** The `(match_type, matcher)` fields the grammar needs, plus the row id. */
export interface MatchableActivity {
  readonly id: number;
  readonly matchType: MatchType;
  readonly matcher: string;
}

/**
 * Compile one `(matchType, matcher)` to a case-insensitive predicate, or `null`
 * if the matcher is unusable (a `regex` that does not compile). Callers treat
 * `null` as "never matches" — a stored pattern that somehow bypassed
 * write-time validation can never throw inside a telemetry pull.
 */
export function compileMatcher(
  matchType: MatchType,
  matcher: string,
): ((candidate: string) => boolean) | null {
  switch (matchType) {
    case "exact": {
      const needle = matcher.toLowerCase();
      return (candidate) => candidate.toLowerCase() === needle;
    }
    case "substring": {
      const needle = matcher.toLowerCase();
      return (candidate) => candidate.toLowerCase().includes(needle);
    }
    case "glob": {
      const re = compileGlob(matcher);
      return (candidate) => re.test(candidate);
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(matcher, "i");
      } catch {
        return null;
      }
      return (candidate) => re.test(candidate);
    }
  }
}

/**
 * Whether `(matchType, matcher)` is a usable matcher. Only `regex` can be
 * invalid (an uncompilable pattern); every other type always compiles. The API
 * uses this to reject a bad pattern with a 400 at write time.
 */
export function isValidMatcher(matchType: MatchType, matcher: string): boolean {
  return compileMatcher(matchType, matcher) !== null;
}

/**
 * Pre-compile a set of candidate activities into matchers ready to resolve many
 * identifiers against, **ascending by id** so the lowest-id tiebreak falls out
 * of iteration order. Activities whose `regex` does not compile are dropped (a
 * dropped matcher simply never matches).
 */
export function compileMatchers(activities: readonly MatchableActivity[]): CompiledMatcher[] {
  const compiled: CompiledMatcher[] = [];
  for (const activity of activities) {
    const test = compileMatcher(activity.matchType, activity.matcher);
    if (test === null) continue;
    compiled.push({ id: activity.id, isExact: activity.matchType === "exact", test });
  }
  return compiled.sort((a, b) => a.id - b.id);
}

/**
 * Resolve one identifier to the single winning activity id, or `undefined` if
 * nothing matches. Precedence (ADR 0006 §3): an `exact` match beats any pattern
 * match; within a tier the lowest activity id wins. `compiled` is assumed sorted
 * ascending by id (as {@link compileMatchers} returns), so the first hit in each
 * tier is the lowest-id one.
 */
export function resolveActivityId(
  compiled: readonly CompiledMatcher[],
  candidate: string,
): number | undefined {
  let firstPattern: number | undefined;
  for (const matcher of compiled) {
    if (!matcher.test(candidate)) continue;
    if (matcher.isExact) return matcher.id; // exact wins outright; lowest-id first
    if (firstPattern === undefined) firstPattern = matcher.id;
  }
  return firstPattern;
}
