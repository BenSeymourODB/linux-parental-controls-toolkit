/**
 * Unit tests for the recurring-window → `timekpra` allowed-hours translation
 * (#140). Everything under test is pure: window lists in, argv vectors out, with
 * a {@link TimekprArgumentError} for any set the grammar cannot represent. The
 * one I/O-shaped case ({@link TimekprClient.setWeeklyAllowedHours}) runs against
 * a recording fake transport, asserting *what* it would run and *in what order*.
 */
import type { ZodType } from "zod";
import { beforeEach, describe, expect, it } from "vitest";

import type { AllowedWindow } from "../../../src/policy/resolve.js";
import type { ExecResult, SshTarget } from "../../../src/transport/ssh/facade.js";
import { SshCommandError } from "../../../src/transport/ssh/errors.js";
import {
  allowedWindowsToAllowedHours,
  buildWeeklyAllowedHoursCommands,
  type TimeWindow,
  type WeeklyAllowedWindows,
} from "../../../src/transport/timekpr/allowed-hours.js";
import { TimekprClient, type TimekprTransport } from "../../../src/transport/timekpr/client.js";
import { TimekprArgumentError } from "../../../src/transport/timekpr/errors.js";

const USER = "alice";

describe("allowedWindowsToAllowedHours", () => {
  it("maps a full day to all 24 bare hours", () => {
    const hours = allowedWindowsToAllowedHours([{ start: 0, end: 1440 }]);
    expect(hours).toHaveLength(24);
    expect(hours.map((h) => h.hour)).toEqual([...Array(24).keys()]);
    expect(hours.every((h) => h.startMinute === undefined && h.endMinute === undefined)).toBe(true);
  });

  it("maps a single whole clock hour to a bare hour", () => {
    expect(allowedWindowsToAllowedHours([{ start: 60, end: 120 }])).toEqual([{ hour: 1 }]);
  });

  it("brackets a sub-hour interval at the start of the day", () => {
    expect(allowedWindowsToAllowedHours([{ start: 30, end: 60 }])).toEqual([
      { hour: 0, startMinute: 30, endMinute: 60 },
    ]);
  });

  it("brackets a sub-hour interval that ends mid-hour", () => {
    expect(allowedWindowsToAllowedHours([{ start: 1410, end: 1440 }])).toEqual([
      { hour: 23, startMinute: 30, endMinute: 60 },
    ]);
  });

  it("splits a multi-hour window into partial first/last hours and bare middles", () => {
    // 16:30 → 18:15 = [990, 1095): h16 [30-60], h17 whole, h18 [00-15]
    expect(allowedWindowsToAllowedHours([{ start: 990, end: 1095 }])).toEqual([
      { hour: 16, startMinute: 30, endMinute: 60 },
      { hour: 17 },
      { hour: 18, startMinute: 0, endMinute: 15 },
    ]);
  });

  it("brackets a one-minute window", () => {
    expect(allowedWindowsToAllowedHours([{ start: 0, end: 1 }])).toEqual([
      { hour: 0, startMinute: 0, endMinute: 1 },
    ]);
  });

  it("emits a bare last hour when a partial-first window ends exactly on an hour boundary", () => {
    // 00:30 → 02:00 = [30, 120): h0 [30-60], h1 whole (ends exactly at 120).
    expect(allowedWindowsToAllowedHours([{ start: 30, end: 120 }])).toEqual([
      { hour: 0, startMinute: 30, endMinute: 60 },
      { hour: 1 },
    ]);
  });

  it("emits ascending hours across two windows in different hours", () => {
    expect(
      allowedWindowsToAllowedHours([
        { start: 0, end: 60 },
        { start: 1380, end: 1440 },
      ]),
    ).toEqual([{ hour: 0 }, { hour: 23 }]);
  });

  it("treats an empty window list as a fully-denied day (no hours)", () => {
    expect(allowedWindowsToAllowedHours([])).toEqual([]);
  });

  it("throws when one clock hour holds two disjoint allowed intervals", () => {
    // Allowed 09:00-09:10 and 09:20-09:30 — a within-hour allow/deny/allow split.
    expect(() =>
      allowedWindowsToAllowedHours([
        { start: 540, end: 550 },
        { start: 560, end: 570 },
      ]),
    ).toThrow(TimekprArgumentError);
  });

  it.each([
    ["non-integer start", [{ start: 0.5, end: 60 }]],
    ["non-integer end", [{ start: 0, end: 59.9 }]],
    ["negative start", [{ start: -1, end: 60 }]],
    ["end past midnight", [{ start: 0, end: 1441 }]],
    ["empty interval", [{ start: 60, end: 60 }]],
    ["inverted interval", [{ start: 120, end: 60 }]],
    [
      "overlapping windows",
      [
        { start: 0, end: 120 },
        { start: 60, end: 180 },
      ],
    ],
    [
      "adjacent (unmerged) windows",
      [
        { start: 0, end: 30 },
        { start: 30, end: 60 },
      ],
    ],
    [
      "descending windows",
      [
        { start: 120, end: 180 },
        { start: 0, end: 60 },
      ],
    ],
  ])("throws on malformed windows: %s", (_label, windows) => {
    expect(() => allowedWindowsToAllowedHours(windows as TimeWindow[])).toThrow(
      TimekprArgumentError,
    );
  });

  it("accepts the resolver's AllowedWindow type directly (structural compatibility)", () => {
    const fromResolver: AllowedWindow[] = [{ start: 0, end: 60 }];
    const windows: readonly TimeWindow[] = fromResolver;
    expect(allowedWindowsToAllowedHours(windows)).toEqual([{ hour: 0 }]);
  });
});

