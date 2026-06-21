/**
 * CI auto-fix for drizzle-kit migration snapshot **parent-collisions**
 * (issue #210 — Slice 2 of #199).
 *
 * ## Why this exists
 *
 * Slice 1 (#199) shipped `npm run db:rebase` (`rebase-migrations.ts`): a local
 * helper that, after a branch merges `main` in, drops the branch-only migration
 * + snapshot, trims `_journal.json`, and regenerates off the merged base —
 * fixing the drizzle-kit error
 *
 *     [..._snapshot.json, ..._snapshot.json] are pointing to a parent
 *     snapshot: .../snapshot.json which is a collision.
 *
 * that the `migrations` CI job (`.github/workflows/integration.yml`) surfaces.
 * Slice 2 (this module) automates that helper on `claude/**` PRs: when the
 * migration round-trip fails *for the collision reason specifically*, it runs
 * `npm run db:rebase` (never `--force`) and pushes the regenerated migration
 * back to the PR branch — or, on a guarded refusal, comments for human
 * attention instead.
 *
 * ## Shape
 *
 * Every *decision* lives here as pure functions + the {@link autofixMigrations}
 * orchestrator behind injected seams ({@link CiAutofixDeps}), so the whole
 * trigger / loop-guard / push-vs-comment tree is unit-tested with in-memory
 * fakes and no live git/drizzle-kit/gh. The thin workflow YAML only wires the
 * real seams. {@link main} is guarded by an `import.meta.url` check so importing
 * this module for tests does not run it.
 *
 * ## Why drive `db:rebase` as a subprocess (not an in-process import)
 *
 * The Slice-1 engine is reused exactly as a human runs it — via the
 * `npm run db:rebase` CLI — rather than importing `rebaseMigrations()`. That
 * keeps this script self-contained (no relative import for `node
 * --experimental-strip-types` to resolve, matching how `rebase-migrations.ts`
 * itself is structured) and inherits every Slice-1 safety guard (conflict
 * refusal, the no-`--force` hand-edit / multi-migration guard) without
 * re-wiring it. The contract relied on is the Slice-1 CLI's documented one:
 * exit ≠ 0 ⇒ refused (reason on stderr); exit 0 with the regenerated migration
 * **staged** ⇒ done; exit 0 with nothing staged ⇒ noop.
 *
 * Like Slice 1 this is **dev-only tooling**: it lives outside `src/` (kept out
 * of the Docker image by `tsconfig.build.json`) and runs via
 * `node --experimental-strip-types` (no extra dependency). License boundary:
 * none touched — plain git + npm-script + `gh` orchestration.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * The marker stamped into the auto-fix commit message. The orchestrator skips
 * any run whose HEAD already carries it, so the bot can never trigger itself
 * into a regen loop (belt-and-braces alongside the fact that default
 * `GITHUB_TOKEN` pushes do not re-trigger workflows).
 */
export const SKIP_MARKER = "[skip-regen]";

/** The committed migrations folder (drizzle-kit `out`), relative to `server/`. */
export const MIGRATIONS_DIR = "drizzle";

// --- Pure matchers -----------------------------------------------------------

/**
 * True when drizzle-kit output is the snapshot **parent-collision** failure
 * (two migrations' snapshots claim the same `prevId` parent) — the *only*
 * failure this tool acts on. Matching both fragments (case-insensitively) is
 * robust to drizzle-kit line-wrapping the message; an unrelated drizzle error
 * (genuine drift, a malformed migration) is intentionally left to normal CI.
 *
 * Phrasing source: the drizzle-kit error quoted in `rebase-migrations.ts` and
 * `docs/testing.md` (`… pointing to a parent snapshot: … which is a collision`).
 */
export function isParentCollisionFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes("pointing to a parent") && normalized.includes("which is a collision");
}

/**
 * True when `commitMessage` carries `marker` — i.e. HEAD is the bot's own
 * regen commit, so this run must do nothing (loop guard).
 */
export function headHasSkipMarker(commitMessage: string, marker: string = SKIP_MARKER): boolean {
  return commitMessage.includes(marker);
}

/**
 * Extract the human-facing reason from a refused `db:rebase` run. The Slice-1
 * CLI prints `db:rebase refused: <reason>` to stderr; fall back to the raw
 * output (trimmed) if that prefix is absent so a comment is never empty.
 */
