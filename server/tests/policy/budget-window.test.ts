/**
 * Shared budget-window helper.
 *
 * Covers the local-calendar boundary math (daily / weekly / monthly across
 * DST transitions) and the mid-window timezone-change pin rule from
 * `docs/adr/0003-mid-window-timezone-change.md`.
 */
import { describe, expect, it } from "vitest";
import {
  assertTimeZone,
  effectiveWindow,
  InvalidTimeZoneError,
  isValidTimeZone,
  resolveEffectiveTz,
  windowContaining,
} from "../../src/policy/budget-window.js";

/** ISO-8601 of a Date, for readable boundary assertions. */
const iso = (d: Date): string => d.toISOString();

describe("isValidTimeZone / assertTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
  });

  it("rejects unknown zones and the empty string", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("not a zone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("assertTimeZone throws InvalidTimeZoneError for a bad zone", () => {
    expect(() => assertTimeZone("Nowhere/Nope")).toThrow(InvalidTimeZoneError);
    expect(() => assertTimeZone("Nowhere/Nope")).toThrow(/Invalid IANA timezone/);
  });

  it("assertTimeZone is a no-op for a good zone", () => {
    expect(() => assertTimeZone("Europe/London")).not.toThrow();
  });
});

describe("resolveEffectiveTz", () => {
  it("uses the user's tz when set", () => {
    expect(resolveEffectiveTz("America/Los_Angeles", "UTC")).toBe("America/Los_Angeles");
  });

  it("falls back to the default for null/undefined", () => {
    expect(resolveEffectiveTz(null, "America/New_York")).toBe("America/New_York");
    expect(resolveEffectiveTz(undefined, "America/New_York")).toBe("America/New_York");
  });
});