/** Build a weekly map from a `{ weekday: windows }` literal for terse fixtures. */
function weekly(
  entries: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, TimeWindow[]>>,
): WeeklyAllowedWindows {
  const map = new Map<1 | 2 | 3 | 4 | 5 | 6 | 7, readonly TimeWindow[]>();
  for (const [day, windows] of Object.entries(entries)) {
    if (windows !== undefined) map.set(Number(day) as 1 | 2 | 3 | 4 | 5 | 6 | 7, windows);
  }
  return map;
}

/** Allowed-hours list for a window ending at 21:00 (`[0, 1260)`): bare hours 0..20. */
const HOURS_UNTIL_2100 = Array.from({ length: 21 }, (_, h) => h).join(";");
/** Allowed-hours list for a window ending at 22:00 (`[0, 1320)`): bare hours 0..21. */
const HOURS_UNTIL_2200 = Array.from({ length: 22 }, (_, h) => h).join(";");

describe("buildWeeklyAllowedHoursCommands", () => {
  it("emits set-allowed-days then per-day allowed-hours for the allowed weekdays", () => {
    const commands = buildWeeklyAllowedHoursCommands(
      USER,
      weekly({ 1: [{ start: 960, end: 1080 }], 6: [{ start: 660, end: 1320 }] }),
    );
    expect(commands).toEqual([
      ["--setalloweddays", USER, "1;6"],
      ["--setallowedhours", USER, "1", "16;17"],
      ["--setallowedhours", USER, "6", "11;12;13;14;15;16;17;18;19;20;21"],
    ]);
  });

  it("omits a denied (empty / absent) weekday from the allowed days", () => {
    const commands = buildWeeklyAllowedHoursCommands(
      USER,
      weekly({ 1: [{ start: 0, end: 60 }], 2: [] }),
    );
    expect(commands[0]).toEqual(["--setalloweddays", USER, "1"]);
    expect(commands).toHaveLength(2);
  });

  it("collapses to a single ALL command when all seven days share identical hours", () => {
    const everyDay = { start: 0, end: 1260 }; // allow until 21:00 daily
    const commands = buildWeeklyAllowedHoursCommands(
      USER,
      weekly({
        1: [everyDay],
        2: [everyDay],
        3: [everyDay],
        4: [everyDay],
        5: [everyDay],
        6: [everyDay],
        7: [everyDay],
      }),
    );
    expect(commands).toEqual([
      ["--setalloweddays", USER, "1;2;3;4;5;6;7"],
      ["--setallowedhours", USER, "ALL", "0;1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17;18;19;20"],
    ]);
  });

  it("does not collapse to ALL when the seven days differ", () => {
    const commands = buildWeeklyAllowedHoursCommands(
      USER,
      weekly({
        1: [{ start: 0, end: 1260 }],
        2: [{ start: 0, end: 1260 }],
        3: [{ start: 0, end: 1260 }],
        4: [{ start: 0, end: 1260 }],
        5: [{ start: 0, end: 1260 }],
        6: [{ start: 0, end: 1320 }], // weekend differs
        7: [{ start: 0, end: 1320 }],
      }),
    );
    // 1 set-allowed-days + 7 per-day allowed-hours, no ALL.
    expect(commands).toHaveLength(8);
    expect(commands[0]).toEqual(["--setalloweddays", USER, "1;2;3;4;5;6;7"]);
    expect(commands.slice(1).every((c) => c[2] !== "ALL")).toBe(true);
    // The weekday and weekend days carry their own (differing) hour lists.
    expect(commands[1]).toEqual(["--setallowedhours", USER, "1", HOURS_UNTIL_2100]);
    expect(commands[6]).toEqual(["--setallowedhours", USER, "6", HOURS_UNTIL_2200]);
  });

  it("does not collapse to ALL when a day is denied even if allowed days match", () => {
    const same = { start: 0, end: 1260 };
    const commands = buildWeeklyAllowedHoursCommands(
      USER,
      weekly({ 1: [same], 2: [same], 3: [same], 4: [same], 5: [same] }), // weekend denied
    );
    expect(commands[0]).toEqual(["--setalloweddays", USER, "1;2;3;4;5"]);
    expect(commands).toHaveLength(6);
    expect(commands.slice(1).every((c) => c[2] !== "ALL")).toBe(true);
    expect(commands[1]).toEqual(["--setallowedhours", USER, "1", HOURS_UNTIL_2100]);
  });

  it("throws when no day is allowed", () => {
    expect(() => buildWeeklyAllowedHoursCommands(USER, weekly({ 1: [], 2: [] }))).toThrow(
      TimekprArgumentError,
    );
    expect(() => buildWeeklyAllowedHoursCommands(USER, weekly({}))).toThrow(TimekprArgumentError);
  });

  it("propagates a username grammar error", () => {
    expect(() =>
      buildWeeklyAllowedHoursCommands("bad;name", weekly({ 1: [{ start: 0, end: 60 }] })),
    ).toThrow(TimekprArgumentError);
  });
});

