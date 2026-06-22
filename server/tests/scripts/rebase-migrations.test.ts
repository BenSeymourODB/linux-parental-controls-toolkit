/**
 * Unit tests for the `db:rebase` migration-rebase tool (issue #199).
 *
 * The pure helpers are exercised directly; the {@link rebaseMigrations}
 * orchestrator runs against an in-memory {@link FakeEnv} that fakes every
 * injected seam (git, filesystem, npm scripts), so the full decision tree —
 * conflict refusal, the lossy-regen safety guard, hand-edit detection +
 * restore, and the happy path — is covered without a live git or drizzle-kit.
 */
import { describe, expect, it } from "vitest";

import {
  JOURNAL_PATH,
  MIGRATIONS_DIR,
  branchOnlyTagsFromDiff,
  hasConflictMarkers,
  migrationsEquivalent,
  normaliseSql,
  parseArgs,
  parseJournal,
  rebaseMigrations,
  snapshotFileForTag,
  sqlFileForTag,
  trimJournalEntries,
  type Journal,
  type RebaseDeps,
} from "../../scripts/rebase-migrations.js";

// --- Pure helpers ------------------------------------------------------------

describe("hasConflictMarkers", () => {
  it("detects each kind of merge marker", () => {
    expect(hasConflictMarkers("a\n<<<<<<< HEAD\nb")).toBe(true);
    expect(hasConflictMarkers("a\n=======\nb")).toBe(true);
    expect(hasConflictMarkers("a\n>>>>>>> branch\nb")).toBe(true);
    expect(hasConflictMarkers("a\n||||||| base\nb")).toBe(true);
  });

  it("ignores clean content and incidental angle brackets", () => {
    expect(hasConflictMarkers("const x = a <<< 2;\nif (a >>> b) {}")).toBe(false);
    expect(hasConflictMarkers("SELECT * FROM t WHERE a = '=======';")).toBe(false);
    expect(hasConflictMarkers("")).toBe(false);
  });
});

describe("parseJournal", () => {
  it("parses a well-formed journal", () => {
    const journal = parseJournal(JSON.stringify({ version: "7", dialect: "sqlite", entries: [] }));
    expect(journal.version).toBe("7");
    expect(journal.entries).toEqual([]);
  });

  it("rejects a malformed journal", () => {
    expect(() => parseJournal("{}")).toThrow(/malformed/);
    expect(() => parseJournal("[]")).toThrow(/malformed/);
    expect(() => parseJournal("null")).toThrow(/malformed/);
  });
});

describe("trimJournalEntries", () => {
  const journal: Journal = {
    version: "7",
    dialect: "sqlite",
    entries: [
      { idx: 0, version: "6", when: 1, tag: "0000_a", breakpoints: true },
      { idx: 1, version: "6", when: 2, tag: "0001_b", breakpoints: true },
      { idx: 2, version: "6", when: 3, tag: "20260619_c", breakpoints: true },
    ],
  };

  it("drops named tags and renumbers idx densely", () => {
    const trimmed = trimJournalEntries(journal, new Set(["0001_b"]));
    expect(trimmed.entries.map((e) => e.tag)).toEqual(["0000_a", "20260619_c"]);
    expect(trimmed.entries.map((e) => e.idx)).toEqual([0, 1]);
  });

  it("does not mutate the input", () => {
    trimJournalEntries(journal, new Set(["0000_a"]));
    expect(journal.entries).toHaveLength(3);
    expect(journal.entries[0]?.idx).toBe(0);
  });
});

