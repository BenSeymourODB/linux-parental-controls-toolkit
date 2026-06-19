/**
 * Unit tests for the pure `timekpra` argv builders.
 *
 * Each builder must produce the exact argv vector the SSH facade will quote and
 * run, and must reject — synchronously, as a {@link TimekprArgumentError} — any
 * value the `timekpra` CLI grammar cannot represent. No I/O is involved.
 */
import { describe, expect, it } from "vitest";

import {
  ALL_DAYS,
  assertUsername,
  buildSetAllowedDays,
  buildSetAllowedHours,
  buildSetPlayTimeActivities,
  buildSetPlayTimeAllowedDays,
  buildSetPlayTimeEnabled,
  buildSetPlayTimeLimitOverride,
  buildSetPlayTimeUnaccountedIntervalsEnabled,
  buildSetPlayTimeLimits,
  buildSetTimeLimits,
  buildSetTimeLimitMonth,
  buildSetTimeLimitWeek,
  buildUserInfo,
  type IsoWeekday,
} from "../../../src/transport/timekpr/commands.js";
import { TimekprArgumentError } from "../../../src/transport/timekpr/errors.js";

const USER = "alice";

describe("assertUsername", () => {
  it("accepts a plain Linux account name", () => {
    expect(() => assertUsername("alice_2")).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["space", "ali ce"],
    ["semicolon", "ali;ce"],
    ["bracket", "ali[ce]"],
    ["tab", "ali\tce"],
    ["newline", "ali\nce"],
  ])("rejects %s usernames", (_label, name) => {
    expect(() => assertUsername(name)).toThrow(TimekprArgumentError);
  });
});

describe("buildSetAllowedDays", () => {
  it("joins ISO weekdays with ';'", () => {
    expect(buildSetAllowedDays(USER, [1, 2, 3, 4, 5])).toEqual([
      "--setalloweddays",
      "alice",
      "1;2;3;4;5",
    ]);
  });

  it("rejects an empty day list", () => {
    expect(() => buildSetAllowedDays(USER, [])).toThrow(TimekprArgumentError);
  });

  it("rejects a weekday outside 1..7", () => {
    // 0 and 8 are out of the ISO range; cast through unknown to bypass the
    // compile-time union and exercise the runtime guard.
    const bad = [0] as unknown as IsoWeekday[];
    expect(() => buildSetAllowedDays(USER, bad)).toThrow(/ISO weekday 1\.\.7/);
  });
});

describe("buildSetAllowedHours", () => {
  it("renders a single weekday with plain hours", () => {
    expect(buildSetAllowedHours(USER, 3, [{ hour: 7 }, { hour: 8 }, { hour: 22 }])).toEqual([
      "--setallowedhours",
      "alice",
      "3",
      "7;8;22",
    ]);
  });

  it("renders ALL with a minute window and an unaccounted hour", () => {
    expect(
      buildSetAllowedHours(USER, ALL_DAYS, [
        { hour: 9 },
        { hour: 12, startMinute: 0, endMinute: 30 },
        { hour: 15, unaccounted: true },
        { hour: 20, startMinute: 0, endMinute: 45, unaccounted: true },
      ]),
    ).toEqual(["--setallowedhours", "alice", "ALL", "9;12[00-30];!15;!20[00-45]"]);
  });

  it("renders a weekday list in the day position", () => {
    expect(buildSetAllowedHours(USER, [1, 2, 3, 4, 5], [{ hour: 9 }])).toEqual([
      "--setallowedhours",
      "alice",
      "1;2;3;4;5",
      "9",
    ]);
  });

  it("rejects an empty weekday list in the day position", () => {
    expect(() => buildSetAllowedHours(USER, [], [{ hour: 9 }])).toThrow(/at least one weekday/);
  });

  it("zero-pads minute bounds to two digits", () => {
    const [, , , hours] = buildSetAllowedHours(USER, 1, [
      { hour: 6, startMinute: 5, endMinute: 9 },
    ]);
    expect(hours).toBe("6[05-09]");
  });

  it("rejects an empty hour list", () => {
    expect(() => buildSetAllowedHours(USER, 1, [])).toThrow(TimekprArgumentError);
  });

  it("rejects an hour outside 0..23", () => {
    expect(() => buildSetAllowedHours(USER, 1, [{ hour: 24 }])).toThrow(/0\.\.23/);
  });

  it("rejects a day outside 1..7 and not ALL", () => {
    const bad = 9 as unknown as IsoWeekday;
    expect(() => buildSetAllowedHours(USER, bad, [{ hour: 1 }])).toThrow(
      /ISO weekday 1\.\.7, a weekday list, or "ALL"/,
    );
  });

  it("rejects a minute window missing one bound", () => {
    expect(() => buildSetAllowedHours(USER, 1, [{ hour: 8, startMinute: 0 }])).toThrow(
      /both startMinute and endMinute/,
    );
  });

  it.each([
    ["start >= end", { hour: 8, startMinute: 30, endMinute: 30 }],
    ["end > 60", { hour: 8, startMinute: 0, endMinute: 61 }],
    ["negative start", { hour: 8, startMinute: -1, endMinute: 10 }],
  ])("rejects an invalid minute window (%s)", (_label, entry) => {
    expect(() => buildSetAllowedHours(USER, 1, [entry])).toThrow(/0 <= start < end <= 60/);
  });
});

