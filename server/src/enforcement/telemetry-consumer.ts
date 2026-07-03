/**
 * The live telemetry consumer (#88's deferred "wire the normaliser into the
 * scheduled pull" step, turned on by #327).
 *
 * `scheduleTelemetryPull` (#162) opens a loopback SSH port-forward to each
 * client's `aw-server` and hands a base URL to a {@link TelemetryConsumer}.
 * Today that seam defaults to a liveness probe; this module supplies the real
 * consumer: for the tunnelled client it fetches window + afk events, normalises
 * them against the policy's `Activity` matchers ({@link normaliseWindowEvents},
 * #88), and appends the resulting `UsageSample` rows ({@link insertUsageSamples})
 * — the rollups the Phase-8 enforcement sweep then reads.
 *
 * **Pull window / cursor.** `usage_samples` is a plain append with no
 * uniqueness constraint and there is no durable pull cursor yet (#162 deferred
 * it). To keep overlapping passes from double-counting, this consumer holds an
 * in-memory per-client cursor of the last successfully-pulled window `end`:
 * each pass queries `[cursor ?? (passEnd − initialLookback), passEnd]` and, only
 * after a successful insert, advances the cursor to `passEnd`. The cursor does
 * not survive a restart — a durable cursor is tracked as a follow-up — so a
 * restart re-pulls at most `initialLookback`. Missing telemetry credits no
 * consumption (#88), so any gap is non-punitive.
 *
 * **Single supervised user per client (Alpha-1).** `aw-server` binds one OS
 * account's activity on `:5600`; the loopback tunnel can't disambiguate several
 * accounts on one client. A client linked to exactly one supervised user is
 * attributed; zero → skipped; more than one → skipped with a warning (matching
 * the per-client single-verdict decision in the AW health probe). True
 * multi-user-per-client attribution (per-user `aw-server` ports) is deferred.
 *
 * License boundary: `aw-server` is reached only over its REST API through the
 * server-initiated loopback SSH tunnel; no ActivityWatch source is linked
 * in-process and no GPL binary is added to the image.
 */
import { eq } from "drizzle-orm";

import type { PolicyDb } from "../policy/db.js";
import { activities, usersOnClients } from "../policy/schema.js";
import { insertUsageSamples } from "../policy/usage.js";
import type {
  ActivityMatcher,
  UsageSampleCandidate,
} from "../transport/activitywatch/normalise.js";
import { normaliseWindowEvents } from "../transport/activitywatch/normalise.js";
import { ActivityWatchClient } from "../transport/activitywatch/client.js";
import type { EventQuery } from "../transport/activitywatch/client.js";
import type { AwAfkEvent, AwWindowEvent } from "../transport/activitywatch/schemas.js";
import type {
  TelemetryConsumeContext,
  TelemetryConsumer,
  TelemetryLogger,
} from "../transport/activitywatch/telemetry.js";

/**
 * The `aw-server` event surface this consumer reads — the REST-only slice of
 * {@link ActivityWatchClient}. Injectable so the consumer unit-tests without a
 * live `aw-server` or a real port-forward.
 */
export interface AwEventSource {
  getWindowEvents(query: EventQuery): Promise<AwWindowEvent[]>;
  getAfkEvents(query: EventQuery): Promise<AwAfkEvent[]>;
}

/** Builds an {@link AwEventSource} for a tunnelled base URL. */
export type AwEventSourceFactory = (baseUrl: string, logger: TelemetryLogger) => AwEventSource;

/** Construction options for {@link createUsageTelemetryConsumer}. */
export interface UsageTelemetryConsumerOptions {
  /** Policy store: reads the client's users + activity matchers, writes samples. */
  readonly db: PolicyDb;
  /**
   * In-memory per-client cursor (last successfully-pulled window `end`), keyed
   * by `clientId`. Owned by the caller so it persists across passes; mutated
   * here only after a successful insert.
   */
  readonly cursor: Map<number, Date>;
  /**
   * The instant a pass rolls up to (the window `end`). Read per client so every
   * client in one pass shares the same boundary; the pipeline updates it once
   * per pass before {@link import("../transport/activitywatch/telemetry.js").runTelemetryPull}.
   */
  readonly passEnd: () => Date;
  /** How far back a client's first pull reaches when it has no cursor yet (ms). */
  readonly initialLookbackMs: number;
  /**
   * Builds the AW event source for a tunnelled base URL. Defaults to a real
   * {@link ActivityWatchClient}; tests inject a fake.
   */
  readonly createSource?: AwEventSourceFactory;
}

/** The window-resolvable activity matchers (a row subset the normaliser needs). */
function loadActivityMatchers(db: PolicyDb): ActivityMatcher[] {
  return db
    .select({
      id: activities.id,
      kind: activities.kind,
      matcher: activities.matcher,
      matchType: activities.matchType,
    })
    .from(activities)
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      matcher: row.matcher,
      matchType: row.matchType ?? undefined,
    }));
}