describe("branchOnlyTagsFromDiff", () => {
  it("extracts tags from drizzle .sql paths and ignores the rest", () => {
    const diff = [
      "server/drizzle/20260619154107_fluffy_radioactive_man.sql",
      "server/drizzle/meta/20260619154107_snapshot.json",
      "server/src/policy/schema.ts",
      "",
      "  server/drizzle/0003_legacy_thing.sql  ",
    ].join("\n");
    expect(branchOnlyTagsFromDiff(diff)).toEqual([
      "20260619154107_fluffy_radioactive_man",
      "0003_legacy_thing",
    ]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(branchOnlyTagsFromDiff("")).toEqual([]);
    expect(branchOnlyTagsFromDiff("src/policy/schema.ts")).toEqual([]);
  });

  it("parses both the repo-root and bare drizzle path forms identically", () => {
    expect(branchOnlyTagsFromDiff("server/drizzle/20260619_x.sql")).toEqual(["20260619_x"]);
    expect(branchOnlyTagsFromDiff("drizzle/20260619_x.sql")).toEqual(["20260619_x"]);
  });
});

describe("path helpers", () => {
  it("derives the .sql file from a tag", () => {
    expect(sqlFileForTag("20260619154107_fluffy")).toBe(
      `${MIGRATIONS_DIR}/20260619154107_fluffy.sql`,
    );
  });

  it("derives the snapshot from the tag prefix, not the full slug", () => {
    expect(snapshotFileForTag("20260619154107_fluffy_radioactive_man")).toBe(
      `${MIGRATIONS_DIR}/meta/20260619154107_snapshot.json`,
    );
    expect(snapshotFileForTag("0000_broad_slapstick")).toBe(
      `${MIGRATIONS_DIR}/meta/0000_snapshot.json`,
    );
  });
});

describe("normaliseSql / migrationsEquivalent", () => {
  it("treats breakpoints, comments, and whitespace as insignificant", () => {
    const a = "CREATE TABLE t (\n  id integer\n);\n--> statement-breakpoint\n-- a comment\n";
    const b = "CREATE TABLE t ( id integer );";
    expect(normaliseSql(a)).toBe(normaliseSql(b));
    expect(migrationsEquivalent([a], [b])).toBe(true);
  });

  it("treats different SQL as not equivalent", () => {
    expect(
      migrationsEquivalent(["CREATE TABLE t (id integer);"], ["CREATE TABLE u (id integer);"]),
    ).toBe(false);
  });

  it("compares the set of statements across migrations, ignoring order", () => {
    // Same statements, regenerated in a different order with a breakpoint
    // between them — still equivalent.
    expect(
      migrationsEquivalent(
        ["CREATE TABLE a (x int);", "CREATE TABLE b (y int);"],
        ["CREATE TABLE b (y int);\n--> statement-breakpoint\nCREATE TABLE a (x int);"],
      ),
    ).toBe(true);
  });

  it("treats a different number of statements as not equivalent", () => {
    expect(
      migrationsEquivalent(
        ["CREATE TABLE a (x int);\n--> statement-breakpoint\nUPDATE a SET x = 1;"],
        ["CREATE TABLE a (x int);"],
      ),
    ).toBe(false);
  });
});

describe("parseArgs", () => {
  it("defaults to no force and origin/main", () => {
    expect(parseArgs([])).toEqual({ force: false, baseRef: "origin/main" });
  });

  it("parses --force and both --base forms", () => {
    expect(parseArgs(["--force"]).force).toBe(true);
    expect(parseArgs(["--base", "upstream/main"]).baseRef).toBe("upstream/main");
    expect(parseArgs(["--base=upstream/dev"]).baseRef).toBe("upstream/dev");
  });

  it("rejects --base without a value", () => {
    expect(() => parseArgs(["--base"])).toThrow(/--base requires/);
  });

  it("rejects an unknown flag rather than silently ignoring it", () => {
    expect(() => parseArgs(["--forced"])).toThrow(/unknown argument/);
  });
});

// --- Orchestrator (in-memory fakes) -----------------------------------------

/** An in-memory implementation of every {@link RebaseDeps} seam. */
class FakeEnv {
  readonly files = new Map<string, string>();
  readonly gitCalls: string[][] = [];
  readonly scriptCalls: string[] = [];
  readonly logs: string[] = [];

  /** Per-test git stdout responder, keyed off the joined args. */
  gitResponder: (args: string[]) => string = () => "";
  /** Per-test reaction to an npm script (e.g. db:generate writing a file). */
  onScript: (script: string, env: FakeEnv) => void = () => undefined;

  private childNames(dir: string): string[] {
    const prefix = `${dir}/`;
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return [...names];
  }

  private dirExists(dir: string): boolean {
    const prefix = `${dir}/`;
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  deps(): RebaseDeps {
    return {
      git: (args) => {
        this.gitCalls.push(args);
        return this.gitResponder(args);
      },
      runScript: (script) => {
        this.scriptCalls.push(script);
        this.onScript(script, this);
      },
      exists: (rel) => this.files.has(rel) || this.dirExists(rel),
      readText: (rel) => {
        const value = this.files.get(rel);
        if (value === undefined) {
          throw new Error(`fake ENOENT: ${rel}`);
        }
        return value;
      },
      writeText: (rel, content) => {
        this.files.set(rel, content);
      },
      remove: (rel) => {
        if (!this.files.delete(rel)) {
          throw new Error(`fake ENOENT on remove: ${rel}`);
        }
      },
      listDir: (rel) => this.childNames(rel),
      log: (message) => {
        this.logs.push(message);
      },
    };
  }
}

/** A journal containing one committed migration plus the named branch tags. */
function journalWith(...tags: string[]): string {
  const all = ["0000_base", ...tags];
  return `${JSON.stringify(
    {
      version: "7",
      dialect: "sqlite",
      entries: all.map((tag, idx) => ({ idx, version: "6", when: idx, tag, breakpoints: true })),
    },
    null,
    2,
  )}\n`;
}

/** Seed a FakeEnv with a clean schema source and a committed base migration. */
function seedBase(env: FakeEnv): void {
  env.files.set("src/policy/schema.ts", "export const t = 1;\n");
  env.files.set(sqlFileForTag("0000_base"), "CREATE TABLE base (id integer);");
  env.files.set(snapshotFileForTag("0000_base"), "{}");
}

const NO_UNMERGED = (args: string[]): string =>
  args.join(" ") === "diff --name-only --diff-filter=U" ? "" : "";

describe("rebaseMigrations", () => {
  it("refuses when there are unmerged paths", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.gitResponder = (args) =>
      args.join(" ") === "diff --name-only --diff-filter=U" ? "server/src/policy/schema.ts" : "";

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/unresolved merge conflicts/);
    expect(env.scriptCalls).toEqual([]);
  });

  it("refuses when conflict markers remain in a scanned source file", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.files.set(
      "src/policy/schema.ts",
      "export const t = 1;\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n",
    );
    env.gitResponder = NO_UNMERGED;

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/conflict markers remain/);
    expect(env.scriptCalls).toEqual([]);
  });

  it("is a no-op when there are no branch-only migrations", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.gitResponder = () => "";

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("noop");
    expect(env.scriptCalls).toEqual([]);
  });

  it("refuses more than one branch-only migration without --force", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.files.set("drizzle/meta/_journal.json", journalWith("0001_a", "0002_b"));
    env.files.set(sqlFileForTag("0001_a"), "CREATE TABLE a (id integer);");
    env.files.set(sqlFileForTag("0002_b"), "CREATE TABLE b (id integer);");
    env.gitResponder = (args) =>
      args.includes("origin/main...HEAD")
        ? "server/drizzle/0001_a.sql\nserver/drizzle/0002_b.sql"
        : "";

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/2 branch-only migrations/);
    expect(env.scriptCalls).toEqual([]);
  });

  it("rebases a single branch-only migration on the happy path", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.files.set("drizzle/meta/_journal.json", journalWith("20260619_x"));
    env.files.set(sqlFileForTag("20260619_x"), "CREATE TABLE x (id integer);");
    env.files.set(snapshotFileForTag("20260619_x"), "{}");
    env.gitResponder = (args) =>
      args.includes("origin/main...HEAD") ? "server/drizzle/20260619_x.sql" : "";
    // Deterministic regen re-emits the same structural SQL (drizzle-kit is
    // byte-stable for an unchanged schema), differing only by a breakpoint
    // line that normaliseSql treats as insignificant.
    env.onScript = (script, e) => {
      if (script === "db:generate") {
        e.files.set(
          sqlFileForTag("20260620_x"),
          "CREATE TABLE x (id integer);\n--> statement-breakpoint",
        );
        e.files.set(snapshotFileForTag("20260620_x"), "{}");
      }
    };

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("done");
    expect(result.droppedTags).toEqual(["20260619_x"]);
    // Old artifacts gone, journal trimmed, regen + check ran, result staged.
    expect(env.files.has(sqlFileForTag("20260619_x"))).toBe(false);
    expect(env.files.has(snapshotFileForTag("20260619_x"))).toBe(false);
    expect(parseJournal(env.files.get(JOURNAL_PATH) ?? "").entries.map((en) => en.tag)).toEqual([
      "0000_base",
    ]);
    expect(env.scriptCalls).toEqual(["db:generate", "db:check"]);
    expect(env.gitCalls).toContainEqual(["add", "--", MIGRATIONS_DIR]);
  });

  it("detects a hand-edited migration, restores artifacts, and refuses", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.files.set("drizzle/meta/_journal.json", journalWith("20260619_x"));
    env.files.set(
      sqlFileForTag("20260619_x"),
      "CREATE TABLE x (id integer);\n--> statement-breakpoint\nUPDATE x SET id = 1; -- data backfill",
    );
    env.files.set(snapshotFileForTag("20260619_x"), "{}");
    env.gitResponder = (args) =>
      args.includes("origin/main...HEAD") ? "server/drizzle/20260619_x.sql" : "";
    // Regen emits only the structural part — the data backfill is lost.
    env.onScript = (script, e) => {
      if (script === "db:generate") {
        e.files.set(sqlFileForTag("20260620_x"), "CREATE TABLE x (id integer);");
        e.files.set(snapshotFileForTag("20260620_x"), "{}");
      }
    };

    const original = env.files.get(sqlFileForTag("20260619_x"));
    const originalJournal = env.files.get(JOURNAL_PATH);

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/hand-edited or carries custom\/data SQL/);
    // The regenerated files were removed and the originals restored byte-for-byte
    // from the in-memory capture (not via `git checkout`).
    expect(env.files.has(sqlFileForTag("20260620_x"))).toBe(false);
    expect(env.files.get(sqlFileForTag("20260619_x"))).toBe(original);
    expect(env.files.has(snapshotFileForTag("20260619_x"))).toBe(true);
    expect(env.files.get(JOURNAL_PATH)).toBe(originalJournal);
    expect(env.gitCalls).not.toContainEqual(["checkout", "--", MIGRATIONS_DIR]);
    // db:check must not have run after the refusal.
    expect(env.scriptCalls).toEqual(["db:generate"]);
  });

  it("restores the originals and refuses when db:generate fails", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.files.set("drizzle/meta/_journal.json", journalWith("20260619_x"));
    env.files.set(sqlFileForTag("20260619_x"), "CREATE TABLE x (id integer);");
    env.files.set(snapshotFileForTag("20260619_x"), "{}");
    env.gitResponder = (args) =>
      args.includes("origin/main...HEAD") ? "server/drizzle/20260619_x.sql" : "";
    const originalJournal = env.files.get(JOURNAL_PATH);
    env.onScript = (script) => {
      if (script === "db:generate") {
        throw new Error("drizzle-kit exploded");
      }
    };

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/db:generate failed/);
    // Tree restored: the dropped migration and its journal entry are back.
    expect(env.files.has(sqlFileForTag("20260619_x"))).toBe(true);
    expect(env.files.get(JOURNAL_PATH)).toBe(originalJournal);
    // db:check never ran; nothing was staged.
    expect(env.scriptCalls).toEqual(["db:generate"]);
    expect(env.gitCalls).not.toContainEqual(["add", "--", MIGRATIONS_DIR]);
  });

  it("restores the originals and refuses when db:check reports drift", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.files.set("drizzle/meta/_journal.json", journalWith("20260619_x"));
    env.files.set(sqlFileForTag("20260619_x"), "CREATE TABLE x (id integer);");
    env.files.set(snapshotFileForTag("20260619_x"), "{}");
    env.gitResponder = (args) =>
      args.includes("origin/main...HEAD") ? "server/drizzle/20260619_x.sql" : "";
    const originalJournal = env.files.get(JOURNAL_PATH);
    env.onScript = (script, e) => {
      if (script === "db:generate") {
        e.files.set(sqlFileForTag("20260620_x"), "CREATE TABLE x (id integer);");
        e.files.set(snapshotFileForTag("20260620_x"), "{}");
      } else if (script === "db:check") {
        throw new Error("schema drift detected");
      }
    };

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/db:check reported drift/);
    // Regen output removed, originals restored, nothing staged.
    expect(env.files.has(sqlFileForTag("20260620_x"))).toBe(false);
    expect(env.files.has(sqlFileForTag("20260619_x"))).toBe(true);
    expect(env.files.get(JOURNAL_PATH)).toBe(originalJournal);
    expect(env.scriptCalls).toEqual(["db:generate", "db:check"]);
    expect(env.gitCalls).not.toContainEqual(["add", "--", MIGRATIONS_DIR]);
  });

  it("refuses when conflict markers remain in the journal", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.files.set("drizzle/meta/_journal.json", "{\n<<<<<<< HEAD\n=======\n>>>>>>> b\n}");
    env.gitResponder = NO_UNMERGED;

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/conflict markers remain/);
    expect(result.reason).toMatch(/_journal\.json/);
    expect(env.scriptCalls).toEqual([]);
  });

  it("scans every policy .ts file for conflict markers, not just schema.ts", () => {
    const env = new FakeEnv();
    seedBase(env);
    // A clean schema.ts but a conflicted sibling under src/policy.
    env.files.set(
      "src/policy/enums.ts",
      "export const e = 1;\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b",
    );
    env.gitResponder = NO_UNMERGED;

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/enums\.ts/);
    expect(env.scriptCalls).toEqual([]);
  });

  it("warns when a branch-only migration has no snapshot, then proceeds", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.files.set("drizzle/meta/_journal.json", journalWith("20260619_x"));
    env.files.set(sqlFileForTag("20260619_x"), "CREATE TABLE x (id integer);");
    // Deliberately no snapshot file for 20260619_x.
    env.gitResponder = (args) =>
      args.includes("origin/main...HEAD") ? "server/drizzle/20260619_x.sql" : "";
    env.onScript = (script, e) => {
      if (script === "db:generate") {
        e.files.set(sqlFileForTag("20260620_x"), "CREATE TABLE x (id integer);");
        e.files.set(snapshotFileForTag("20260620_x"), "{}");
      }
    };

    const result = rebaseMigrations(env.deps(), { force: false, baseRef: "origin/main" });

    expect(result.status).toBe("done");
    expect(env.logs.some((line) => /no snapshot found for 20260619_x/.test(line))).toBe(true);
  });

  it("accepts a non-reproducible migration under --force", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.files.set("drizzle/meta/_journal.json", journalWith("20260619_x"));
    env.files.set(sqlFileForTag("20260619_x"), "UPDATE x SET id = 1; -- data only");
    env.files.set(snapshotFileForTag("20260619_x"), "{}");
    env.gitResponder = (args) =>
      args.includes("origin/main...HEAD") ? "server/drizzle/20260619_x.sql" : "";
    env.onScript = (script, e) => {
      if (script === "db:generate") {
        e.files.set(sqlFileForTag("20260620_x"), "CREATE TABLE x (id integer);");
      }
    };

    const result = rebaseMigrations(env.deps(), { force: true, baseRef: "origin/main" });

    expect(result.status).toBe("done");
    expect(env.scriptCalls).toEqual(["db:generate", "db:check"]);
  });

  it("collapses multiple branch-only migrations under --force", () => {
    const env = new FakeEnv();
    seedBase(env);
    env.files.set("drizzle/meta/_journal.json", journalWith("0001_a", "0002_b"));
    env.files.set(sqlFileForTag("0001_a"), "CREATE TABLE a (id integer);");
    env.files.set(snapshotFileForTag("0001_a"), "{}");
    env.files.set(sqlFileForTag("0002_b"), "CREATE TABLE b (id integer);");
    env.files.set(snapshotFileForTag("0002_b"), "{}");
    env.gitResponder = (args) =>
      args.includes("origin/main...HEAD")
        ? "server/drizzle/0001_a.sql\nserver/drizzle/0002_b.sql"
        : "";
    env.onScript = (script, e) => {
      if (script === "db:generate") {
        e.files.set(
          sqlFileForTag("20260620_merged"),
          "CREATE TABLE a (id integer);\nCREATE TABLE b (id integer);",
        );
      }
    };

    const result = rebaseMigrations(env.deps(), { force: true, baseRef: "origin/main" });

    expect(result.status).toBe("done");
    expect(result.droppedTags).toEqual(["0001_a", "0002_b"]);
    expect(env.scriptCalls).toEqual(["db:generate", "db:check"]);
  });
});