// --- TimekprClient.setWeeklyAllowedHours -----------------------------------

const TARGET: SshTarget = { host: "client.local", username: "pct-agent", privateKey: "KEY" };
const OK_RESULT: ExecResult = { stdout: "ok", stderr: "", code: 0, signal: null };

interface RecordedCall {
  argv: readonly string[];
}

class FakeTransport implements TimekprTransport {
  readonly checked: RecordedCall[] = [];
  checkedError: Error | undefined;

  async execChecked(_target: SshTarget, argv: readonly string[]): Promise<ExecResult> {
    this.checked.push({ argv });
    if (this.checkedError !== undefined) throw this.checkedError;
    return OK_RESULT;
  }

  async execAndParse<T>(_t: SshTarget, _a: readonly string[], schema: ZodType<T>): Promise<T> {
    return schema.parse("");
  }
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
});

describe("TimekprClient.setWeeklyAllowedHours", () => {
  it("runs the built commands, prefixed with the binary, in order", async () => {
    const client = new TimekprClient(transport, TARGET, USER);
    const results = await client.setWeeklyAllowedHours(
      weekly({ 1: [{ start: 960, end: 1080 }], 6: [{ start: 660, end: 1320 }] }),
    );
    expect(results).toHaveLength(3);
    expect(transport.checked.map((c) => c.argv)).toEqual([
      ["sudo", "timekpra", "--setalloweddays", USER, "1;6"],
      ["sudo", "timekpra", "--setallowedhours", USER, "1", "16;17"],
      ["sudo", "timekpra", "--setallowedhours", USER, "6", "11;12;13;14;15;16;17;18;19;20;21"],
    ]);
  });

  it("propagates an SshCommandError and stops after the failing command", async () => {
    transport.checkedError = new SshCommandError(
      { host: "client.local", port: 22, username: "pct-agent" },
      ["sudo", "timekpra", "--setalloweddays"],
      { code: 1, signal: null, stdout: "", stderr: "boom" },
    );
    const client = new TimekprClient(transport, TARGET, USER);
    await expect(
      client.setWeeklyAllowedHours(weekly({ 1: [{ start: 0, end: 60 }] })),
    ).rejects.toBeInstanceOf(SshCommandError);
    // Rejected on the first command — no further commands attempted.
    expect(transport.checked).toHaveLength(1);
  });

  it("rejects (does not throw synchronously) when the windows are unrepresentable", async () => {
    const client = new TimekprClient(transport, TARGET, USER);
    const promise = client.setWeeklyAllowedHours(weekly({}));
    await expect(promise).rejects.toBeInstanceOf(TimekprArgumentError);
    expect(transport.checked).toHaveLength(0);
  });
});
