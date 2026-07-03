import { describe, expect, it, vi } from "vitest";

import {
  CanberraSoundPlayer,
  DesktopNotifier,
  OsProcessSignaller,
  parseNotificationId,
  soundNameForEvent,
  SpawnCommandRunner,
  type CommandResult,
  type CommandRunner,
} from "../../src/agent/effects.js";

/** A CommandRunner that records calls and returns a scripted result. */
class FakeRunner implements CommandRunner {
  calls: { command: string; args: string[] }[] = [];
  constructor(private readonly script: (command: string) => Promise<CommandResult>) {}
  run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] });
    return this.script(command);
  }
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

describe("parseNotificationId", () => {
  it("extracts the uint32 id gdbus prints", () => {
    expect(parseNotificationId("(uint32 42,)")).toBe(42);
  });
  it("returns null when no id is present", () => {
    expect(parseNotificationId("")).toBeNull();
    expect(parseNotificationId("(nothing)")).toBeNull();
  });
});

describe("DesktopNotifier", () => {
  it("calls gdbus Notify and returns the parsed id", async () => {
    const runner = new FakeRunner(() => Promise.resolve(ok("(uint32 7,)")));
    const notifier = new DesktopNotifier({ runner, appName: "pct-client-agent" });

    const handle = await notifier.notify({ title: "Hi", body: "there", urgency: "critical" });

    expect(handle.id).toBe(7);
    const call = runner.calls[0];
    expect(call?.command).toBe("gdbus");
    expect(call?.args).toContain("org.freedesktop.Notifications.Notify");
    expect(call?.args).toContain("pct-client-agent");
    expect(call?.args).toContain("Hi");
    expect(call?.args).toContain("there");
    // replaces_id is 0 for a fresh toast; urgency byte 2 = critical.
    expect(call?.args).toContain("0");
    expect(call?.args).toContain("{'urgency': <byte 2>}");
  });

  it("update passes the prior id as replaces_id", async () => {
    const runner = new FakeRunner(() => Promise.resolve(ok("(uint32 9,)")));
    const notifier = new DesktopNotifier({ runner });
    const handle = await notifier.update({ id: 5 }, { title: "t", body: "b" });
    expect(handle.id).toBe(9);
    expect(runner.calls[0]?.args).toContain("5");
    // No urgency ⇒ empty hints dict.
    expect(runner.calls[0]?.args).toContain("{}");
  });

  it("falls back to notify-send when gdbus exits non-zero", async () => {
    const runner = new FakeRunner((command) =>
      command === "gdbus"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" })
        : Promise.resolve(ok("")),
    );
    const notifier = new DesktopNotifier({ runner });
    const handle = await notifier.notify({ title: "T", body: "B", urgency: "low" });
    expect(handle.id).toBeNull();
    expect(runner.calls.map((c) => c.command)).toEqual(["gdbus", "notify-send"]);
    expect(runner.calls[1]?.args).toEqual(["--urgency", "low", "T", "B"]);
  });

  it("falls back when gdbus cannot be spawned, and swallows a missing notify-send", async () => {
    const runner = new FakeRunner((command) =>
      command === "gdbus"
        ? Promise.reject(new Error("ENOENT"))
        : Promise.reject(new Error("ENOENT")),
    );
    const notifier = new DesktopNotifier({ runner });
    const handle = await notifier.notify({ title: "T", body: "B" });
    expect(handle.id).toBeNull();
    expect(runner.calls.map((c) => c.command)).toEqual(["gdbus", "notify-send"]);
  });
});

describe("soundNameForEvent", () => {
  it("maps each event to its freedesktop sound name", () => {
    expect(soundNameForEvent("warning")).toBe("message-new-instant");
    expect(soundNameForEvent("final-warning")).toBe("dialog-warning");
    expect(soundNameForEvent("grant")).toBe("complete");
    expect(soundNameForEvent("timesUp")).toBe("bell");
  });
});

describe("CanberraSoundPlayer", () => {
  it("plays a named sound through canberra-gtk-play", async () => {
    const runner = new FakeRunner(() => Promise.resolve(ok("")));
    await new CanberraSoundPlayer({ runner }).play("bell");
    expect(runner.calls[0]).toEqual({ command: "canberra-gtk-play", args: ["-i", "bell"] });
  });

  it("is a no-op for a null sound", async () => {
    const runner = new FakeRunner(() => Promise.resolve(ok("")));
    await new CanberraSoundPlayer({ runner }).play(null);
    expect(runner.calls).toHaveLength(0);
  });

  it("swallows a missing canberra binary", async () => {
    const runner = new FakeRunner(() => Promise.reject(new Error("ENOENT")));
    await expect(new CanberraSoundPlayer({ runner }).play("bell")).resolves.toBeUndefined();
  });
});

describe("OsProcessSignaller", () => {
  it("returns true when the signal is delivered", () => {
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      expect(new OsProcessSignaller().signal(1234, "SIGTERM")).toBe(true);
      expect(spy).toHaveBeenCalledWith(1234, "SIGTERM");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns false when the process is already gone (ESRCH)", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    try {
      expect(new OsProcessSignaller().signal(999999, "SIGKILL")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("rethrows a non-ESRCH error (e.g. EPERM)", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    try {
      expect(() => new OsProcessSignaller().signal(1, "SIGTERM")).toThrow(/not permitted/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("SpawnCommandRunner", () => {
  it("runs a real command and captures its exit code and stdout", async () => {
    const result = await new SpawnCommandRunner().run("node", ["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^v\d+/);
  });

  it("rejects when the binary cannot be spawned", async () => {
    await expect(
      new SpawnCommandRunner().run("pct-nonexistent-binary-xyz", []),
    ).rejects.toBeInstanceOf(Error);
  });
});
