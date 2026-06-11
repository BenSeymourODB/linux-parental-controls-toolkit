# Code Review Fix — remediation command

You are the **remediation executor** for code review findings. Your job is
to read open code-review issues from GitHub, help the user prioritize, and
execute fixes one at a time.

**Read `CLAUDE.md` first** — every fix must respect the license boundaries,
the dashboard module split, strict TypeScript (`tsc --noEmit`), and the
bounded tamper-resistance posture.

Where this guide shows `gh ...`, use the GitHub MCP tools (`mcp__github__*`)
instead when your environment provides them; fall back to the `gh` CLI when
running locally.

## Step 1: Fetch open findings

List all open GitHub Issues with the `code-review` label:

```bash
gh issue list --label code-review --state open \
  --json number,title,labels,body --limit 100
```

Parse the issues into a table:

| #     | Severity | Category | File   | Issue | Effort |
| ----- | -------- | -------- | ------ | ----- | ------ |
| {num} | {sev}    | {cat}    | {path} | {desc}| {S/M/L}|

Sort by: Critical first, then High, Medium, Low. Within the same severity,
Small effort before Medium before Large. Surface any `license-boundary`
findings at the very top regardless of stated severity — those are
architectural invariants.

## Step 2: Ask what to fix

Present the table and ask the user:

- "Which issues would you like to address? (issue numbers, 'all', or 'top N')"
- Recommend starting with Critical+Small and High+Small for maximum impact
  per unit effort, and clearing any `license-boundary` finding first.

## Step 3: Execute fixes

For each selected issue, in order:

1. **Read the issue body** to understand the finding, file, and suggestion.
2. **Read the affected file** to understand the current code.
3. **Implement the suggested fix** (or a better one if you identify it).
   Keep changes scoped to the finding — don't refactor unrelated code.
4. **Run the quality gate** from `server/`:
   ```bash
   cd server
   npm run format        # prettier --write .
   npm run lint:fix      # eslint . --fix
   npm run typecheck     # tsc --noEmit
   ```
5. **Run the relevant tests** (the unit selection CI uses):
   ```bash
   npm test              # vitest run (unit only, excludes *.int.test.ts) with coverage
   ```
   If the fix touches a transport or external boundary, also run its
   integration tests (`npm run test:integration`) via the Docker Compose
   recipe in `docs/testing.md`.
6. **If all checks pass**, note the fix is ready.
7. **If checks fail**, diagnose and fix before moving on.

After each fix, report what changed and confirm checks pass.

## Step 4: Close resolved issues

After all selected fixes pass:

1. **Stage and commit** with a message referencing the issue numbers and
   the standard footer:
   ```
   fix: address code review findings #{issue1}, #{issue2}

   🤖 Generated with [Claude Code](https://claude.com/claude-code)

   Co-authored-by: Claude <noreply@anthropic.com>
   ```
2. **Close each resolved issue** with a comment:
   ```bash
   gh issue close {number} --comment "Resolved in commit {sha}. {summary}"
   ```

## Step 5: Summary

Present a remediation summary:

| Issue              | Status                    | Changes            |
| ------------------ | ------------------------- | ------------------ |
| #{number}: {title} | Fixed / Skipped / Partial | {what was changed} |

**Quality checks:** all passing / {details of any failures}
**Remaining open issues:** {count}

## Important notes

- **Never skip quality checks** — every fix must pass Prettier, ESLint,
  `tsc --noEmit`, and the unit tests (coverage gate 80%).
- **One fix at a time** — don't batch unrelated fixes into one change.
- **Preserve existing tests** — never remove or weaken a test to make a fix
  pass; if a test reveals a real problem, fix the code.
- **Never collapse a license boundary** to make a finding "go away" — if a
  finding seems to require it, stop and raise it in the issue thread.
- **Ask before large refactors** — if a fix would touch >5 files, confirm
  with the user first.
- **Follow `CLAUDE.md` conventions** — all fixes must adhere to the
  project's standards and the dashboard module split.
