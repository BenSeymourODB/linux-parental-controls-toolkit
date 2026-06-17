/**
 * Migration filename-convention guard (issue #133).
 *
 * drizzle-kit's default `index` prefix numbers migrations sequentially
 * (`0000_`, `0001_`, …), so two branches that each run `db:generate` off the
 * same `main` collide on identical filenames — both the `.sql` and the
 * `meta/_snapshot.json` — and have to be renumbered by hand on merge. We
 * switched `drizzle.config.ts` to `prefix: "timestamp"`, which names new
 * migrations `<YYYYMMDDHHmmss>_<slug>` and removes that mechanical race.
 *
 * This module is the guard that keeps the convention honest. It is a pure
 * function over the journal's migration tags so it can be unit-tested with
 * synthetic inputs; `migration-naming.test.ts` also runs it against the real
 * committed `drizzle/` folder, so the check executes in CI's unit-test job
 * (`.github/workflows/ci.yml` → `test`) — no separate runner or dependency.
 *
 * What it enforces:
 *  - timestamp-style tags are well-formed (`^[0-9]{14}_[a-z0-9_]+$`);
 *  - no two timestamp migrations share the same second (the one residual
 *    collision the timestamp prefix can still produce);
 *  - every tag matches *either* the legacy index prefix or the timestamp
 *    prefix — anything else (a hand-named or malformed migration) is rejected.
 *
 * Legacy index-prefixed migrations are accepted structurally rather than via a
 * hardcoded allowlist: the `prefix: "timestamp"` config is what prevents *new*
 * index migrations from being generated, and a hardcoded list would re-break
 * CI every time another pre-convention index migration merged to `main` while
 * this guard's PR was open — exactly the coordination tax #133 removes.
 *
 * It is intentionally a test-scoped helper (not `src/`): it never runs at
 * runtime and must not ship in the Docker image.
 */

/** A migration generated under the new timestamp convention. */
const TIMESTAMP_TAG = /^[0-9]{14}_[a-z0-9_]+$/;

/** A migration generated under drizzle-kit's legacy sequential `index` prefix. */
const LEGACY_INDEX_TAG = /^[0-9]{4}_[a-z0-9_]+$/;

/**
 * Validate the naming of every migration tag drawn from `_journal.json`.
 *
 * Returns a list of human-readable violation messages; an empty array means
 * the set is compliant.
 */
export function checkMigrationNaming(journalTags: readonly string[]): string[] {
  const violations: string[] = [];
  const timestampPrefixes = new Map<string, string[]>();

  for (const tag of journalTags) {
    if (TIMESTAMP_TAG.test(tag)) {
      const prefix = tag.slice(0, 14);
      const collisions = timestampPrefixes.get(prefix) ?? [];
      collisions.push(tag);
      timestampPrefixes.set(prefix, collisions);
      continue;
    }
    if (LEGACY_INDEX_TAG.test(tag)) {
      // Grandfathered: an index-prefixed migration that predates the timestamp
      // convention. New ones can't be generated once `prefix: "timestamp"` is
      // set in drizzle.config.ts.
      continue;
    }
    violations.push(
      `migration "${tag}" matches neither the legacy index prefix nor the ` +
        `required <YYYYMMDDHHmmss>_<slug> timestamp convention — generate ` +
        `migrations with \`npm run db:generate\`, never hand-name them (issue #133)`,
    );
  }

  for (const [prefix, tags] of timestampPrefixes) {
    if (tags.length > 1) {
      violations.push(
        `duplicate migration timestamp ${prefix}: ${tags.join(", ")} — two ` +
          `migrations landed in the same second; regenerate one so the ` +
          `timestamp prefixes stay unique`,
      );
    }
  }

  return violations;
}
