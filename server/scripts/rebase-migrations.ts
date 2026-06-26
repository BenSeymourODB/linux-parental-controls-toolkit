/**
 * `npm run db:rebase` — re-chain a feature branch's Drizzle migration onto the
 * merged base after pulling `main` in (issue #199).
 *
 * ## Why this exists
 *
 * The timestamp-prefix convention (#133) keeps migration *filenames* from
 * colliding across concurrent branches, but each migration also writes a
 * snapshot under `drizzle/meta/` whose `prevId` points at the previous
 * snapshot. Two branches that each branch off the same snapshot and run
 * `db:generate` produce migrations whose snapshots claim the **same parent**.
 * Merging `main` in then surfaces as a drizzle-kit error:
 *
 *     [..._snapshot.json, ..._snapshot.json] are pointing to a parent
 *     snapshot: .../snapshot.json which is a collision.
 *
 * The reliable manual fix is mechanical but fiddly: drop the branch-only
 * migration(s) and their snapshots, trim the matching `_journal.json` entries,
 * and re-run `db:generate` so the new migration chains off the latest snapshot.
 * This tool automates that fix so contributors (and the implement-issue agent)
 * don't have to know the drizzle-kit internals.
 *
 * ## What it does (Slice 1 of #199)
 *
 *  1. Refuses to run while the merge is unresolved — `git diff --diff-filter=U`
 *     reports unmerged paths, or conflict markers remain in `_journal.json` or
 *     `src/policy/*.ts`. Regen repairs the migration *artifacts*; it cannot
 *     resolve the source merge for you.
 *  2. Computes branch-only migrations from
 *     `git diff --name-only origin/main...HEAD -- 'drizzle/*.sql'`.
 *  3. Safety guard — refuses (unless `--force`) when regenerating would be
 *     lossy: more than one branch-only migration (regen collapses them into a
 *     single cumulative diff), or a branch-only migration whose SQL is not
 *     equivalent to what regen produces (hand-edited / custom data SQL — this
 *     repo already has the #146 recurrence-recreate precedent, locked by
 *     `tests/policy/migrations.test.ts`). On a hand-edit detection without
 *     `--force`, the original artifacts are restored and the run aborts.
 *  4. Removes the branch-only `.sql` + their `meta/<prefix>_snapshot.json` and
 *     trims the matching `_journal.json` entries.
 *  5. Runs `db:generate`, then `db:check`. If either fails (or the hand-edit
 *     guard fires), it restores the original artifacts from an in-memory
 *     capture taken before step 4 and returns a refusal — the working tree is
 *     left exactly as it was found.
 *  6. Leaves the result **staged, not committed** — a human/agent reviews the
 *     regenerated schema diff and commits it. (Keeps a review gate on schema
 *     changes; this tool never mutates history.)
 *
 * ## Shape
 *
 * The pure helpers and the {@link rebaseMigrations} orchestrator take injected
 * `git` / filesystem / `runScript` seams (mirroring the offline-queue pattern),
 * so the whole decision tree is unit-tested with in-memory fakes and no live
 * git or drizzle-kit. {@link main} wires the real seams and is guarded by an
 * `import.meta.url` check so importing this module for tests does not run it.
 *
 * This is dev-only tooling: it lives outside `src/` (so `tsconfig.build.json`,
 * which only includes `src/**`, keeps it out of the Docker image) and is run
 * via `node --experimental-strip-types` (no extra dependency). License
 * boundary: none touched — plain git + filesystem + npm-script orchestration.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

// --- Paths (relative to the `server/` package root, i.e. `deps.cwd`) ---------

/** The committed migrations folder drizzle-kit writes to (`out` in the config). */
export const MIGRATIONS_DIR = "drizzle";
/** The snapshot + journal bookkeeping folder inside {@link MIGRATIONS_DIR}. */
export const META_DIR = join(MIGRATIONS_DIR, "meta");
/** The migration journal drizzle-kit chains snapshots through. */
export const JOURNAL_PATH = join(META_DIR, "_journal.json");
/** Policy schema sources whose unresolved merge would poison a regen. */
export const SCHEMA_SOURCE_DIR = join("src", "policy");