export function rebaseRefusalReason(output: string): string {
  const match = /db:rebase refused:\s*([\s\S]*)/.exec(output);
  const reason = (match?.[1] ?? output).trim();
  return reason === "" ? "db:rebase refused (no reason reported)." : reason;
}

// --- Comment bodies (pure) ---------------------------------------------------

/** PR comment posted after a successful auto-rebase + push. */
export function successCommentBody(baseRef: string): string {
  return (
    `🤖 The branch-only Drizzle migration hit a drizzle-kit snapshot ` +
    "parent-collision after the latest merge from `main`. I re-ran " +
    `\`npm run db:rebase\` to regenerate it onto \`${baseRef}\` and pushed the ` +
    "result.\n\n" +
    "The regenerated migration is **structurally equivalent** to what you " +
    "wrote — the auto-fix refuses to `--force` past a hand-edited or " +
    "multi-migration branch — but please review the new migration diff.\n\n" +
    "Note: this push was made with the default `GITHUB_TOKEN`, which does not " +
    "re-trigger workflows — **re-run the `migrations` check** (or push again) " +
    "to confirm it is green.\n\n" +
    `_Marked \`${SKIP_MARKER}\` so this auto-fix cannot retrigger itself._`
  );
}

/** PR comment posted when `db:rebase` refuses (needs a human). */
export function refusalCommentBody(reason: string): string {
  return (
    "⚠️ A drizzle-kit snapshot parent-collision was detected, but the auto-fix " +
    "**did not** rebase it — `db:rebase` refused because doing so " +
    "automatically would not be safe:\n\n" +
    "> " +
    reason.replace(/\n/g, "\n> ") +
    "\n\nResolve it locally with `cd server && npm run db:rebase` (add " +
    "`--force` only after reviewing the regenerated diff), then push."
  );
}

// --- Orchestration -----------------------------------------------------------

/** Injected I/O seams so the orchestrator is testable without live git/CI. */
export interface CiAutofixDeps {
  /** Run a git subcommand from the server dir; returns stdout (trimmed). */
  git(args: string[]): string;
  /**
   * Run the migration round-trip check (`npm run db:check`) and report whether
   * it passed plus its combined stdout+stderr. Must **not** throw on a non-zero
   * exit — a failing check is the normal trigger path.
   */
  checkMigrations(): { ok: boolean; output: string };
  /**
   * Run `npm run db:rebase` and report exit success plus combined output. Must
   * **not** throw on a non-zero exit — a refusal exits non-zero by design.
   */
  runRebase(): { ok: boolean; output: string };
  /** Post a PR comment (human-facing audit trail / call for attention). */
  comment(body: string): void;
  /** Emit a progress line. */
  log(message: string): void;
}

/** Options for {@link autofixMigrations}. */
export interface CiAutofixOptions {
  /** Base ref the rebase targets, for the audit messages (default `origin/main`). */
  baseRef: string;
  /** Head branch to push the regenerated migration back to. */
  branch: string;
  /** Loop-guard marker (default {@link SKIP_MARKER}). */
  skipMarker: string;
}

/** Outcome of an {@link autofixMigrations} run. */
export type CiAutofixResult =
  | { action: "skipped"; reason: string }
  | { action: "noop"; reason: string }
  | { action: "commented"; reason: string }
  | { action: "pushed"; reason: string };

/**
 * Decide and (if safe) perform the auto-fix. Returns a {@link CiAutofixResult};
 * never throws for an expected outcome — only genuine I/O / subprocess failures
 * surfaced by the seams propagate.
 */
