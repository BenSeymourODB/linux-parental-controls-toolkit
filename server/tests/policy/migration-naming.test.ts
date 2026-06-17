/**
 * Enforces the timestamp migration-naming convention introduced in #133.
 *
 * The first block unit-tests the pure {@link checkMigrationNaming} guard with
 * synthetic tag sets; the second block runs it against the *real* committed
 * `drizzle/` folder so a migration generated without the timestamp prefix (or
 * a same-second collision) fails CI's unit-test job. See `docs/testing.md` →
 * "Policy module — what to test".
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import { GRANDFATHERED_INDEX_TAGS, checkMigrationNaming } from "./migration-naming.js";

describe("checkMigrationNaming", () => {
  it("accepts an empty journal", () => {
    expect(checkMigrationNaming([])).toEqual([]);
  });

  it("accepts the grandfathered index-prefixed migrations", () => {
    expect(checkMigrationNaming(GRANDFATHERED_INDEX_TAGS)).toEqual([]);
  });

  it("accepts timestamp-prefixed migrations", () => {
    expect(
      checkMigrationNaming(["20260617040124_slow_devos", "20260618112233_brave_quill"]),
    ).toEqual([]);
  });

  it("accepts a mix of grandfathered and timestamp migrations", () => {
    expect(
      checkMigrationNaming([...GRANDFATHERED_INDEX_TAGS, "20260617040124_slow_devos"]),
    ).toEqual([]);
  });

  it("rejects a new index-prefixed migration", () => {
    const violations = checkMigrationNaming(["0002_eager_otter"]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("0002_eager_otter");
    expect(violations[0]).toContain("legacy sequential index prefix");
  });

  it("rejects a tag that matches no known convention", () => {
    const violations = checkMigrationNaming(["not_a_migration"]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("not_a_migration");
    expect(violations[0]).toContain("naming convention");
  });

  it("rejects a timestamp prefix with an out-of-charset slug", () => {
    // Uppercase is outside the `[a-z0-9_]` slug charset drizzle-kit emits.
    const violations = checkMigrationNaming(["20260617040124_BadSlug"]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("naming convention");
  });

  it("flags two migrations that share the same second", () => {
    const violations = checkMigrationNaming([
      "20260617040124_slow_devos",
      "20260617040124_brave_quill",
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("duplicate migration timestamp 20260617040124");
    expect(violations[0]).toContain("slow_devos");
    expect(violations[0]).toContain("brave_quill");
  });
});

// Resolve the committed migrations folder relative to this file (not the
// process cwd), mirroring tests/policy/migrations.test.ts.
const drizzleDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string() })),
});

function journalTags(): string[] {
  const raw: unknown = JSON.parse(readFileSync(resolve(drizzleDir, "meta/_journal.json"), "utf8"));
  return journalSchema.parse(raw).entries.map((entry) => entry.tag);
}

describe("committed migrations", () => {
  it("all follow the naming convention", () => {
    expect(checkMigrationNaming(journalTags())).toEqual([]);
  });

  it("each journal tag has its SQL file and snapshot, with no strays", () => {
    const tags = journalTags();

    const sqlFiles = readdirSync(drizzleDir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.slice(0, -".sql".length));
    expect(sqlFiles.sort()).toEqual([...tags].sort());

    const snapshots = new Set(readdirSync(resolve(drizzleDir, "meta")));
    for (const tag of tags) {
      const prefix = tag.split("_", 1)[0];
      expect(snapshots.has(`${prefix}_snapshot.json`)).toBe(true);
    }
  });
});
