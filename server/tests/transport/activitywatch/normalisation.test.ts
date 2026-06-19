/**
 * Unit tests for the ActivityWatch → `UsageSample` normaliser (#88).
 *
 * Pure transform, so no DB or live `aw-server`: events are hand-built and the
 * resulting candidates asserted directly. Covers the `docs/testing.md` →
 * "Transport — REST → normalisation" checklist (correct interval + app
 * resolution, clock-skew overlap dedup, future-timestamp drop, empty → empty,
 * matcher resolution) plus afk clipping and per-activity merge semantics.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FUTURE_TOLERANCE_SECONDS,
  normaliseWindowEvents,
  type ActivityMatcher,
  type NormaliseUsageInput,
} from "../../../src/transport/activitywatch/normalise.js";
import type { AwAfkEvent, AwWindowEvent } from "../../../src/transport/activitywatch/schemas.js";

const NOW = new Date("2024-03-10T12:00:00.000Z");

/** A kind=`app` activity matcher. */
function appActivity(id: number, matcher: string): ActivityMatcher {
  return { id, kind: "app", matcher };
}

function windowEvent(app: string, isoStart: string, durationSeconds: number): AwWindowEvent {
  return {
    bucketId: "aw-watcher-window_host",
    timestamp: new Date(isoStart),
    durationSeconds,
    app,
    title: `${app} — a window`,
  };
}

function afkEvent(
  status: "afk" | "not-afk",
  isoStart: string,
  durationSeconds: number,
): AwAfkEvent {
  return {
    bucketId: "aw-watcher-afk_host",
    timestamp: new Date(isoStart),
    durationSeconds,
    status,
  };
}

/** Base input with the common user/client/now wiring filled in. */
function input(overrides: Partial<NormaliseUsageInput>): NormaliseUsageInput {
  return {
    userId: 1,
    clientId: 2,
    windowEvents: [],
    activities: [],
    now: NOW,
    ...overrides,
  };
}

