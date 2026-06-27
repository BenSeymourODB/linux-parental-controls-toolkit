/**
 * Retention policy model and pure resolution helpers (#136, epic #135).
 *
 * Retention answers one question per dated record: "is this old enough to
 * purge?" The *rule* lives here, in one place, so the scheduled purge job
 * (#137) and the per-entity purge coverage (#138) never re-implement the
 * age comparison or the "keep forever" escape hatch.
 *
 * The configuration has two layers:
 *
 * - a **global default window** (`DEFAULT_RETENTION_DAYS`, 365), env-overridable
 *   via `PCT_RETENTION_DEFAULT_DAYS` (see `config.ts`), and
 * - optional **per-category overrides** persisted in the policy store
 *   (`retention_overrides`), each either a custom positive day count or
 *   "keep forever".
 *
 * A category with no override inherits the default. Everything is compared in
 * UTC (`docs/adr/0001-budget-timezone.md`): the stored timestamps are
 * offset-free epoch seconds, and `now`/the record instant are `Date`s, so the
 * age comparison is a plain millisecond subtraction with no timezone surface.
 *
 * License boundary: none touched — pure TypeScript, no I/O, no GPL linkage.
 */
import { retentionCategoryValues, type RetentionCategory } from "./enums.js";

/** The conservative default retention window: keep one year of dated data. */
export const DEFAULT_RETENTION_DAYS = 365;

/**
 * Upper bound on a configurable window (~100 years). A sanity cap, not a
 * policy: anyone who wants "effectively forever" should pick the explicit
 * `keepForever` mode rather than a giant day count, so the API rejects
 * absurd values rather than silently storing them.
 */
export const MAX_RETENTION_DAYS = 36_525;

/** Milliseconds in a day — the unit the age comparison works in. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A resolved retention rule for a single category: either keep matching rows
 * forever, or purge anything strictly older than `days`.
 */
export type ResolvedRetention = { keepForever: true } | { keepForever: false; days: number };

/**
 * A per-category override as persisted: `keepForever` xor a positive `days`.
 * `days` is `null` exactly when `keepForever` is true (the storage CHECK and
 * {@link overrideToResolved} both enforce this coherence).
 */
export interface RetentionOverride {
  category: RetentionCategory;
  keepForever: boolean;
  days: number | null;
}

/** Thrown when a persisted/override pair violates the keepForever⊕days coherence. */
export class RetentionOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionOverrideError";
  }
}

/**
 * Map a stored override row to a {@link ResolvedRetention}, validating the
 * coherence the storage CHECK also guards. Defensive: a row that somehow
 * carries `keepForever=false` with a null/non-positive `days` is a bug, not a
 * silent "keep forever".
 */
export function overrideToResolved(override: RetentionOverride): ResolvedRetention {
  if (override.keepForever) {
    return { keepForever: true };
  }
  if (override.days === null || override.days <= 0) {
    throw new RetentionOverrideError(
      `retention override for ${override.category} must carry a positive day count when not keepForever`,
    );
  }
  return { keepForever: false, days: override.days };
}

/**
 * Resolve the effective retention for one category from the default window and
 * the set of overrides. A category absent from `overrides` inherits the
 * default; the default is always a finite day count (the global "keep forever"
 * choice is expressed per-category, not as a default).
 */
export function resolveRetention(
  category: RetentionCategory,
  defaultDays: number,
  overrides: ReadonlyMap<RetentionCategory, ResolvedRetention>,
): ResolvedRetention {
  return overrides.get(category) ?? { keepForever: false, days: defaultDays };
}

/**
 * Is a record with the given timestamp expired under `retention` as of `now`?
 *
 * "Older than the window" means a strictly-greater age: a record exactly
 * `days` old is still within its window and retained; one a millisecond older
 * is expired. `keepForever` never expires. The comparison is monotonic in
 * `recordTimestamp`, so the purge job can use it as a cutoff predicate.
 */
export function isExpired(recordTimestamp: Date, retention: ResolvedRetention, now: Date): boolean {
  if (retention.keepForever) {
    return false;
  }
  const ageMs = now.getTime() - recordTimestamp.getTime();
  return ageMs > retention.days * MS_PER_DAY;
}

/**
 * The fully-resolved retention configuration: the global default plus every
 * per-category override, with the resolution rule and the {@link isExpired}
 * predicate bound together so callers (the purge job, the API serialiser)
 * read one object instead of threading the default + overrides everywhere.
 *
 * Build it from the env default and the persisted overrides via
 * {@link fromOverrides}; it is an immutable snapshot — rebuild it when the
 * overrides change rather than mutating it.
 */
export class RetentionPolicy {
  private readonly overrides: ReadonlyMap<RetentionCategory, ResolvedRetention>;

  constructor(
    /** The global default window (days) for categories without an override. */
    readonly defaultDays: number,
    overrides: ReadonlyMap<RetentionCategory, ResolvedRetention>,
  ) {
    this.overrides = overrides;
  }

  /**
   * Build a policy from the env default and the persisted override rows,
   * mapping each row through {@link overrideToResolved} (so a corrupt row
   * fails loudly rather than defaulting to "keep forever").
   */
  static fromOverrides(defaultDays: number, rows: readonly RetentionOverride[]): RetentionPolicy {
    const resolved = new Map<RetentionCategory, ResolvedRetention>();
    for (const row of rows) {
      resolved.set(row.category, overrideToResolved(row));
    }
    return new RetentionPolicy(defaultDays, resolved);
  }

  /** The effective retention for one category (override, else the default). */
  forCategory(category: RetentionCategory): ResolvedRetention {
    return resolveRetention(category, this.defaultDays, this.overrides);
  }

  /** Does this category have an explicit override, or is it inheriting the default? */
  hasOverride(category: RetentionCategory): boolean {
    return this.overrides.has(category);
  }

  /**
   * Is a record in `category` with the given timestamp expired as of `now`?
   * The one-stop predicate the purge job calls per row.
   */
  isExpired(category: RetentionCategory, recordTimestamp: Date, now: Date): boolean {
    return isExpired(recordTimestamp, this.forCategory(category), now);
  }

  /** The resolved retention for every known category, in declaration order. */
  resolveAll(): {
    category: RetentionCategory;
    retention: ResolvedRetention;
    isOverride: boolean;
  }[] {
    return retentionCategoryValues.map((category) => ({
      category,
      retention: this.forCategory(category),
      isOverride: this.hasOverride(category),
    }));
  }
}
