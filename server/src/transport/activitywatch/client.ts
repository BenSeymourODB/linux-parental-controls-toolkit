/**
 * REST client for a single client's `aw-server`.
 *
 * The Phase-5 telemetry job (`docs/architecture.md` → "Inbound (client →
 * server)") opens an SSH port-forward to the client's `aw-server`
 * (`localhost:5600`, never network-exposed — #86) and then drives this client
 * against the local end of that forward to pull window/afk events for a
 * polling window. This module only needs the resulting base URL; it never
 * opens the tunnel itself.
 *
 * License boundary: REST-only over HTTP. No ActivityWatch source is linked in
 * process and no GPL binary is added to the image — the integration is purely
 * the documented HTTP API (`CLAUDE.md` → "License boundaries" rule 4;
 * `docs/licensing-analysis.md`).
 */
import { z } from "zod";
import {
  ActivityWatchParseError,
  ActivityWatchRequestError,
  ActivityWatchUnreachableError,
} from "./errors.js";
import {
  awAfkDataSchema,
  awBucketSchema,
  awBucketsResponseSchema,
  awEventSchema,
  awEventsResponseSchema,
  awServerInfoSchema,
  awWindowDataSchema,
  BUCKET_TYPE_AFK,
  BUCKET_TYPE_WINDOW,
  type AwAfkEvent,
  type AwBucket,
  type AwEvent,
  type AwServerInfo,
  type AwWindowEvent,
} from "./schemas.js";

/** Minimal structured-logger seam (a subset of pino's `warn`); default noop. */
export interface ActivityWatchLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const NOOP_LOGGER: ActivityWatchLogger = { warn: () => undefined };

/**
 * The minimal `fetch` surface this client uses. Deliberately structural rather
 * than the full global `typeof fetch`: the Node 22 global `fetch` satisfies it
 * in production, and a test can satisfy it with undici's `fetch` bound to a
 * `MockAgent` dispatcher — without an `as` cast on either side (`CLAUDE.md` →
 * "no unchecked `as` casts").
 */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

/** Options for constructing an {@link ActivityWatchClient}. */
export interface ActivityWatchClientOptions {
  /**
   * Base URL of the `aw-server` REST API, e.g. `http://localhost:5600` — in
   * production the local end of the SSH port-forward (#86). A trailing slash
   * is tolerated.
   */
  baseUrl: string;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /**
   * `fetch` implementation to use. Defaults to the global `fetch`; injectable
   * for dependency injection and deterministic timeout tests.
   */
  fetch?: FetchLike;
  /** Structured logger for skipped-entry warnings. Defaults to a noop. */
  logger?: ActivityWatchLogger;
}

/** Time window for an events query. */
export interface EventQuery {
  /** Pull events at/after this instant. */
  start: Date;
  /** Pull events up to this instant; must not be before {@link start}. */
  end: Date;
  /** Optional cap on the number of events returned (`aw-server` `limit`). */
  limit?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Typed, REST-only client for `aw-server`'s buckets/events/info endpoints.
 *
 * Every method validates the response with a zod schema before returning. The
 * three failure modes are distinguished by the error taxonomy in
 * `./errors.ts`: unreachable (feeds the offline-queue / retry), non-2xx
 * request failure, and malformed response.
 */
export class ActivityWatchClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #logger: ActivityWatchLogger;

  constructor(options: ActivityWatchClientOptions) {
    // Normalize away any trailing slashes so `${baseUrl}${path}` (path starts
    // with `/api/0/...`) never produces a double slash.
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? NOOP_LOGGER;
  }

  /** The normalized base URL this client targets. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** `GET /api/0/info` — server identity and version. */
  async getInfo(): Promise<AwServerInfo> {
    const body = await this.#getJson("/api/0/info");
    return this.#parse(awServerInfoSchema, body, "/api/0/info");
  }

  /**
   * `GET /api/0/buckets/` — all buckets on the server. A bucket entry that
   * fails validation is skipped (and logged) so one malformed bucket doesn't
   * sink the rest; a non-object top-level body is a parse error.
   */
  async listBuckets(): Promise<AwBucket[]> {
    const path = "/api/0/buckets/";
    const body = await this.#getJson(path);
    const record = this.#parse(awBucketsResponseSchema, body, path);

    const buckets: AwBucket[] = [];
    for (const [id, raw] of Object.entries(record)) {
      const parsed = awBucketSchema.safeParse(raw);
      if (parsed.success) {
        buckets.push(parsed.data);
      } else {
        this.#logger.warn(
          { bucketId: id, baseUrl: this.#baseUrl },
          "skipping malformed aw-server bucket",
        );
      }
    }
    return buckets;
  }

