# Code cleanliness review

You are the **orchestrator** for a code cleanliness review of this
repository (the Fastify dashboard under `server/`, plus the lightly
scaffolded SvelteKit frontend). You coordinate specialized review agents,
deduplicate findings, and create GitHub Issues for actionable items.

**Read `CLAUDE.md` first.** Several findings categories below are specific
to this project's rules — the license boundaries (no in-process GPL
linkage; subprocess/REST isolation), the dashboard module split, strict
TypeScript (`tsc --noEmit`), and the bounded tamper-resistance posture.

Where this guide shows `gh ...`, use the GitHub MCP tools (`mcp__github__*`)
instead when your environment provides them; fall back to the `gh` CLI when
running locally.

## Step 1: Baseline checks

Run these first and note any pre-existing failures (they are separate from
the cleanliness findings, but worth recording):

```bash
cd server
npm run format:check
npm run lint
npm run typecheck
```

If any fail, note the failures but continue with the review.

## Step 2: Spawn review agents

Launch **all 5 agents in parallel** using the Agent tool. Each should be an
`Explore`-type agent. Give each agent the full contents of its corresponding
command file as the prompt:

1. **Complexity & CRAP** — read `.claude/commands/code-review-complexity.md`
   and use its contents as the agent prompt.
2. **Separation of concerns & license boundaries** — read
   `.claude/commands/code-review-concerns.md` and use its contents as the
   agent prompt.
3. **Dead code & unused exports** — read
   `.claude/commands/code-review-dead-code.md` and use its contents as the
   agent prompt.
4. **Naming & readability** — read
   `.claude/commands/code-review-readability.md` and use its contents as
   the agent prompt.
5. **Pattern consistency** — read
   `.claude/commands/code-review-patterns.md` and use its contents as the
   agent prompt.

Wait for all agents to complete.

## Step 3: Collect and deduplicate findings

Parse all agent results. Each finding follows this format:

```
FINDING: {severity} | {file_path}:{line_range} | {category}
DESCRIPTION: {what the issue is}
SUGGESTION: {specific refactoring recommendation}
EFFORT: {S|M|L}
```

Deduplicate:

- If multiple agents flag the same file+line range, merge into one finding,
  keeping the highest severity.
- If agents flag different issues in the same file, keep them separate but
  note they can be addressed together.

**Always escalate any finding that touches a license boundary** (in-process
GPL linkage, a collapsed subprocess/REST boundary, a GPL binary heading into
the image) to at least High, regardless of which agent raised it — these are
architectural invariants, not style.

## Step 4: Create GitHub Issues

For each finding (or group of related findings for the same file), create a
GitHub Issue.

First, check for existing open issues with the `code-review` label to avoid
duplicates (`mcp__github__search_issues`, or
`gh issue list --label code-review --state open`). If an existing issue
covers the same file and concern, comment on it instead of creating a new
one.

**Issue format:**

```
Title: [Code Review] {brief description} - {relative file path}

Labels: code-review, {severity}, {category}

Body:
## Finding
**File:** `{file_path}:{line_range}`
**Category:** {category}
**Severity:** {severity}
**Effort:** {effort}

## Issue
{description}

## Suggestion
{suggestion}

## Context
Found during automated code review on {today's date}.
```

**Label mapping:**

- Severity labels: `critical`, `high`, `medium`, `low`
- Category labels: `complexity`, `separation-of-concerns`, `dead-code`,
  `readability`, `pattern-consistency`, `license-boundary`
- All issues get the `code-review` label.

If labels don't exist yet, create them first.

## Step 5: Summary report

Present a summary to the user:

### Code Review Summary - {date}

| Severity | Count |
| -------- | ----- |
| Critical | N     |
| High     | N     |
| Medium   | N     |
| Low      | N     |

**Top 5 actionable items** (ranked by severity, then by effort ascending):

1. {finding summary} - {issue link} - Effort: {S/M/L}
2. ...

**Baseline check results:**

- prettier (format:check): {pass/fail}
- eslint (lint): {pass/fail with count}
- tsc --noEmit (typecheck): {pass/fail with count}

**Next steps:** run `/code-review-fix` to address findings, or review
individual issues on GitHub.

## Important notes

- This is a **read-only review**. Do NOT modify any source code.
- Be conservative with Critical severity — reserve it for genuine
  architectural problems (a license-boundary violation always qualifies).
- Group related findings for the same file into a single issue when they
  share a root cause.
- If an agent returns no findings for a category, that's fine — note it in
  the summary as a clean area.