/** The `.sql` file drizzle-kit writes for a migration `tag`. */
export function sqlFileForTag(tag: string): string {
  return join(MIGRATIONS_DIR, `${tag}.sql`);
}

/**
 * The snapshot file for a migration `tag`. drizzle-kit names snapshots by the
 * migration's *prefix* (the part before the first underscore — the `0000`
 * sequence number or the `YYYYMMDDHHmmss` timestamp), not the full slug:
 * `20260619154107_fluffy_radioactive_man` → `20260619154107_snapshot.json`.
 */
export function snapshotFileForTag(tag: string): string {
  const prefix = tag.split("_", 1)[0] ?? tag;
  return join(META_DIR, `${prefix}_snapshot.json`);
}

// --- Conflict-marker detection (pure) ----------------------------------------

/** Git conflict markers, matched at the start of a line. */
const CONFLICT_MARKERS = [/^<{7} /m, /^={7}$/m, /^>{7} /m, /^\|{7} /m];

/** True if `text` still contains a git merge-conflict marker. */
export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_MARKERS.some((re) => re.test(text));
}

// --- Journal handling (pure) -------------------------------------------------

/** One entry in drizzle-kit's `_journal.json`. */
const journalEntrySchema = z.object({
  idx: z.number(),
  version: z.string(),
  when: z.number(),
  tag: z.string(),
  breakpoints: z.boolean(),
});

/** The shape of drizzle-kit's `_journal.json` (v7). */
const journalSchema = z.object({
  version: z.string(),
  dialect: z.string(),
  entries: z.array(journalEntrySchema),
});

/** One entry in drizzle-kit's `_journal.json`. */
export type JournalEntry = z.infer<typeof journalEntrySchema>;
/** The shape of drizzle-kit's `_journal.json` (v7). */
export type Journal = z.infer<typeof journalSchema>;

/**
 * Parse and validate a `_journal.json` document with zod (per the repo
 * convention of validating external input before it crosses into typed code) —
 * `trimJournalEntries` reads `entry.tag`, so a malformed entry must be rejected
 * up front rather than silently mis-trimmed.
 */
export function parseJournal(text: string): Journal {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`malformed _journal.json: not valid JSON (${String(error)})`);
  }
  const result = journalSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`malformed _journal.json: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Drop the named `tags` from a journal and renumber the surviving entries so
 * `idx` stays a dense 0-based sequence (drizzle-kit expects contiguous indices).
 * Pure: returns a new journal, leaving the input untouched.
 */
export function trimJournalEntries(journal: Journal, tagsToDrop: ReadonlySet<string>): Journal {
  const kept = journal.entries
    .filter((entry) => !tagsToDrop.has(entry.tag))
    .map((entry, idx) => ({ ...entry, idx }));
  return { ...journal, entries: kept };
}

// --- Branch-only migration discovery (pure parsing of git output) ------------

/**
 * Extract migration tags from `git diff --name-only … -- 'drizzle/*.sql'`
 * output. Each line is a repo-root-relative path such as
 * `server/drizzle/20260619154107_fluffy_radioactive_man.sql`; the tag is the
 * basename without the `.sql` extension. Lines that are not `drizzle/*.sql`
 * are ignored so the helper is robust to a wider pathspec.
 */
export function branchOnlyTagsFromDiff(diffOutput: string): string[] {
  const tags: string[] = [];
  for (const line of diffOutput.split("\n")) {
    const trimmed = line.trim();
    const match = /(?:^|\/)drizzle\/([^/]+)\.sql$/.exec(trimmed);
    if (match?.[1] !== undefined) {
      tags.push(match[1]);
    }
  }
  return tags;
}

// --- SQL equivalence (pure) --------------------------------------------------

