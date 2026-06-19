/**
 * Recurring-window → `timekpra` allowed-hours / allowed-days mapping (#140).
 *
 * The pure mappers are asserted against the `timekpra` grammar exhaustively
 * (whole/partial hours, boundaries, the split-hour limit, weekday grouping, the
 * whole-week-lockout guard); the applier is driven over the real
 * {@link TimekprClient} on a lightweight {@link TimekprTransport} fake so it
 * asserts *what would run* without opening a socket.
 */
import type { ZodType } from "zod";
import { describe, expect, it } from "vitest";

import type { AllowedWindow } from "../../../src/policy/resolve.js";
import {
  ISO_WEEKDAYS,
  applyWeeklySchedule,
  dayAllowance,
  dayWindowsToAllowedHours,
  planWeeklyAllowedHours,
  timekprWeekCommands,
} from "../../../src/transport/timekpr/allowed-hours.js";
import { TimekprClient, type TimekprTransport } from "../../../src/transport/timekpr/client.js";
import { TimekprArgumentError } from "../../../src/transport/timekpr/errors.js";
import type { ExecResult, SshTarget } from "../../../src/transport/ssh/facade.js";

const TARGET: SshTarget = { host: "client.local", username: "pct-agent", privateKey: "KEY" };
const OK_RESULT: ExecResult = { stdout: "ok", stderr: "", code: 0, signal: null };

/** A fake transport that records the argv every checked exec is handed. */
class FakeTransport implements TimekprTransport {
  readonly checked: (readonly string[])[] = [];
  async execChecked(_target: SshTarget, argv: readonly string[]): Promise<ExecResult> {
    this.checked.push(argv);
    return OK_RESULT;
  }
  async execAndParse<T>(
    _target: SshTarget,
    _argv: readonly string[],
    schema: ZodType<T>,
  ): Promise<T> {
    return schema.parse("USER_NAME: alice");
  }
}

/** All seven weekdays mapped to the same windows, for whole-week cases. */
function everyDay(windows: readonly AllowedWindow[]): Map<number, readonly AllowedWindow[]> {
  return new Map(ISO_WEEKDAYS.map((day) => [day, windows]));
}

describe("dayWindowsToAllowedHours", () => {
  it("maps an empty day to an empty list (denied)", () => {
    expect(dayWindowsToAllowedHours([])).toEqual([]);
  });

  it("maps a full day to every bare hour", () => {
    const hours = dayWindowsToAllowedHours([{ start: 0, end: 1440 }]);
    expect(hours).toHaveLength(24);
    expect(hours).toEqual(Array.from({ length: 24 }, (_, hour) => ({ hour })));
  });

  it("maps whole-hour windows to bare hours", () => {
    // 08:00–10:00
    expect(dayWindowsToAllowedHours([{ start: 480, end: 600 }])).toEqual([
      { hour: 8 },
      { hour: 9 },
    ]);
  });

  it("emits a [mm-mm] sub-window for a partial start hour", () => {
    // 08:30–10:00 → hour 8 windowed [30-60], hour 9 whole
    expect(dayWindowsToAllowedHours([{ start: 510, end: 600 }])).toEqual([
      { hour: 8, startMinute: 30, endMinute: 60 },
      { hour: 9 },
    ]);
  });

  it("emits a [mm-mm] sub-window for a partial end hour", () => {
    // 08:00–09:30 → hour 8 whole, hour 9 windowed [0-30]
    expect(dayWindowsToAllowedHours([{ start: 480, end: 570 }])).toEqual([
      { hour: 8 },
      { hour: 9, startMinute: 0, endMinute: 30 },
    ]);
  });

  it("handles a window inside a single hour", () => {
    // 08:15–08:45
    expect(dayWindowsToAllowedHours([{ start: 495, end: 525 }])).toEqual([
      { hour: 8, startMinute: 15, endMinute: 45 },
    ]);
  });

  it("allows a window ending exactly at end-of-day (minute 60 of hour 23)", () => {
    // 23:30–24:00
    expect(dayWindowsToAllowedHours([{ start: 1410, end: 1440 }])).toEqual([
      { hour: 23, startMinute: 30, endMinute: 60 },
    ]);
  });

  it("maps multiple separate windows across the day", () => {
    // 06:00–07:00 and 18:00–18:30
    expect(
      dayWindowsToAllowedHours([
        { start: 360, end: 420 },
        { start: 1080, end: 1110 },
      ]),
    ).toEqual([{ hour: 6 }, { hour: 18, startMinute: 0, endMinute: 30 }]);
  });

  it("merges abutting windows within one hour into a single sub-window", () => {
    // 08:00–08:20 then 08:20–08:40 → one [00-40] window, not two
    expect(
      dayWindowsToAllowedHours([
        { start: 480, end: 500 },
        { start: 500, end: 520 },
      ]),
    ).toEqual([{ hour: 8, startMinute: 0, endMinute: 40 }]);
  });

  it("throws when a deny gap splits one hour into two sub-windows", () => {
    // allow 08:00–08:10 and 08:20–09:00 → hour 8 needs two [mm-mm] windows
    expect(() =>
      dayWindowsToAllowedHours([
        { start: 480, end: 490 },
        { start: 500, end: 540 },
      ]),
    ).toThrow(TimekprArgumentError);
  });

  it.each([
    [{ start: -1, end: 60 }],
    [{ start: 0, end: 1441 }],
    [{ start: 60, end: 60 }],
    [{ start: 30.5, end: 60 }],
  ])("rejects an out-of-range window %o", (window) => {
    expect(() => dayWindowsToAllowedHours([window])).toThrow(TimekprArgumentError);
  });

  it("rejects non-ascending / overlapping windows", () => {
    expect(() =>
      dayWindowsToAllowedHours([
        { start: 480, end: 600 },
        { start: 540, end: 660 },
      ]),
    ).toThrow(TimekprArgumentError);
  });
});