describe("normaliseWindowEvents", () => {
  it("maps a matched window event to a usage-sample candidate with the right interval", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.000Z", 600)],
        activities: [appActivity(7, "firefox")],
      }),
    );

    expect(result).toEqual([
      {
        userId: 1,
        clientId: 2,
        activityId: 7,
        startedAt: new Date("2024-03-10T11:00:00.000Z"),
        endedAt: new Date("2024-03-10T11:10:00.000Z"),
      },
    ]);
  });

  it("resolves the app matcher case-insensitively", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("FireFox", "2024-03-10T11:00:00.000Z", 60)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([expect.objectContaining({ activityId: 7 })]);
  });

  it("drops events whose app matches no activity (never fabricates an activity)", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("solitaire", "2024-03-10T11:00:00.000Z", 600)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([]);
  });

  it("ignores non-app-kind activities when resolving window events", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.000Z", 600)],
        activities: [
          { id: 5, kind: "domain", matcher: "firefox" },
          { id: 6, kind: "app_group", matcher: "firefox" },
        ],
      }),
    );
    expect(result).toEqual([]);
  });

  it("drops zero-duration events (empty interval)", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.000Z", 0)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([]);
  });

  it("accepts an event ≤ tolerance into the future but drops one beyond it", () => {
    const justInside = new Date(NOW.getTime() + (DEFAULT_FUTURE_TOLERANCE_SECONDS - 1) * 1000);
    const wayAhead = new Date(NOW.getTime() + (DEFAULT_FUTURE_TOLERANCE_SECONDS + 5) * 1000);

    const accepted = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", justInside.toISOString(), 30)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(accepted).toHaveLength(1);

    const dropped = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", wayAhead.toISOString(), 30)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(dropped).toEqual([]);
  });

  it("clamps the end of an in-tolerance event with a corrupt huge duration to the cutoff", () => {
    // Starts at `now`, but claims a 1-day duration; the credited end must not
    // run past now + tolerance.
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", NOW.toISOString(), 86_400)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toHaveLength(1);
    const cutoff = new Date(NOW.getTime() + DEFAULT_FUTURE_TOLERANCE_SECONDS * 1000);
    expect(result[0]?.endedAt).toEqual(cutoff);
  });

  it("drops an event whose start sits exactly at the future cutoff (end clamps to empty)", () => {
    const atCutoff = new Date(NOW.getTime() + DEFAULT_FUTURE_TOLERANCE_SECONDS * 1000);
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", atCutoff.toISOString(), 30)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([]);
  });

  it("drops a sub-second event that floors to a zero-width interval", () => {
    const result = normaliseWindowEvents(
      input({
        // 11:00:00.200 for 0.5s → 11:00:00.700; both floor to 11:00:00 → empty.
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.200Z", 0.5)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([]);
  });

  it("floors interval boundaries to whole seconds (usage_samples is second-granular)", () => {
    const result = normaliseWindowEvents(
      input({
        // 11:00:00.500 for 600.7s → 11:10:01.200; both floor to whole seconds.
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.500Z", 600.7)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([
      {
        userId: 1,
        clientId: 2,
        activityId: 7,
        startedAt: new Date("2024-03-10T11:00:00.000Z"),
        endedAt: new Date("2024-03-10T11:10:01.000Z"),
      },
    ]);
  });

  it("does not extend the merged interval for an event fully contained in another", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [
          windowEvent("firefox", "2024-03-10T11:00:00.000Z", 1200), // 11:00–11:20
          windowEvent("firefox", "2024-03-10T11:05:00.000Z", 300), // 11:05–11:10 (inside)
        ],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([
      {
        userId: 1,
        clientId: 2,
        activityId: 7,
        startedAt: new Date("2024-03-10T11:00:00.000Z"),
        endedAt: new Date("2024-03-10T11:20:00.000Z"),
      },
    ]);
  });

  it("merges overlapping events for the same activity (clock-skew dedup)", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [
          windowEvent("firefox", "2024-03-10T11:00:00.000Z", 600), // 11:00–11:10
          windowEvent("firefox", "2024-03-10T11:05:00.000Z", 600), // 11:05–11:15 (overlap)
        ],
        activities: [appActivity(7, "firefox")],
      }),
    );

    expect(result).toEqual([
      {
        userId: 1,
        clientId: 2,
        activityId: 7,
        startedAt: new Date("2024-03-10T11:00:00.000Z"),
        endedAt: new Date("2024-03-10T11:15:00.000Z"),
      },
    ]);
  });

  it("merges back-to-back (adjacent) intervals into one tiling interval", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [
          windowEvent("firefox", "2024-03-10T11:00:00.000Z", 300), // 11:00–11:05
          windowEvent("firefox", "2024-03-10T11:05:00.000Z", 300), // 11:05–11:10
        ],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({ endedAt: new Date("2024-03-10T11:10:00.000Z") }),
    ]);
  });

  it("keeps distinct activities separate even when their intervals overlap", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [
          windowEvent("firefox", "2024-03-10T11:00:00.000Z", 600),
          windowEvent("code", "2024-03-10T11:05:00.000Z", 600),
        ],
        activities: [appActivity(7, "firefox"), appActivity(9, "code")],
      }),
    );
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.activityId)).toEqual([7, 9]);
  });

  it("clips credited time to not-afk intervals when afk telemetry is present", () => {
    // Foreground firefox 11:00–11:30, but the user was afk 11:10–11:20.
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.000Z", 1800)],
        afkEvents: [
          afkEvent("not-afk", "2024-03-10T11:00:00.000Z", 600), // 11:00–11:10
          afkEvent("afk", "2024-03-10T11:10:00.000Z", 600), // 11:10–11:20
          afkEvent("not-afk", "2024-03-10T11:20:00.000Z", 600), // 11:20–11:30
        ],
        activities: [appActivity(7, "firefox")],
      }),
    );

    expect(result).toEqual([
      {
        userId: 1,
        clientId: 2,
        activityId: 7,
        startedAt: new Date("2024-03-10T11:00:00.000Z"),
        endedAt: new Date("2024-03-10T11:10:00.000Z"),
      },
      {
        userId: 1,
        clientId: 2,
        activityId: 7,
        startedAt: new Date("2024-03-10T11:20:00.000Z"),
        endedAt: new Date("2024-03-10T11:30:00.000Z"),
      },
    ]);
  });

  it("credits nothing when afk telemetry shows the whole interval was afk", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.000Z", 600)],
        afkEvents: [afkEvent("afk", "2024-03-10T11:00:00.000Z", 600)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([]);
  });

  it("ignores not-afk intervals entirely before or after the candidate window", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.000Z", 600)], // 11:00–11:10
        afkEvents: [
          afkEvent("not-afk", "2024-03-10T10:00:00.000Z", 1800), // 10:00–10:30 (before → skipped)
          afkEvent("not-afk", "2024-03-10T11:00:00.000Z", 600), // 11:00–11:10 (overlap)
          afkEvent("not-afk", "2024-03-10T12:00:00.000Z", 1800), // 12:00–12:30 (after → break)
        ],
        activities: [appActivity(7, "firefox")],
      }),
    );

    expect(result).toEqual([
      expect.objectContaining({
        startedAt: new Date("2024-03-10T11:00:00.000Z"),
        endedAt: new Date("2024-03-10T11:10:00.000Z"),
      }),
    ]);
  });

  it("does not clip when afk telemetry is absent (missing telemetry is not punitive)", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.000Z", 600)],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({ endedAt: new Date("2024-03-10T11:10:00.000Z") }),
    ]);
  });

  it("does not clip when an empty afk array is supplied (no information)", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.000Z", 600)],
        afkEvents: [],
        activities: [appActivity(7, "firefox")],
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({ endedAt: new Date("2024-03-10T11:10:00.000Z") }),
    ]);
  });

  it("resolves a duplicated (case-folded) matcher to the lowest activity id deterministically", () => {
    const result = normaliseWindowEvents(
      input({
        windowEvents: [windowEvent("firefox", "2024-03-10T11:00:00.000Z", 60)],
        activities: [appActivity(20, "Firefox"), appActivity(8, "firefox")],
      }),
    );
    expect(result).toEqual([expect.objectContaining({ activityId: 8 })]);
  });

  it("returns an empty list for no events", () => {
    expect(normaliseWindowEvents(input({ activities: [appActivity(7, "firefox")] }))).toEqual([]);
  });
});