describe("windowContaining", () => {
  it("rejects an invalid timezone", () => {
    expect(() => windowContaining("daily", new Date("2024-01-15T12:00:00Z"), "Bad/Zone")).toThrow(
      InvalidTimeZoneError,
    );
  });

  describe("daily (UTC)", () => {
    it("spans local midnight to the next local midnight", () => {
      const w = windowContaining("daily", new Date("2024-06-15T12:00:00Z"), "UTC");
      expect(iso(w.start)).toBe("2024-06-15T00:00:00.000Z");
      expect(iso(w.end)).toBe("2024-06-16T00:00:00.000Z");
      expect(w.tz).toBe("UTC");
    });

    it("is inclusive of its start instant", () => {
      const w = windowContaining("daily", new Date("2024-06-15T00:00:00Z"), "UTC");
      expect(iso(w.start)).toBe("2024-06-15T00:00:00.000Z");
    });

    it("includes the last instant before the next boundary", () => {
      const w = windowContaining("daily", new Date("2024-06-15T23:59:59Z"), "UTC");
      expect(iso(w.start)).toBe("2024-06-15T00:00:00.000Z");
      expect(iso(w.end)).toBe("2024-06-16T00:00:00.000Z");
    });
  });

  describe("daily (America/New_York, DST-aware)", () => {
    it("is a normal 24h day in winter (EST, UTC-5)", () => {
      const w = windowContaining("daily", new Date("2024-01-15T12:00:00Z"), "America/New_York");
      expect(iso(w.start)).toBe("2024-01-15T05:00:00.000Z");
      expect(iso(w.end)).toBe("2024-01-16T05:00:00.000Z");
      expect(w.end.getTime() - w.start.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it("is a 23h day on spring-forward (EST→EDT)", () => {
      const w = windowContaining("daily", new Date("2024-03-10T12:00:00Z"), "America/New_York");
      expect(iso(w.start)).toBe("2024-03-10T05:00:00.000Z");
      expect(iso(w.end)).toBe("2024-03-11T04:00:00.000Z");
      expect(w.end.getTime() - w.start.getTime()).toBe(23 * 60 * 60 * 1000);
    });

    it("is a 25h day on fall-back (EDT→EST)", () => {
      const w = windowContaining("daily", new Date("2024-11-03T12:00:00Z"), "America/New_York");
      expect(iso(w.start)).toBe("2024-11-03T04:00:00.000Z");
      expect(iso(w.end)).toBe("2024-11-04T05:00:00.000Z");
      expect(w.end.getTime() - w.start.getTime()).toBe(25 * 60 * 60 * 1000);
    });
  });

  describe("weekly (Monday start, ISO 8601)", () => {
    it("backs up to Monday from a mid-week day", () => {
      // 2024-01-17 is a Wednesday; the week's Monday is 2024-01-15.
      const w = windowContaining("weekly", new Date("2024-01-17T12:00:00Z"), "America/New_York");
      expect(iso(w.start)).toBe("2024-01-15T05:00:00.000Z");
      expect(iso(w.end)).toBe("2024-01-22T05:00:00.000Z");
    });

    it("treats Sunday as the last day of the week, not the first", () => {
      // 2024-01-21 is a Sunday; its week still starts Monday 2024-01-15.
      const w = windowContaining("weekly", new Date("2024-01-21T12:00:00Z"), "UTC");
      expect(iso(w.start)).toBe("2024-01-15T00:00:00.000Z");
      expect(iso(w.end)).toBe("2024-01-22T00:00:00.000Z");
    });

    it("returns the same week when given the Monday itself", () => {
      const w = windowContaining("weekly", new Date("2024-01-15T00:00:00Z"), "UTC");
      expect(iso(w.start)).toBe("2024-01-15T00:00:00.000Z");
      expect(iso(w.end)).toBe("2024-01-22T00:00:00.000Z");
    });
  });

  describe("monthly", () => {
    it("spans the 1st to the 1st of the next month", () => {
      const w = windowContaining("monthly", new Date("2024-02-15T12:00:00Z"), "America/New_York");
      expect(iso(w.start)).toBe("2024-02-01T05:00:00.000Z");
      expect(iso(w.end)).toBe("2024-03-01T05:00:00.000Z");
    });

    it("rolls the year over in December", () => {
      const w = windowContaining("monthly", new Date("2024-12-15T12:00:00Z"), "America/New_York");
      expect(iso(w.start)).toBe("2024-12-01T05:00:00.000Z");
      expect(iso(w.end)).toBe("2025-01-01T05:00:00.000Z");
    });
  });
});

describe("effectiveWindow (mid-window timezone-change pin rule)", () => {
  it("equals windowContaining when there is no change", () => {
    const now = new Date("2024-01-15T12:00:00Z");
    expect(effectiveWindow("daily", now, "America/New_York")).toEqual(
      windowContaining("daily", now, "America/New_York"),
    );
  });

  it("ignores a change that has not happened yet (now < change.at)", () => {
    const now = new Date("2024-01-15T12:00:00Z");
    const change = { at: new Date("2024-01-16T00:00:00Z"), previousTz: "Asia/Tokyo" };
    expect(effectiveWindow("daily", now, "America/New_York", change)).toEqual(
      windowContaining("daily", now, "America/New_York"),
    );
  });

  it("pins the in-flight window against a westward move that would lengthen the day", () => {
    // Move New_York (UTC-5) → Los_Angeles (UTC-8). Recomputing the open day in
    // LA would push its end 3h later; the pin keeps the original NY boundary.
    const change = { at: new Date("2024-01-15T18:00:00Z"), previousTz: "America/New_York" };
    const now = new Date("2024-01-15T20:00:00Z"); // still inside the NY day
    const pinned = effectiveWindow("daily", now, "America/Los_Angeles", change);

    expect(pinned.tz).toBe("America/New_York");
    expect(iso(pinned.start)).toBe("2024-01-15T05:00:00.000Z");
    expect(iso(pinned.end)).toBe("2024-01-16T05:00:00.000Z");

    // The un-pinned LA window would have ended later — that's the lengthening
    // the pin avoids.
    const unpinned = windowContaining("daily", now, "America/Los_Angeles");
    expect(unpinned.end.getTime()).toBeGreaterThan(pinned.end.getTime());
  });

  it("pins the in-flight window against an eastward move that would shorten the day", () => {
    // Move New_York (UTC-5) → Tokyo (UTC+9). Recomputing the open day in Tokyo
    // would end it earlier; the pin keeps the original NY boundary.
    const change = { at: new Date("2024-01-15T06:00:00Z"), previousTz: "America/New_York" };
    const now = new Date("2024-01-15T10:00:00Z"); // still inside the NY day
    const pinned = effectiveWindow("daily", now, "Asia/Tokyo", change);

    expect(pinned.tz).toBe("America/New_York");
    expect(iso(pinned.start)).toBe("2024-01-15T05:00:00.000Z");
    expect(iso(pinned.end)).toBe("2024-01-16T05:00:00.000Z");

    const unpinned = windowContaining("daily", now, "Asia/Tokyo");
    expect(unpinned.end.getTime()).toBeLessThan(pinned.end.getTime());
  });

  it("switches to the new zone once the pinned window closes, tiling with no gap or overlap", () => {
    const change = { at: new Date("2024-01-15T18:00:00Z"), previousTz: "America/New_York" };
    const pinned = windowContaining("daily", change.at, "America/New_York");

    // Just after the pinned NY day ends: the first LA window is a stub that
    // starts exactly where the pinned window ended (no overlap), then runs to
    // the next LA midnight.
    const justAfter = new Date(pinned.end.getTime() + 60 * 60 * 1000); // +1h
    const seam = effectiveWindow("daily", justAfter, "America/Los_Angeles", change);
    expect(seam.tz).toBe("America/Los_Angeles");
    expect(iso(seam.start)).toBe(iso(pinned.end)); // tiles exactly
    expect(iso(seam.end)).toBe("2024-01-16T08:00:00.000Z"); // LA midnight of Jan 16
    expect(seam.start.getTime()).toBeLessThan(seam.end.getTime());

    // Well past the move: a plain LA day, no clamping.
    const later = new Date("2024-01-20T20:00:00Z");
    expect(effectiveWindow("daily", later, "America/Los_Angeles", change)).toEqual(
      windowContaining("daily", later, "America/Los_Angeles"),
    );
  });

  it("applies the pin to weekly windows too", () => {
    // Change mid-week; the open ISO week stays pinned to its opening zone.
    const change = { at: new Date("2024-01-17T18:00:00Z"), previousTz: "America/New_York" };
    const now = new Date("2024-01-18T12:00:00Z"); // same ISO week
    const w = effectiveWindow("weekly", now, "America/Los_Angeles", change);
    expect(w.tz).toBe("America/New_York");
    expect(iso(w.start)).toBe("2024-01-15T05:00:00.000Z");
    expect(iso(w.end)).toBe("2024-01-22T05:00:00.000Z");
  });
});
