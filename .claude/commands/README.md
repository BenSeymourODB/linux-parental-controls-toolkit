# Claude Code commands

Slash commands for working on this repository, invoked as `/<name>` from
Claude Code. They were adapted from the workflow commands in the
sibling [`next-digital-wall-calendar`](https://github.com/BenSeymourODB/next-digital-wall-calendar)
repo and rewritten for this project's stack (TypeScript / Fastify / SQLite,
a roadmap-phase workflow, and the strict license boundaries described in
`CLAUDE.md`).

All of them read `CLAUDE.md` first and respect its non-negotiables: no
in-process GPL linkage, subprocess/REST isolation for GPL tools, no GPL
binaries in the image, strict TypeScript (`tsc --noEmit`), and the
deliberately bounded tamper-resistance posture.

## Available commands

| Command | What it does |
| ------- | ------------ |
| `/implement-issue` | Picks one eligible roadmap ticket and delivers it end-to-end: branch + worktree, plan, tests, the Prettier/ESLint/tsc/Vitest gate, a draft PR, a self-review pass, and review follow-up. |
| `/review-issues` | Analyzes all open issues for blockers, enablers, and synergies; writes `docs/issue-dependency-analysis.md` + `docs/issue-cross-reference-updates.md` and appends cross-reference sections to the issues. |
| `/code-review` | Orchestrates a read-only cleanliness review: spawns the five `code-review-*` agents in parallel, dedupes findings, and files `code-review`-labelled GitHub issues. |
| `/code-review-fix` | Reads open `code-review` issues, prioritizes them, and executes fixes one at a time through the quality gate, closing each when green. |
| `/update-screenshots` | Regenerates `docs/screenshots/` and the README product shots from the current dashboard UI, via `scripts/screenshots/` (a throwaway, seeded instance + headless Chromium, all in Docker). Run after a significant UI change. |
| `code-review-complexity` / `code-review-concerns` / `code-review-dead-code` / `code-review-readability` / `code-review-patterns` | Specialized review agents invoked by `/code-review`. Each emits findings in a fixed `FINDING:` format. Not meant to be run directly, though they can be. |

## Conventions these commands assume

- **Tooling:** `cd server && npm ci`, then the gate
  `npm run format && npm run lint && npm run typecheck && npm test`
  (Prettier, ESLint, `tsc --noEmit`, then Vitest unit tests — excludes
  `*.int.test.ts` — with coverage gated at 80%; mirrors CI).
- **GitHub:** use the GitHub MCP tools (`mcp__github__*`) when running in an
  environment that provides them (e.g. Claude Code on the web); fall back to
  the `gh` CLI locally. The commands are written to work either way.
- **Sequencing:** roadmap phase (`docs/roadmap.md`) + `phase-N` issue labels
  + GitHub "Blocked by" links are the source of truth. The
  [roadmap project board](https://github.com/users/BenSeymourODB/projects/2)
  is the visual tracker; `/implement-issue` discovers any project field IDs
  at runtime rather than hardcoding them.
- **Plans:** `/implement-issue` looks for a matching plan in `.claude/plans/`
  and writes one there if none exists before implementing.
- **Worktrees:** `/implement-issue` runs each ticket in its own
  `.claude/worktrees/issue-<n>-<slug>` worktree (gitignored).

## Deliberately not ported

The calendar repo also ships `browser-qa` and `review-with-video` commands.
Both are tightly coupled to a built SvelteKit/React UI driven through a
Playwright harness. This project's frontend (`server/frontend/`, a single
SvelteKit project serving both the `/admin` and `/app` surfaces) is only
lightly scaffolded and has no E2E toolchain yet, so those commands would be
speculative here. When the frontend and its Playwright setup land (see
`docs/roadmap.md` Phase 9), porting them is worthwhile — until then
`/implement-issue` step 8 covers the build-the-frontend checks that do
apply today.