describe("dayAllowance", () => {
  it("classifies no windows as denied", () => {
    expect(dayAllowance([])).toEqual({ kind: "denied" });
  });

  it("classifies windows as allowed with their hours", () => {
    expect(dayAllowance([{ start: 480, end: 540 }])).toEqual({
      kind: "allowed",
      hours: [{ hour: 8 }],
    });
  });
});

describe("planWeeklyAllowedHours", () => {
  it("excludes fully-denied weekdays from allowedDays", () => {
    const perDay = new Map<number, readonly AllowedWindow[]>([
      [1, [{ start: 480, end: 540 }]],
      [2, [{ start: 480, end: 540 }]],
      // 3..7 absent → denied
    ]);
    const plan = planWeeklyAllowedHours(perDay);
    expect(plan.allowedDays).toEqual([1, 2]);
  });

  it("coalesces weekdays with identical hours into one group", () => {
    const plan = planWeeklyAllowedHours(everyDay([{ start: 480, end: 540 }]));
    expect(plan.allowedDays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.hourGroups).toEqual([{ days: [1, 2, 3, 4, 5, 6, 7], hours: [{ hour: 8 }] }]);
  });

  it("keeps distinct hour lists as separate groups, ordered by earliest weekday", () => {
    const perDay = new Map<number, readonly AllowedWindow[]>([
      [1, [{ start: 480, end: 1080 }]], // Mon: 08:00–18:00
      [2, [{ start: 480, end: 1080 }]], // Tue: same as Mon
      [6, [{ start: 600, end: 720 }]], // Sat: 10:00–12:00
      [7, [{ start: 600, end: 720 }]], // Sun: same as Sat
    ]);
    const plan = planWeeklyAllowedHours(perDay);
    expect(plan.allowedDays).toEqual([1, 2, 6, 7]);
    expect(plan.hourGroups.map((g) => g.days)).toEqual([
      [1, 2],
      [6, 7],
    ]);
  });

  it("throws when every weekday is denied", () => {
    expect(() => planWeeklyAllowedHours(new Map())).toThrow(TimekprArgumentError);
  });
});

describe("timekprWeekCommands", () => {
  it("renders --setalloweddays then one --setallowedhours per group", () => {
    const perDay = new Map<number, readonly AllowedWindow[]>([
      [1, [{ start: 480, end: 540 }]],
      [2, [{ start: 480, end: 540 }]],
      [6, [{ start: 600, end: 630 }]],
    ]);
    expect(timekprWeekCommands("alice", perDay)).toEqual([
      ["--setalloweddays", "alice", "1;2;6"],
      ["--setallowedhours", "alice", "1;2", "8"],
      ["--setallowedhours", "alice", "6", "10[00-30]"],
    ]);
  });

  it("uses the ALL-bare-hour rendering for a full unrestricted week", () => {
    const [days, ...hours] = timekprWeekCommands("alice", everyDay([{ start: 0, end: 1440 }]));
    expect(days).toEqual(["--setalloweddays", "alice", "1;2;3;4;5;6;7"]);
    expect(hours).toEqual([
      [
        "--setallowedhours",
        "alice",
        "1;2;3;4;5;6;7",
        Array.from({ length: 24 }, (_, h) => h).join(";"),
      ],
    ]);
  });

  it("rejects an invalid username before building anything", () => {
    expect(() => timekprWeekCommands("bad user", everyDay([{ start: 0, end: 60 }]))).toThrow(
      TimekprArgumentError,
    );
  });
});

describe("applyWeeklySchedule", () => {
  it("pushes --setalloweddays then --setallowedhours per group over the client", async () => {
    const transport = new FakeTransport();
    const client = new TimekprClient(transport, TARGET, "alice");
    const perDay = new Map<number, readonly AllowedWindow[]>([
      [1, [{ start: 480, end: 540 }]],
      [2, [{ start: 480, end: 540 }]],
      [6, [{ start: 600, end: 630 }]],
    ]);

    await applyWeeklySchedule(client, perDay);

    // The client prefixes `sudo timekpra`; assert the trailing argv it built.
    expect(transport.checked.map((argv) => argv.slice(2))).toEqual([
      ["--setalloweddays", "alice", "1;2;6"],
      ["--setallowedhours", "alice", "1;2", "8"],
      ["--setallowedhours", "alice", "6", "10[00-30]"],
    ]);
  });

  it("propagates the whole-week-lockout guard without touching the client", async () => {
    const transport = new FakeTransport();
    const client = new TimekprClient(transport, TARGET, "alice");
    await expect(applyWeeklySchedule(client, new Map())).rejects.toThrow(TimekprArgumentError);
    expect(transport.checked).toHaveLength(0);
  });
});
