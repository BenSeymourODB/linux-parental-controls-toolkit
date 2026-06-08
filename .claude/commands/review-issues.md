# Review issues

Do a review of all open Issues on this repository. Identify blockers,
co-dependencies, and synergies between the issues: which issues must be
addressed first to let development on others proceed? Which issues aren't
explicitly blocked but would become easier if others were developed and
merged first? For each connection you identify, update the description of
both issues tagging the connected issue.

This repo is sequenced by roadmap phase ([`docs/roadmap.md`](../../docs/roadmap.md)),
so anchor your analysis to the phases — but surface the finer-grained
dependencies *within* and *across* phases that the phase labels alone
don't capture.

Where this guide shows `gh ...`, use the GitHub MCP tools
(`mcp__github__*`) instead when your environment provides them; fall back
to the `gh` CLI when running locally.

## Instructions

1. **Read `CLAUDE.md` and `docs/roadmap.md`** so your dependency reasoning
   respects the intended architecture (e.g. the Settings loader and
   logging config underpin the transports; the policy schema underpins the
   API and UI; the event stream underpins the client notification work).

2. **Fetch all open issues** using
   `gh issue list --state open --json number,title,labels,body --limit 100`.

3. **Analyze dependencies** across all issues. For each issue, identify:
   - **Blockers**: issues that must be completed before this one can start
     (e.g. the SQLite schema must exist before the JSON API can serve it;
     the Settings loader must exist before transport config).
   - **Enables**: issues this one unblocks once completed.
   - **Synergies**: issues that share infrastructure, patterns, or a
     design surface and benefit from coordinated development (e.g. all the
     transport facades share the subprocess/REST boundary discipline; the
     admin UI and PWA share the `/api/*` contract).
   - **Benefits from**: issues that aren't strict blockers but would make
     this one easier if done first.
   - **Decision dependencies**: issues blocked on a `decision-needed`
     ticket (e.g. the budget-timezone decision gates the policy schema).

4. **Group into tiers** based on dependency depth:
   - **Tier 0 (Foundation)**: no blockers, enables many others.
   - **Tier 1**: depends only on Tier 0 or external factors.
   - **Tier 2**: depends on Tier 1 issues.
   - **Tier 3+**: highest dependency chains.
   Cross-reference the tiers against the roadmap phases and call out any
   place where an issue's phase label and its real dependency depth
   disagree.

5. **Identify synergy clusters**: groups of issues that share enough
   infrastructure (or the same license boundary, the same transport, the
   same UI surface) that they should be designed together even if
   developed separately.

6. **Write two documentation files**:
   - `docs/issue-dependency-analysis.md` — full dependency graph with
     tiers, a per-issue connection map, recommended implementation order,
     and key synergy clusters. Cross-link to the relevant roadmap phase.
   - `docs/issue-cross-reference-updates.md` — the exact markdown text to
     append to each affected issue's description.

7. **Update each affected issue** on GitHub:
   - Append a "Cross-References" section to its description.
   - Preserve the existing body and append the new section.
   - Use `gh issue view <number> --json body -q .body` to read existing
     content, then `gh issue edit <number> --body "<existing + new>"` to
     update (or the equivalent GitHub MCP calls).
   - The cross-reference section should tag connected issues and explain
     the nature of each connection.

8. **Report a summary** of all updates made.

## Notes

- This is primarily an **analysis + bookkeeping** task. Do not change any
  source code or design docs other than the two analysis files above.
- Be conservative about declaring hard blockers — reserve "blocked by" for
  genuine ordering constraints, and use "benefits from" for soft ones.
- If you spot a dependency that contradicts the roadmap's phase ordering,
  flag it in `docs/issue-dependency-analysis.md` rather than silently
  re-sequencing — the roadmap is a human-owned document.