export function autofixMigrations(deps: CiAutofixDeps, options: CiAutofixOptions): CiAutofixResult {
  // 1. Loop guard — never act on our own regen commit.
  const headMessage = deps.git(["log", "-1", "--pretty=%B"]);
  if (headHasSkipMarker(headMessage, options.skipMarker)) {
    return { action: "skipped", reason: "HEAD is the auto-fix's own regen commit (skip marker)." };
  }

  // 2. Only act on a red migration round-trip…
  const check = deps.checkMigrations();
  if (check.ok) {
    return { action: "noop", reason: "migration round-trip is green." };
  }
  // 3. …and only for the parent-collision reason. Acting on an unrelated red
  // (genuine drift, a broken migration) would mask a real failure — and running
  // db:rebase on a green branch would churn a fresh equivalent migration every
  // push, so the collision gate is what keeps this safe.
  if (!isParentCollisionFailure(check.output)) {
    return {
      action: "noop",
      reason: "migration check failed for an unrelated reason; left to normal CI.",
    };
  }

  // 4. Run the Slice-1 engine via its CLI. It never gets --force here, so a
  // hand-edited / multi-migration branch comes back as a refusal we comment on
  // rather than a silent clobber.
  deps.log("Detected a drizzle-kit snapshot parent-collision; running npm run db:rebase…");
  const rebase = deps.runRebase();
  if (!rebase.ok) {
    const reason = rebaseRefusalReason(rebase.output);
    deps.comment(refusalCommentBody(reason));
    return { action: "commented", reason };
  }

  // 5. db:rebase exited 0. It stages the regenerated migration on success and
  // stages nothing on a no-op — so the staged set under drizzle/ tells the two
  // apart without parsing stdout.
  const staged = deps.git(["diff", "--cached", "--name-only", "--", MIGRATIONS_DIR]).trim();
  if (staged === "") {
    return { action: "noop", reason: "db:rebase found nothing branch-only to rebase." };
  }

  // 6. Commit (marked so it cannot retrigger us) and push it back.
  deps.git([
    "commit",
    "-m",
    `chore(db): auto-rebase migration onto ${options.baseRef} ${options.skipMarker}\n\n` +
      "Regenerated after a drizzle-kit snapshot parent-collision " +
      "(issue #210, Slice 2 of #199).",
  ]);
  deps.git(["push", "origin", `HEAD:refs/heads/${options.branch}`]);
  deps.comment(successCommentBody(options.baseRef));
  deps.log(`Pushed the regenerated migration to ${options.branch}.`);
  return { action: "pushed", reason: `regenerated migration pushed to ${options.branch}.` };
}

// --- CLI / real-seam wiring --------------------------------------------------

/** Read a required environment variable or throw a clear error. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set (this tool runs in the migration-autofix workflow).`);
  }
  return value;
}

/** Run an npm script, capturing combined output and never throwing on failure. */
function runNpmScriptCapturing(cwd: string, script: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync("npm", ["run", script], { cwd, encoding: "utf8" });
    return { ok: true, output };
  } catch (error) {
    // execFileSync throws on a non-zero exit; the captured streams hang off the
    // error object. Coalesce stdout+stderr for the caller's matchers.
    const e = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    return { ok: false, output: `${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}` };
  }
}

/**
 * Build the real seams rooted at `cwd`:
 *  - `git` via `git` (trimmed stdout);
 *  - `checkMigrations` / `runRebase` via the `db:check` / `db:rebase` npm
 *    scripts, capturing output without throwing on a non-zero exit;
 *  - `comment` via the GitHub CLI (`gh`, present on the Actions runner; auth
 *    from `GH_TOKEN`).
 */
export function nodeDeps(cwd: string, prNumber: string): CiAutofixDeps {
  return {
    git: (args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim(),
    checkMigrations: () => runNpmScriptCapturing(cwd, "db:check"),
    runRebase: () => runNpmScriptCapturing(cwd, "db:rebase"),
    comment: (body) => {
      execFileSync("gh", ["pr", "comment", prNumber, "--body", body], { cwd, stdio: "inherit" });
    },
    log: (message) => process.stdout.write(`${message}\n`),
  };
}

/** Entry point: read the workflow env, run the auto-fix, report the outcome. */
export function main(): number {
  const branch = requireEnv("GITHUB_HEAD_REF");
  const prNumber = requireEnv("PR_NUMBER");
  const baseRef = process.env.AUTOFIX_BASE_REF ?? "origin/main";
  const result = autofixMigrations(nodeDeps(process.cwd(), prNumber), {
    baseRef,
    branch,
    skipMarker: SKIP_MARKER,
  });
  process.stdout.write(`migration-autofix: ${result.action} — ${result.reason}\n`);
  return 0;
}

// Run only when executed directly, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
