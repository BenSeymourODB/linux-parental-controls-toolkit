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
 *  5. Runs `db:generate`, then `db:check`.
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
export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** The shape of drizzle-kit's `_journal.json` (v7). */
export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

/** Parse and lightly validate a `_journal.json` document. */
export function parseJournal(text: string): Journal {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error("malformed _journal.json: expected an object with an `entries` array");
  }
  return parsed as Journal;
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
 * Normalise a migration's SQL for an equivalence comparison: drop drizzle-kit's
 * `--> statement-breakpoint` separators and SQL comments, collapse runs of
 * whitespace, and trim. Two migrations that differ only in formatting or
 * breakpoint placement compare equal; one carrying hand-written / data SQL the
 * regenerator would not emit compares unequal.
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
 * True if the concatenation of `before` is equivalent (ignoring formatting and
 * breakpoints) to the concatenation of `after`. Used to detect a branch-only
 * migration that regen would *not* reproduce — i.e. it was hand-edited or
 * carries custom SQL, so blind regeneration would silently lose it.
 */
export function migrationsEquivalent(before: readonly string[], after: readonly string[]): boolean {
  return normaliseSql(before.join("\n")) === normaliseSql(after.join("\n"));
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

  // Capture the original SQL so we can (a) detect a hand-edited migration after
  // regen and (b) restore on abort.
  const originalSql = branchOnlyTags.map((tag) => deps.readText(sqlFileForTag(tag)));

  // 4. Drop branch-only artifacts and trim the journal.
  for (const tag of branchOnlyTags) {
    deps.remove(sqlFileForTag(tag));
    const snapshot = snapshotFileForTag(tag);
    if (deps.exists(snapshot)) {
      deps.remove(snapshot);
    }
  }
  const journal = parseJournal(deps.readText(JOURNAL_PATH));
  const trimmed = trimJournalEntries(journal, new Set(branchOnlyTags));
  deps.writeText(JOURNAL_PATH, `${JSON.stringify(trimmed, null, 2)}\n`);
  deps.log(`Dropped ${branchOnlyTags.length} branch-only migration(s); regenerating…`);

  // Record the .sql set before regen so we can find what regen adds.
  const sqlBefore = new Set(deps.listDir(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")));

  // 5. Regenerate off the merged base.
  deps.runScript("db:generate");

  // 3b. Safety guard: did regen reproduce the dropped migration? If the new SQL
  // is not equivalent, the original carried hand-written / custom SQL. Restore
  // and abort unless --force.
  const newTags = deps
    .listDir(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql") && !sqlBefore.has(n))
    .map((n) => n.slice(0, -".sql".length));
  const newSql = newTags.map((tag) => deps.readText(sqlFileForTag(tag)));
  if (!options.force && !migrationsEquivalent(originalSql, newSql)) {
    deps.git(["checkout", "--", MIGRATIONS_DIR]);
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

  // 6. Verify drift and stage (never commit).
  deps.runScript("db:check");
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