describe("session-limit builders", () => {
  it("builds per-weekday daily limits", () => {
    expect(buildSetTimeLimits(USER, [3600, 3600, 7200])).toEqual([
      "--settimelimits",
      "alice",
      "3600;3600;7200",
    ]);
  });

  it("builds the weekly limit", () => {
    expect(buildSetTimeLimitWeek(USER, 86400)).toEqual(["--settimelimitweek", "alice", "86400"]);
  });

  it("builds the monthly limit", () => {
    expect(buildSetTimeLimitMonth(USER, 360000)).toEqual([
      "--settimelimitmonth",
      "alice",
      "360000",
    ]);
  });

  it("allows a zero-second limit", () => {
    expect(buildSetTimeLimitWeek(USER, 0)).toEqual(["--settimelimitweek", "alice", "0"]);
  });

  it("rejects an empty daily-limit list", () => {
    expect(() => buildSetTimeLimits(USER, [])).toThrow(/at least one day/);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
  ])("rejects a %s second value", (_label, seconds) => {
    expect(() => buildSetTimeLimitWeek(USER, seconds)).toThrow(/non-negative integer/);
    expect(() => buildSetTimeLimits(USER, [seconds])).toThrow(/non-negative integer/);
  });
});

describe("PlayTime builders", () => {
  it("builds the boolean toggles", () => {
    expect(buildSetPlayTimeEnabled(USER, true)).toEqual(["--setplaytimeenabled", "alice", "true"]);
    expect(buildSetPlayTimeLimitOverride(USER, false)).toEqual([
      "--setplaytimelimitoverride",
      "alice",
      "false",
    ]);
    expect(buildSetPlayTimeUnaccountedIntervalsEnabled(USER, true)).toEqual([
      "--setplaytimeunaccountedintervalsenabled",
      "alice",
      "true",
    ]);
  });

  it("builds PlayTime allowed days and limits", () => {
    expect(buildSetPlayTimeAllowedDays(USER, [6, 7])).toEqual([
      "--setplaytimealloweddays",
      "alice",
      "6;7",
    ]);
    expect(buildSetPlayTimeLimits(USER, [0, 0, 3600])).toEqual([
      "--setplaytimelimits",
      "alice",
      "0;0;3600",
    ]);
  });

  it("builds activities with and without descriptions", () => {
    expect(
      buildSetPlayTimeActivities(USER, [
        { mask: "minetest", description: "Minetest" },
        { mask: "dota2" },
      ]),
    ).toEqual(["--setplaytimeactivities", "alice", "minetest[Minetest];dota2"]);
  });

  it("emits a bare mask for an empty description (no empty bracket)", () => {
    expect(buildSetPlayTimeActivities(USER, [{ mask: "dota2", description: "" }])).toEqual([
      "--setplaytimeactivities",
      "alice",
      "dota2",
    ]);
  });

  it("rejects an empty activity list", () => {
    expect(() => buildSetPlayTimeActivities(USER, [])).toThrow(/at least one entry/);
  });

  it.each([
    ["empty mask", { mask: "" }],
    ["mask with ';'", { mask: "a;b" }],
    ["mask with bracket", { mask: "a[b]" }],
  ])("rejects a bad activity mask (%s)", (_label, activity) => {
    expect(() => buildSetPlayTimeActivities(USER, [activity])).toThrow(TimekprArgumentError);
  });

  it("rejects a description containing a separator", () => {
    expect(() => buildSetPlayTimeActivities(USER, [{ mask: "ok", description: "a;b" }])).toThrow(
      /description/,
    );
  });
});

describe("buildUserInfo", () => {
  it("builds the userinfo query", () => {
    expect(buildUserInfo(USER)).toEqual(["--userinfo", "alice"]);
  });

  it("validates the username", () => {
    expect(() => buildUserInfo("bad;name")).toThrow(TimekprArgumentError);
  });
});