  /**
   * `GET /api/0/buckets/{id}/events` for the window — events whose `data`
   * matches `{ start, end }`. The top-level body must be an array (else a parse
   * error); an individual event whose envelope is malformed is skipped+logged.
   */
  async getEvents(bucketId: string, query: EventQuery): Promise<AwEvent[]> {
    this.#assertWindow(query);
    const path = this.#eventsPath(bucketId, query);
    const body = await this.#getJson(path);
    const rawEvents = this.#parse(awEventsResponseSchema, body, path);

    const events: AwEvent[] = [];
    for (const raw of rawEvents) {
      const parsed = awEventSchema.safeParse(raw);
      if (parsed.success) {
        events.push(parsed.data);
      } else {
        this.#logger.warn(
          { bucketId, baseUrl: this.#baseUrl },
          "skipping malformed aw-server event",
        );
      }
    }
    return events;
  }

  /**
   * Window-watcher events for the polling window, with `data` narrowed to
   * `{ app, title }`. Locates every `currentwindow` bucket, pulls its events,
   * and projects each; events whose `data` is not window-shaped are skipped.
   */
  async getWindowEvents(query: EventQuery): Promise<AwWindowEvent[]> {
    const buckets = await this.#bucketsOfType(BUCKET_TYPE_WINDOW);
    const out: AwWindowEvent[] = [];
    for (const bucket of buckets) {
      const events = await this.getEvents(bucket.id, query);
      for (const event of events) {
        const data = awWindowDataSchema.safeParse(event.data);
        if (data.success) {
          out.push({
            bucketId: bucket.id,
            timestamp: event.timestamp,
            durationSeconds: event.duration,
            app: data.data.app,
            title: data.data.title,
          });
        } else {
          this.#logger.warn(
            { bucketId: bucket.id, baseUrl: this.#baseUrl },
            "skipping aw-server event with non-window data",
          );
        }
      }
    }
    return out;
  }

  /**
   * Afk-watcher events for the polling window, with `data` narrowed to
   * `{ status }`. Same discovery/projection contract as
   * {@link getWindowEvents}, over `afkstatus` buckets.
   */
  async getAfkEvents(query: EventQuery): Promise<AwAfkEvent[]> {
    const buckets = await this.#bucketsOfType(BUCKET_TYPE_AFK);
    const out: AwAfkEvent[] = [];
    for (const bucket of buckets) {
      const events = await this.getEvents(bucket.id, query);
      for (const event of events) {
        const data = awAfkDataSchema.safeParse(event.data);
        if (data.success) {
          out.push({
            bucketId: bucket.id,
            timestamp: event.timestamp,
            durationSeconds: event.duration,
            status: data.data.status,
          });
        } else {
          this.#logger.warn(
            { bucketId: bucket.id, baseUrl: this.#baseUrl },
            "skipping aw-server event with non-afk data",
          );
        }
      }
    }
    return out;
  }

  /** Buckets whose `type` matches, via {@link listBuckets}. */
  async #bucketsOfType(type: string): Promise<AwBucket[]> {
    const buckets = await this.listBuckets();
    return buckets.filter((bucket) => bucket.type === type);
  }

  /** Build the `events` path with windowed query params. */
  #eventsPath(bucketId: string, query: EventQuery): string {
    const params = new URLSearchParams({
      start: query.start.toISOString(),
      end: query.end.toISOString(),
    });
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    return `/api/0/buckets/${encodeURIComponent(bucketId)}/events?${params.toString()}`;
  }

  /** Reject an inverted window before issuing a request. */
  #assertWindow(query: EventQuery): void {
    if (query.end.getTime() < query.start.getTime()) {
      throw new RangeError(
        `EventQuery.end (${query.end.toISOString()}) is before start (${query.start.toISOString()})`,
      );
    }
  }

  /**
   * Issue a GET and return the parsed JSON body, mapping every failure to the
   * error taxonomy: a thrown `fetch` (connection error / abort timeout) →
   * unreachable; a non-2xx status → request error; a non-JSON body → parse
   * error.
   */
  async #getJson(path: string): Promise<unknown> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new ActivityWatchUnreachableError(this.#baseUrl, path, cause, isTimeout(cause));
    }

    if (!response.ok) {
      throw new ActivityWatchRequestError(
        this.#baseUrl,
        path,
        response.status,
        response.statusText,
      );
    }

    try {
      return (await response.json()) as unknown;
    } catch (cause) {
      throw new ActivityWatchParseError(
        this.#baseUrl,
        path,
        cause instanceof Error ? cause.message : "response body was not valid JSON",
      );
    }
  }

  /** Validate a body against `schema`, throwing a parse error on mismatch. */
  #parse<T>(schema: z.ZodType<T>, body: unknown, path: string): T {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new ActivityWatchParseError(
        this.#baseUrl,
        path,
        z.prettifyError(result.error),
        result.error,
      );
    }
    return result.data;
  }
}

/**
 * Whether a thrown `fetch` error is the per-request abort timeout.
 * `AbortSignal.timeout` rejects with a `TimeoutError`; a manual abort yields an
 * `AbortError`. Both are name-tagged on the thrown `DOMException`/`Error`.
 */
function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}
