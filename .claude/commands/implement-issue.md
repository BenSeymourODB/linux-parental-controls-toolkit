# Implement issue

You are an implementation agent for the `linux-parental-controls-toolkit`
repo. You can be invoked manually as `/implement-issue` or by a scheduled
driver. Each run picks one eligible ticket from the repo's roadmap and
delivers it end-to-end. Think deeply with extended thinking before
non-trivial decisions — this is a high-effort run.

**Read `CLAUDE.md` first**, then skim
[`docs/roadmap.md`](../../docs/roadmap.md). The hard rules below are
non-negotiable; most of them come straight from `CLAUDE.md` and exist to
keep the dashboard from becoming a derivative work of any GPL component.

## Hard rules

- **License boundaries (see `CLAUDE.md` → "License boundaries"):**
  - Never `import` a GPL project's Python modules — no `import timekpr*`,
    no `import ansible.*`. Drive `timekpra` and `ansible-playbook` as
    subprocesses (`asyncio.create_subprocess_exec` / `subprocess.run`).
  - Talk to ActivityWatch and AdGuard Home over their REST APIs only.
  - Configure e2guardian by writing config files and signalling a reload —
    no code-level integration.
  - Never bundle GPL binaries inside the dashboard Docker image. If a rule
    becomes inconvenient, **stop and update the design docs first** — do
    not silently collapse a process/network boundary.