/**
 * Normalise one SQL fragment for an equivalence comparison: drop full-line SQL
 * comments, collapse runs of whitespace, and trim. Inline trailing comments are
 * intentionally *not* stripped — keeping them makes hand-annotated SQL compare
 * unequal, which biases the safety guard towards refusing (the safe direction).
 *
 * Caveat: whitespace inside string literals is collapsed too, so two DDL
 * statements differing only by spaces inside a quoted string compare equal.
 * That is irrelevant for drizzle-generated DDL (no string-literal data) and the
 * guard only ever errs towards *refusing*, never towards a silent clobber.
 */
export function normaliseSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split SQL into its individual statements, normalised and sorted. drizzle-kit
 * separates statements with `--> statement-breakpoint`; splitting on that and
 * sorting makes the comparison **order-insensitive**, so a regen that emits the
 * same statements in a different order is not mistaken for a hand edit.
 */
function statementSet(sql: string): string[] {
  return sql
    .split(/-->\s*statement-breakpoint/)
    .map((fragment) => normaliseSql(fragment))
    .filter((fragment) => fragment !== "")
    .sort();
}

/**
 * True if `before` and `after` contain the same set of SQL statements (ignoring
 * formatting, full-line comments, breakpoints, and statement order). Used to
 * detect a branch-only migration that regen would *not* reproduce — i.e. it was
 * hand-edited or carries custom SQL, so blind regeneration would silently lose
 * it.
 */
export function migrationsEquivalent(before: readonly string[], after: readonly string[]): boolean {
  const a = statementSet(before.join("\n--> statement-breakpoint\n"));
  const b = statementSet(after.join("\n--> statement-breakpoint\n"));
  return a.length === b.length && a.every((statement, i) => statement === b[i]);
}

// --- Orchestration -----------------------------------------------------------

/** Injected I/O seams so the orchestrator is testable without live git/fs. */
export interface RebaseDeps {
  /** Run a git subcommand from the server dir; returns stdout (trimmed). */
  git(args: string[]): string;
  /** Run an npm script (`db:generate` / `db:check`) from the server dir. */
  runScript(npmScript: string): void;
  /** Does a server-dir-relative path exist? */
  exists(relPath: string): boolean;
  /** Read a server-dir-relative text file. */
  readText(relPath: string): string;
  /** Write a server-dir-relative text file. */
  writeText(relPath: string, content: string): void;
  /** Remove a server-dir-relative file. */
  remove(relPath: string): void;
  /** List the entries of a server-dir-relative directory. */
  listDir(relPath: string): string[];
  /** Emit a progress line. */
  log(message: string): void;
}

/** Options parsed from argv. */
export interface RebaseOptions {
  /** Proceed despite a lossy-regen safety-guard hit. */
  force: boolean;
  /** The base ref to diff against (default `origin/main`). */
  baseRef: string;
}

/** Outcome of a {@link rebaseMigrations} run. */
export interface RebaseResult {
  status: "noop" | "refused" | "done";
  reason?: string;
  droppedTags: string[];
}

/** Paths whose unresolved conflict markers must block a regen. */
function conflictScanPaths(deps: RebaseDeps): string[] {
  const paths = [JOURNAL_PATH];
  if (deps.exists(SCHEMA_SOURCE_DIR)) {
    for (const name of deps.listDir(SCHEMA_SOURCE_DIR)) {
      if (name.endsWith(".ts")) {
        paths.push(join(SCHEMA_SOURCE_DIR, name));
      }
    }
  }
  return paths;
}

/**
 * Re-chain branch-only migrations onto the merged base. See the module
 * docstring for the full contract. Returns a {@link RebaseResult}; never throws
 * for an expected refusal (conflicts, lossy regen) — only for genuine I/O or
 * subprocess failures surfaced by the seams.
 */
