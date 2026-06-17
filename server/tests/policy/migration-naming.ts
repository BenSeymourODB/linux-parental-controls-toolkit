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
 * It is intentionally a test-scoped helper (not `src/`): it never runs at
 * runtime and must not ship in the Docker image.
 */

/** A migration generated under the new timestamp convention. */
const TIMESTAMP_TAG = /^[0-9]{14}_[a-z0-9_]+$/;

/** A migration generated under drizzle-kit's legacy sequential `index` prefix. */
const LEGACY_INDEX_TAG = /^[0-9]{4}_[a-z0-9_]+$/;

/**
 * The index-prefixed migrations that predate the timestamp convention (#133).
 * They are grandfathered in; every migration generated afterwards must use the
 * timestamp prefix. Drizzle orders migrations by the journal's `idx`/`when`, so
 * the mixed prefixes coexist without any reordering.
 */
export const GRANDFATHERED_INDEX_TAGS: readonly string[] = [
  "0000_broad_slapstick",
  "0001_sparkling_talkback",
];

/**
 * Validate the naming of every migration tag drawn from `_journal.json`.
 *
 * Returns a list of human-readable violation messages; an empty array means
 * the set is compliant. A tag is compliant when it is either grandfathered
 * (see {@link GRANDFATHERED_INDEX_TAGS}) or matches the timestamp convention
 * `^[0-9]{14}_[a-z0-9_]+$`. Two timestamp migrations that share the same
 * 14-digit second are also reported, since that is the one residual collision
 * the timestamp prefix can still produce.
 */
export function checkMigrationNaming(journalTags: readonly string[]): string[] {
  const violations: string[] = [];
  const grandfathered = new Set(GRANDFATHERED_INDEX_TAGS);
  const timestampPrefixes = new Map<string, string[]>();

  for (const tag of journalTags) {
    if (TIMESTAMP_TAG.test(tag)) {
      const prefix = tag.slice(0, 14);
      const collisions = timestampPrefixes.get(prefix) ?? [];
      collisions.push(tag);
      timestampPrefixes.set(prefix, collisions);
      continue;
    }
    if (grandfathered.has(tag)) {
      continue;
    }
    if (LEGACY_INDEX_TAG.test(tag)) {
      violations.push(
        `migration "${tag}" uses the legacy sequential index prefix; new ` +
          `migrations must use the timestamp prefix — see drizzle.config.ts ` +
          `(\`migrations: { prefix: "timestamp" }\`) and issue #133`,
      );
    } else {
      violations.push(
        `migration "${tag}" does not match the required ` +
          `<YYYYMMDDHHmmss>_<slug> naming convention (issue #133)`,
      );
    }
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