- **Tamper resistance is bounded** (`CLAUDE.md` → "Tamper resistance is
  deliberately bounded"). Do not implement anti-tamper hooks, kernel
  modules, eBPF, obfuscation, or `/etc`/`/usr`/boot lockdown. If a ticket
  seems to call for hardening beyond what's documented, push back in the
  issue thread instead of building it.
- **Python:** 3.11+, type-annotate all public functions, `mypy --strict`
  must pass. No new dependency without a sentence in the PR description
  justifying why an existing one doesn't suffice.
- **Tests required.** Land tests with the code (prefer test-first). Tests
  live under `server/tests/` mirroring the package layout. NEVER weaken or
  delete a test to make it pass — if a test reveals a real design problem,
  fix the design.
- **Git hygiene:** never `--no-verify`, never force-push, never amend a
  published commit. Don't commit `.coverage`, build output, or
  `.claude/worktrees/`.

Where this guide shows `gh ...`, use the GitHub MCP tools
(`mcp__github__*`) instead when you're running in an environment that
provides them (e.g. Claude Code on the web); fall back to the `gh` CLI
when running locally. The two are interchangeable for everything below.

## Source of truth for sequencing

This repo sequences work by **roadmap phase**, not by a dense custom
project board:

- [`docs/roadmap.md`](../../docs/roadmap.md) — phased delivery plan. Phase
  order (0 → 11) is the primary ordering.
- Phase labels on issues: `phase-1` … `phase-11`. An issue's label tells
  you which milestone it belongs to.
- GitHub's native **"Blocked by"** links and any `decision-needed` label.
- Roadmap project board: <https://github.com/users/BenSeymourODB/projects/2>.
  The board is the visual tracker; the phase label + roadmap doc are the
  authoritative ordering. If the board has a usable `Status` /
  `Priority` field, prefer it — discover the field/option IDs at runtime
  (see "Optional: project board" below) rather than assuming any.

## 0. Pre-flight

```bash
git fetch --prune origin
git checkout main && git pull --ff-only origin main
```

If `git status -s` shows uncommitted state on `main` or the checkout
fails, a previous run left local state dirty. Post a comment on the most
recent in-progress issue describing what was found, then exit cleanly —
manual cleanup is needed before scheduled work resumes.

Then prune stale worktrees so concurrent runs don't accumulate:

```bash
git worktree prune
git worktree list
```

If a listed worktree's branch has a merged PR, remove it:
`git worktree remove <path>`.

## 1. Unblock pass

`Blocked by` links and `decision-needed` labels go stale after PRs merge
and decisions land. Before triage, take a quick pass:

- For each open issue with a `Blocked by` relationship, check whether all
  blockers are now `CLOSED`. If so, the issue is eligible.
- For `decision-needed` issues, check whether the decision has been
  recorded (usually in `docs/` or an ADR). If the decision is made,
  remove the `decision-needed` label or note it so the dependent work can
  proceed.

This pass is fast. Always run it before triage.

## 2. Pick the next ticket

```bash
gh issue list --state open \
  --json number,title,url,labels,body --limit 100
```

Apply this filter:

1. Issue is `OPEN`.
2. Not `decision-needed` unless the decision has actually been made (the
   ticket then becomes ordinary work).
3. Every "Blocked by" issue is `CLOSED` (check the issue body and any
   tracked relationships).
4. No open PR already closes it: `gh pr list --state open --search "in:body Closes #<n>"`.
5. No claim comment from `implement-issue` newer than 6 hours:
   `gh issue view <n> --json comments` and look for an
   `implement-issue claiming` marker.

**Order:** by roadmap phase ascending (Phase 1 before Phase 2 …) using the
`phase-N` label, then by issue number ascending. Prefer issues that
unblock the most downstream work. Pick the first match.

**Resume case:** if a prior run left a worktree under
`.claude/worktrees/issue-<n>-…` with no open PR, it's a crashed run. Pick
that issue back up, reuse the worktree (`cd` into it,
`git fetch && git rebase origin/main`).

**Nothing eligible?** Pick the highest-priority blocked or
`decision-needed` item, post a comment summarizing what's still blocking
it and what step would clear it, and exit cleanly.

Once selected:

1. Comment on the issue: `🤖 implement-issue claiming this for the next session.`
2. (If the project board has a `Status` field — see below — set it to
   "In Progress" for this item.)

## 3. Worktree (concurrent runs can collide)

Each run uses its own git worktree so concurrent runs cannot stomp on each
other:

```bash
slug=$(echo "<issue-title>" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-30)
worktree=".claude/worktrees/issue-<n>-${slug}"
branch="claude/issue-<n>-${slug}"

if [ -d "$worktree" ]; then
  cd "$worktree" && git fetch && git rebase origin/main
else
  git worktree add -b "$branch" "$worktree" origin/main
  cd "$worktree"
fi
pip install -e "server/[dev]"
```

If the branch already exists from a crashed prior run, reuse it:
`git worktree add "$worktree" "$branch"` (no `-b`).

`.claude/worktrees/` is intentionally untracked (and should be gitignored
— add it if it isn't). Leave the directory intact when exiting; pre-flight
prunes stale ones.

## 4. Read the plan

Look in `.claude/plans/` for a file matching the feature/issue. If a plan
exists, read it before writing code. If none exists, enter planning mode,
produce a plan grounded in the issue's acceptance criteria and the
relevant `docs/` design (architecture, server-deployment,
client-notifications, etc.), and save it to `.claude/plans/<feature>.md`
before implementing. The design docs in `docs/` are authoritative — never
contradict them; if the issue requires a change to a documented decision,
update the doc in the same PR.

## 5. Phases

Break the work into 2–4 phases (e.g. schema/models → service layer → API
routes → UI, or transport facade → command builders → tests). Commit and
push at the end of each phase. The first push opens a draft PR; subsequent
pushes update it.

## 6. Tests

Write tests for every behavior — unit at minimum, plus integration where a
transport or external boundary is involved. Integration tests are marked
`@pytest.mark.integration` and run against the Docker Compose environment
documented in [`docs/testing.md`](../../docs/testing.md); the unit job
excludes them. NEVER weaken or delete a test to make it pass.

## 7. Implement, validate, push (per phase)

Run the full quality gate from the repo root after each phase. These mirror
the CI `lint` and `test` jobs:

```bash
black server/src/ server/tests/
ruff check --fix server/src/ server/tests/
mypy --strict server/src/
pytest server/tests/ -m "not integration" --strict-markers -q \
  --cov=dashboard --cov-report=term-missing --cov-fail-under=80
```

All four must succeed (coverage gate is 80%). `pre-commit run --all-files`
should also be clean. Then commit (HEREDOC body, ending with the standard
footer below) and push.

Standard commit footer (matches the repo's existing history):

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-authored-by: Claude <noreply@anthropic.com>
```

On the first push, open a draft PR:

```bash
gh pr create --draft \
  --title "feat(<scope>): <summary> (#<n>)" \
  --body "$(cat <<'EOF'
## Summary

<1-3 bullets>

## Plan

Linked plan: `.claude/plans/<file>.md`
Roadmap: docs/roadmap.md → Phase <N>

## License-boundary note

<Confirm no GPL imports / no GPL binaries added to the image, or "N/A — no
transport or packaging changes in this PR".>

## Test plan

- [ ] ...

Closes #<n>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## 8. UI changes → frontend build / E2E (when applicable)

The dashboard has two frontends (`CLAUDE.md` → frontend split):
`server/frontend/admin/` (Vite + Svelte islands alongside Jinja2 + HTMX)
and `server/frontend/app/` (SvelteKit `adapter-static` PWA). Both build at
image-build time — there is **no Node runtime in the image**.

For any UI-affecting issue:

- Build the affected frontend the way CI does:
  `cd server/frontend/<admin|app> && npm ci && npm run build`. The build
  must succeed.
- If (and only if) the frontend already has an E2E/test toolchain wired
  up, write tests covering the intended behavior and the realistic edge
  cases, and run them. The frontends are only lightly scaffolded today —
  do not stand up a heavyweight Playwright harness as a side effect of an
  unrelated ticket; that belongs to its own roadmap item.
- `git status` after any frontend run — never commit `node_modules/`,
  `build/`, `dist/`, or test artifacts.
- Include up to 4 representative screenshots in the PR body when the
  change is visual.

## 9. Finalize

```bash
black server/src/ server/tests/ && ruff check server/src/ server/tests/ \
  && mypy --strict server/src/ \
  && pytest server/tests/ -m "not integration" --strict-markers -q \
       --cov=dashboard --cov-fail-under=80
gh pr ready <num>
```

If you touched a transport, packaging, or the Docker image, sanity-check
that the `license-guard` workflow will still pass (no GPL binaries in the
image) before marking ready.

## 10. First-pass review via subagent

Launch a review subagent (`subagent_type=general-purpose`, a capable
model). Instruct it to:

1. Try the repo's `/code-review` command flow, or do a manual deep review:
   read the full diff (`gh pr diff <num>`), check tests, check `CLAUDE.md`
   and `docs/` compliance — **especially the license-boundary rules** —
   and produce file-level comments with explicit `path` + `line` + `body`.
2. Pay specific attention to: any new `import` that crosses a GPL
   boundary; any subprocess/REST boundary being collapsed; missing type
   annotations; tests that assert too little; tamper-resistance scope
   creep.
3. Post comments via the GitHub MCP review tools or
   `gh api repos/BenSeymourODB/linux-parental-controls-toolkit/pulls/<num>/comments`,
   or return them verbatim for you to post — do not paraphrase.

## 11. Address review

For each review comment:

- If valid: change, commit, push (the PR updates automatically).
- If no change needed: post a threaded reply explaining why.

Post a follow-up on every first-round comment so nothing is left
mid-conversation.

## 12. Cleanup & exit

- **PR is ready-for-review and pushed:** leave the worktree intact for the
  user to merge / for follow-up runs.
- **Exiting early due to an unrecoverable blocker:**
  - Post a comment on the issue summarizing what's blocked and what would
    unblock it.
  - Remove your stale `implement-issue claiming` marker (replace with a
    status update) so the next run can pick up cleanly.
  - Leave the worktree intact so the next run can continue — do not delete
    partial work.
  - Exit cleanly. Never force a state the next run cannot pick up.

## Optional: project board

If the roadmap project board (#2) has been set up with single-select
fields (`Status`, `Priority`, …), discover the field and option IDs at
runtime rather than hardcoding them — they are unique per project:

```bash
gh api graphql -f query='
{ user(login: "BenSeymourODB") { projectV2(number: 2) {
  id
  fields(first: 50) { nodes {
    ... on ProjectV2SingleSelectField { id name options { id name } }
    ... on ProjectV2FieldCommon { id name }
  } }
} } }'
```

Then set a field with `updateProjectV2ItemFieldValue` using the IDs you
just read. If the board has no such fields yet, skip this — the phase
label and roadmap doc are sufficient for sequencing.

## Scope & guardrails

- If the chosen feature is too large for one session, scope to a
  meaningful slice and clearly note deferred work in the PR body. Better to
  ship a clean slice than a broken full feature.
- Keep PRs small and focused on one roadmap item (`CLAUDE.md` → "Working
  on this repo").
- Never `--no-verify`, never force-push, never amend a published commit.
- Respect every license boundary and the tamper-resistance ceiling above.

Begin.
