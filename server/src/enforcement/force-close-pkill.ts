/**
 * Build the argv for the per-activity **`pkill` fallback** (#99, Phase 8).
 *
 * When the supervised user's `pct-client-bridge` isn't reachable on the event
 * stream, the dashboard can't ask the agent to close an over-budget app, so it
 * falls back to an ad-hoc `pkill` over the Phase-4 SSH facade
 * (`docs/roadmap.md` → Phase 8: "Falls back to an SSH ad-hoc `pkill` if the
 * agent isn't reachable"). This module is the **pure** argv builder for that
 * command; running it (and auditing the result) is `./force-close-deps.ts`.
 *
 * **Always user-scoped.** Every vector starts `pkill -u <osUserRef>` so a
 * matcher can only ever reach the supervised account's own processes — never
 * another user's and never root's. The blast radius is bounded by the `-u`
 * filter regardless of how loose the pattern is.
 *
 * **Matcher → `pkill` mapping** (`matchType`, ADR 0006). `pkill` patterns are
 * POSIX extended regular expressions:
 * - `exact`     → `-x <ere>`  — the *whole* process name must equal the matcher.
 * - `substring` → `-f <ere>`  — the matcher appears anywhere in the command line.
 * - `glob`      → `-f <ere>`  — `*`/`?` translated to `.*`/`.`, matched on cmdline.
 * - `regex`     → `-f <matcher>` — the matcher is already an ERE; passed verbatim.
 *
 * Shell-safety is the SSH facade's `shellQuoteCommand`; the escaping here is
 * purely about ERE *matching* semantics, not quoting. A matcher that reduces to
 * an empty pattern is rejected (it would match nothing useful and risks an
 * over-broad `-f ''`), surfaced as `undefined` for the caller to skip + log.
 *
 * **The fallback is intentionally looser than the canonical matcher.** This is
 * a best-effort, agent-unavailable path. It diverges from the telemetry matcher
 * (`policy/activity-matcher.ts`) in two known ways, both bounded by the `-u`
 * user scope so the blast radius is only the supervised account's processes:
 * - *Glob/substring are unanchored over the full command line* (`-f`), whereas
 *   the canonical glob is whole-string-anchored against the app name. `chrome`
 *   here matches `chrome` anywhere in a process's cmdline, a strictly broader
 *   kill than the budget counted against. Anchoring (`^…$`) is wrong for a
 *   full cmdline (it would never match a real argv), so the fallback accepts the
 *   looseness rather than miss the target.
 * - *Matching is case-sensitive*, whereas ADR 0006 telemetry matching is
 *   case-insensitive (`pkill` has no portable `-i`). A differently-cased
 *   process name may slip the fallback; the preferred event-stream path (the
 *   agent, which honours the canonical matcher) is unaffected.
 *
 * License boundary: none touched — pure TypeScript producing an argv the SSH
 * facade execs as a subprocess (same boundary as the `timekpra` invocations).
 */
import type { MatchType } from "../policy/enums.js";

/** ERE metacharacters escaped to match literally. */
const ERE_METACHARS = /[.^$*+?()[\]{}|\\]/g;

/** Escape a string so it matches literally inside a POSIX ERE. */
function escapeEre(literal: string): string {
  return literal.replace(ERE_METACHARS, "\\$&");
}

/**
 * Translate a shell-style glob to an ERE: `*` → `.*`, `?` → `.`, every other
 * character escaped to its literal. Deliberately **unanchored** so it matches
 * anywhere in the `-f` command-line string — see the module doc for why this
 * fallback is looser than the canonical whole-string glob matcher.
 */
function globToEre(glob: string): string {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += escapeEre(ch);
  }
  return out;
}

/**
 * Build the `pkill` argv for one over-budget activity on one client, scoped to
 * the supervised account `osUserRef`. Returns `undefined` when the matcher
 * yields an empty pattern (nothing safe to run) so the caller skips it.
 */
export function buildPkillArgv(
  osUserRef: string,
  matcher: string,
  matchType: MatchType,
): string[] | undefined {
  // A non-empty matcher always escapes/translates to a non-empty pattern, so
  // the only empty-pattern case to guard is the empty matcher itself.
  if (matcher.length === 0) return undefined;

  const base = ["pkill", "-u", osUserRef];
  switch (matchType) {
    case "exact":
      return [...base, "-x", escapeEre(matcher)];
    case "substring":
      return [...base, "-f", escapeEre(matcher)];
    case "glob":
      return [...base, "-f", globToEre(matcher)];
    case "regex":
      return [...base, "-f", matcher];
  }
}