/**
 * Clip each normalised sample to the half-open pull window `[start, end)`,
 * dropping any that collapse to empty. This bounds a sample to the window the
 * cursor advances over, so an `aw-server` that returns an event intersecting
 * (rather than clipped to) the window can't have that event re-credited whole
 * in the next overlapping pull.
 */
function clipToWindow(
  samples: readonly UsageSampleCandidate[],
  start: Date,
  end: Date,
): UsageSampleCandidate[] {
  const lo = start.getTime();
  const hi = end.getTime();
  const clipped: UsageSampleCandidate[] = [];
  for (const sample of samples) {
    const startedAt = Math.max(sample.startedAt.getTime(), lo);
    const endedAt = Math.min(sample.endedAt.getTime(), hi);
    if (endedAt > startedAt) {
      clipped.push({ ...sample, startedAt: new Date(startedAt), endedAt: new Date(endedAt) });
    }
  }
  return clipped;
}

/** The supervised users linked to a client (ids only). */
function loadClientUserIds(db: PolicyDb, clientId: number): number[] {
  return db
    .select({ userId: usersOnClients.userId })
    .from(usersOnClients)
    .where(eq(usersOnClients.clientId, clientId))
    .all()
    .map((row) => row.userId);
}

/**
 * Build the live {@link TelemetryConsumer}: normalise a tunnelled client's AW
 * events into `UsageSample` rows. Returned as the `consume` seam handed to
 * {@link import("../transport/activitywatch/telemetry.js").runTelemetryPull}.
 */
export function createUsageTelemetryConsumer(
  options: UsageTelemetryConsumerOptions,
): TelemetryConsumer {
  const { db, cursor, passEnd, initialLookbackMs } = options;
  const createSource: AwEventSourceFactory =
    options.createSource ?? ((baseUrl, logger) => new ActivityWatchClient({ baseUrl, logger }));

  return async function consume(context: TelemetryConsumeContext): Promise<void> {
    const { client, baseUrl, logger } = context;

    const userIds = loadClientUserIds(db, client.id);
    if (userIds.length === 0) {
      // No supervised user to attribute this client's usage to — nothing to do.
      logger.info(
        { clientId: client.id, hostname: client.hostname },
        "telemetry: client has no supervised user; skipping usage normalisation",
      );
      return;
    }
    if (userIds.length > 1) {
      // A single-tunnel per-client pull can't disambiguate several OS accounts'
      // aw-server instances; attributing to any one would be wrong. Deferred.
      logger.warn(
        { clientId: client.id, hostname: client.hostname, userCount: userIds.length },
        "telemetry: multi-user client not yet supported for per-user attribution; skipping",
      );
      return;
    }
    const userId = userIds[0];
    // The length guards above leave exactly one id; this narrows away the
    // `noUncheckedIndexedAccess` `undefined` without a cast.
    if (userId === undefined) return;

    const end = passEnd();
    const start = cursor.get(client.id) ?? new Date(end.getTime() - initialLookbackMs);
    if (start.getTime() >= end.getTime()) {
      // Cursor already at/after this pass instant (e.g. clock skew or a very
      // fast re-tick): nothing new to pull.
      return;
    }

    const query: EventQuery = { start, end };
    const source = createSource(baseUrl, logger);
    const windowEvents = await source.getWindowEvents(query);
    const afkEvents = await source.getAfkEvents(query);

    const candidates = normaliseWindowEvents({
      userId,
      clientId: client.id,
      windowEvents,
      afkEvents,
      activities: loadActivityMatchers(db),
      now: end,
    });
    // Clip each credited interval to this pass's `[start, end)` window before
    // persisting. `aw-server`'s events query returns events that *intersect* the
    // window without clipping them, so a long event (e.g. a 20-min focus) is
    // returned in every overlapping pull; crediting it whole each pass would
    // over-count it across consecutive windows → punitive over-enforcement.
    // Clipping makes consecutive windows tile disjointly regardless of the exact
    // server-side filtering, so the cursor's no-double-count guarantee does not
    // hinge on an unverified aw-server semantic. (Under a stricter start-time
    // filter this can only under-credit an event's out-of-window tail — bounded
    // and non-punitive per #88 — never over-credit.)
    const inserted = insertUsageSamples(db, clipToWindow(candidates, start, end));

    // Advance the cursor after a successful pull (regardless of row count, so a
    // clean pull that matched nothing still moves forward). A mid-pull failure
    // throws and is isolated by runTelemetryPull, leaving the cursor unmoved so
    // the same window is re-pulled next pass rather than skipped.
    cursor.set(client.id, end);

    logger.info(
      {
        clientId: client.id,
        hostname: client.hostname,
        userId,
        windowEvents: windowEvents.length,
        afkEvents: afkEvents.length,
        samples: inserted,
      },
      "telemetry: normalised usage samples for client",
    );
  };
}