export function rebaseMigrations(deps: RebaseDeps, options: RebaseOptions): RebaseResult {
  // 1. Refuse while the merge is unresolved.
  const unmerged = deps.git(["diff", "--name-only", "--diff-filter=U"]).trim();
  if (unmerged !== "") {
    return {
      status: "refused",
      reason:
        "unresolved merge conflicts (unmerged paths):\n" +
        `${unmerged}\nResolve the source merge first — db:rebase regenerates ` +
        "migration artifacts, not the schema/source merge.",
      droppedTags: [],
    };
  }
  for (const path of conflictScanPaths(deps)) {
    if (deps.exists(path) && hasConflictMarkers(deps.readText(path))) {
      return {
        status: "refused",
        reason:
          `conflict markers remain in ${path} — resolve the source merge ` +
          "first, then re-run db:rebase.",
        droppedTags: [],
      };
    }
  }

  // 2. Compute branch-only migrations.
  const diff = deps.git([
    "diff",
    "--name-only",
    `${options.baseRef}...HEAD`,
    "--",
    `${MIGRATIONS_DIR}/*.sql`,
  ]);
  const branchOnlyTags = branchOnlyTagsFromDiff(diff);
  if (branchOnlyTags.length === 0) {
    return { status: "noop", reason: "no branch-only migrations to rebase.", droppedTags: [] };
  }

  // 3a. Safety guard: more than one branch-only migration collapses lossily.
  if (branchOnlyTags.length > 1 && !options.force) {
    return {
      status: "refused",
      reason:
        `${branchOnlyTags.length} branch-only migrations found ` +
        `(${branchOnlyTags.join(", ")}). Regen collapses them into a single ` +
        "cumulative diff, which is lossy. Re-run with --force if that is what " +
        "you want, or rebase them by hand.",
      droppedTags: [],
    };
  }

  // Capture every original artifact in memory *before* mutating anything, so an
  // abort (hand-edit detected, regen/check failure) restores the exact bytes we
  // started from — independent of git state. `git checkout` only restores the
  // *index* version, which would silently drop a staged-but-uncommitted or
  // freshly-generated hand edit; an in-memory snapshot does not.
  const originalArtifacts = branchOnlyTags.map((tag) => {
    const snapshotPath = snapshotFileForTag(tag);
    const snapshotContent = deps.exists(snapshotPath) ? deps.readText(snapshotPath) : undefined;
    if (snapshotContent === undefined) {
      deps.log(
        `warning: no snapshot found for ${tag} (${snapshotPath}); the migration ` +
          "set was already inconsistent before this rebase.",
      );
    }
    return {
      tag,
      sqlPath: sqlFileForTag(tag),
      sqlContent: deps.readText(sqlFileForTag(tag)),
      snapshotPath,
      snapshotContent,
    };
  });
  const originalSql = originalArtifacts.map((artifact) => artifact.sqlContent);
  const originalJournal = deps.readText(JOURNAL_PATH);

  /** Remove regen output for `newTags` and rewrite the captured originals. */
  const restoreOriginals = (newTags: readonly string[]): void => {
    for (const tag of newTags) {
      const sqlFile = sqlFileForTag(tag);
      if (deps.exists(sqlFile)) {
        deps.remove(sqlFile);
      }
      const snapshot = snapshotFileForTag(tag);
      if (deps.exists(snapshot)) {
        deps.remove(snapshot);
      }
    }
    for (const artifact of originalArtifacts) {
      deps.writeText(artifact.sqlPath, artifact.sqlContent);
      if (artifact.snapshotContent !== undefined) {
        deps.writeText(artifact.snapshotPath, artifact.snapshotContent);
      }
    }
    deps.writeText(JOURNAL_PATH, originalJournal);
  };

  // 4. Drop branch-only artifacts and trim the journal.
  for (const artifact of originalArtifacts) {
    deps.remove(artifact.sqlPath);
    if (artifact.snapshotContent !== undefined && deps.exists(artifact.snapshotPath)) {
      deps.remove(artifact.snapshotPath);
    }
  }
  const trimmed = trimJournalEntries(parseJournal(originalJournal), new Set(branchOnlyTags));
  deps.writeText(JOURNAL_PATH, `${JSON.stringify(trimmed, null, 2)}\n`);
  deps.log(`Dropped ${branchOnlyTags.length} branch-only migration(s); regenerating…`);

  // Record the .sql set before regen so we can find what regen adds.
  const sqlBefore = new Set(deps.listDir(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")));

  // 5. Regenerate off the merged base. A regen failure leaves the tree with the
  // originals dropped; restore them before surfacing the error so the working
  // tree is exactly as we found it (the "never throws on an expected refusal"
  // contract).
  try {
    deps.runScript("db:generate");
  } catch (error) {
    restoreOriginals([]);
    return {
      status: "refused",
      reason: `db:generate failed (${String(error)}); original artifacts restored. Resolve the schema/source first, then re-run db:rebase.`,
      droppedTags: [],
    };
  }

  // 3b. Safety guard: did regen reproduce the dropped migration? If the new SQL
  // is not equivalent, the original carried hand-written / custom SQL. Restore
  // and abort unless --force.
  const newTags = deps
    .listDir(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql") && !sqlBefore.has(n))
    .map((n) => n.slice(0, -".sql".length));
  const newSql = newTags.map((tag) => deps.readText(sqlFileForTag(tag)));
  if (!options.force && !migrationsEquivalent(originalSql, newSql)) {
    restoreOriginals(newTags);
    return {
      status: "refused",
      reason:
        "the branch-only migration was not reproduced by regen — it looks " +
        "hand-edited or carries custom/data SQL (e.g. a data backfill or the " +
        "#146 recurrence recreate). Original artifacts restored. Rebase by " +
        "hand, or re-run with --force to accept the regenerated diff.",
      droppedTags: [],
    };
  }

  // 6. Verify drift, then stage (never commit). A drift failure means the regen
  // still does not match the schema; restore and report rather than leave a
  // broken half-applied tree behind.
  try {
    deps.runScript("db:check");
  } catch (error) {
    restoreOriginals(newTags);
    return {
      status: "refused",
      reason: `db:check reported drift after regen (${String(error)}); original artifacts restored. Inspect the schema and rebase by hand.`,
      droppedTags: [],
    };
  }
  deps.git(["add", "--", MIGRATIONS_DIR]);
  deps.log(
    `Rebased onto ${options.baseRef}. Regenerated migration staged (not ` +
      "committed) — review the schema diff and commit it.",
  );
  return { status: "done", droppedTags: branchOnlyTags };
}

// --- CLI wiring --------------------------------------------------------------

/** Parse argv flags (`--force`, `--base <ref>`). */
export function parseArgs(argv: readonly string[]): RebaseOptions {
  let force = false;
  let baseRef = "origin/main";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--base") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error("--base requires a ref argument");
      }
      baseRef = next;
      i++;
    } else if (arg?.startsWith("--base=")) {
      baseRef = arg.slice("--base=".length);
    } else {
      // Fail loudly on a typo (e.g. `--forced`) rather than silently ignoring
      // it — this tool deletes and regenerates files, so a dropped `--force`
      // would surprise.
      throw new Error(`unknown argument: ${String(arg)} (supported: --force, --base <ref>)`);
    }
  }
  return { force, baseRef };
}

/** Build the real (live git + fs + npm) seams rooted at `cwd`. */
export function nodeDeps(cwd: string): RebaseDeps {
  const abs = (rel: string): string => join(cwd, rel);
  return {
    git: (args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim(),
    runScript: (npmScript) => {
      execFileSync("npm", ["run", npmScript], { cwd, stdio: "inherit" });
    },
    exists: (rel) => existsSync(abs(rel)),
    readText: (rel) => readFileSync(abs(rel), "utf8"),
    writeText: (rel, content) => writeFileSync(abs(rel), content),
    remove: (rel) => rmSync(abs(rel)),
    listDir: (rel) => readdirSync(abs(rel)),
    log: (message) => process.stdout.write(`${message}\n`),
  };
}

/** Entry point: run a rebase rooted at the current working directory. */
export function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const result = rebaseMigrations(nodeDeps(process.cwd()), options);
  if (result.status === "refused") {
    process.stderr.write(`db:rebase refused: ${result.reason}\n`);
    return 1;
  }
  if (result.status === "noop") {
    process.stdout.write(`db:rebase: ${result.reason ?? "nothing to do"}\n`);
    return 0;
  }
  return 0;
}

// Run only when executed directly, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
