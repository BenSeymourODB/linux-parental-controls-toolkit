/**
 * zod schemas for the `aw-server` REST responses this client consumes.
 *
 * Everything `aw-server` returns is untrusted external input and is validated
 * here before it crosses into typed code (`CLAUDE.md` → "Validate all external
 * input"). We validate only the fields the dashboard actually uses; zod strips
 * unknown keys by default, so ActivityWatch adding or renaming fields we don't
 * read never breaks us.
 *
 * Normalisation of these events into `UsageSample` rows (dedup of clock-skew
 * overlaps, dropping future-timestamped events, aggregation) is deliberately
 * NOT here — that is #88. This module only shapes and types the raw API.
 */
import { z } from "zod";

/**
 * An ISO-8601 timestamp string from `aw-server`, parsed to a `Date`. AW emits
 * offset-qualified timestamps (`…Z` or `…+00:00`); we accept anything
 * `Date.parse` understands and reject only genuinely unparseable values so a
 * corrupt timestamp surfaces as a parse error rather than an `Invalid Date`.
 */
const awTimestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "not a parseable ISO-8601 timestamp",
  })
  .transform((value) => new Date(value));

/** `GET /api/0/info` — server identity and version. */
export const awServerInfoSchema = z.object({
  hostname: z.string(),
  version: z.string(),
  testing: z.boolean(),
  device_id: z.string().optional(),
});

/** Inferred `aw-server` info. */
export type AwServerInfo = z.infer<typeof awServerInfoSchema>;

/**
 * One bucket's metadata. `type` is the watcher discriminator we filter on
 * (`currentwindow` for the window watcher, `afkstatus` for the afk watcher);
 * `name`/`last_updated` are nullable in practice and unused beyond display.
 */
export const awBucketSchema = z.object({
  id: z.string(),
  created: awTimestamp,
  name: z.string().nullable().optional(),
  type: z.string(),
  client: z.string(),
  hostname: z.string(),
  last_updated: awTimestamp.nullable().optional(),
});

/** Inferred bucket metadata. */
export type AwBucket = z.infer<typeof awBucketSchema>;

/**
 * `GET /api/0/buckets/` returns an object keyed by bucket id. The top-level
 * shape must be an object of unknown values; each entry is validated
 * individually by the client so one malformed bucket doesn't sink the rest.
 */
export const awBucketsResponseSchema = z.record(z.string(), z.unknown());

/**
 * One event from `GET /api/0/buckets/{id}/events`. `duration` is in seconds
 * (a float). `data` is left as an opaque record here; the watcher-specific
 * shape is applied per event by {@link awWindowDataSchema} /
 * {@link awAfkDataSchema} so a stray non-conforming event can be skipped
 * rather than failing the whole pull.
 */
export const awEventSchema = z.object({
  id: z.number().optional(),
  timestamp: awTimestamp,
  duration: z.number().nonnegative(),
  data: z.record(z.string(), z.unknown()),
});

/** Inferred generic event (untyped `data`). */
export type AwEvent = z.infer<typeof awEventSchema>;

/** `GET /api/0/buckets/{id}/events` — the response is a JSON array of events. */
export const awEventsResponseSchema = z.array(z.unknown());

/** `data` for an `aw-watcher-window` event. */
export const awWindowDataSchema = z.object({
  app: z.string(),
  title: z.string(),
});

/** `data` for an `aw-watcher-afk` event. */
export const awAfkDataSchema = z.object({
  status: z.enum(["afk", "not-afk"]),
});

/** AW bucket `type` for the window watcher. */
export const BUCKET_TYPE_WINDOW = "currentwindow";
/** AW bucket `type` for the afk watcher. */
export const BUCKET_TYPE_AFK = "afkstatus";

/** A window event with `data` narrowed to `{ app, title }`. */
export interface AwWindowEvent {
  /** The bucket this event came from (a client may host more than one). */
  bucketId: string;
  /** Event start, in UTC. */
  timestamp: Date;
  /** Event duration in seconds. */
  durationSeconds: number;
  /** Foreground application identifier reported by the watcher. */
  app: string;
  /** Foreground window title reported by the watcher. */
  title: string;
}

/** An afk event with `data` narrowed to `{ status }`. */
export interface AwAfkEvent {
  /** The bucket this event came from. */
  bucketId: string;
  /** Event start, in UTC. */
  timestamp: Date;
  /** Event duration in seconds. */
  durationSeconds: number;
  /** Whether the user was away-from-keyboard for this interval. */
  status: "afk" | "not-afk";
}
