/**
 * Unit tests for {@link TimekprClient}.
 *
 * The SSH transport is a lightweight in-memory fake implementing the
 * {@link TimekprTransport} structural interface — it records the argv it is
 * handed and returns canned results, so these tests assert *what the client
 * would run* (binary prefix + builder output + target + options) and that reads
 * flow through the real `--userinfo` schema, without opening any socket.
 */
import type { ZodType } from "zod";
import { beforeEach, describe, expect, it } from "vitest";

import type { ExecOptions, ExecResult, SshTarget } from "../../../src/transport/ssh/facade.js";
import { SshCommandError } from "../../../src/transport/ssh/errors.js";
import {
  DEFAULT_TIMEKPRA_BINARY,
  TimekprClient,
  type TimekprTransport,
} from "../../../src/transport/timekpr/client.js";
import { TimekprArgumentError } from "../../../src/transport/timekpr/errors.js";

const TARGET: SshTarget = { host: "client.local", username: "pct-agent", privateKey: "KEY" };

interface RecordedCall {
  target: SshTarget;
  argv: readonly string[];
  options: ExecOptions | undefined;
}

const OK_RESULT: ExecResult = { stdout: "ok", stderr: "", code: 0, signal: null };

/** A fake transport recording every call; `execAndParse` runs the real schema. */
class FakeTransport implements TimekprTransport {
  readonly checked: RecordedCall[] = [];
  readonly parsed: RecordedCall[] = [];
  userInfoStdout = "USER_NAME: alice\nTIME_LIMIT_PER_WEEK: 86400";
  checkedError: Error | undefined;

  // `async` so a thrown error becomes a rejected promise, exactly as the real
  // `SshTransport` (whose methods are async) surfaces failures.
  async execChecked(
    target: SshTarget,
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.checked.push({ target, argv, options });
    if (this.checkedError !== undefined) throw this.checkedError;
    return OK_RESULT;
  }

  async execAndParse<T>(
    target: SshTarget,
    argv: readonly string[],
    schema: ZodType<T>,
    options?: ExecOptions,
  ): Promise<T> {
    this.parsed.push({ target, argv, options });
    return schema.parse(this.userInfoStdout);
  }
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
});

function clientFor(): TimekprClient {
  return new TimekprClient(transport, TARGET, "alice");
}

describe("TimekprClient construction", () => {
  it("exposes the username", () => {
    expect(clientFor().username).toBe("alice");
  });

  it("rejects an invalid username at construction", () => {
    expect(() => new TimekprClient(transport, TARGET, "bad;name")).toThrow(TimekprArgumentError);
  });

  it("rejects an empty binary prefix", () => {
    expect(() => new TimekprClient(transport, TARGET, "alice", { binary: [] })).toThrow(
      TimekprArgumentError,
    );
  });
});

describe("TimekprClient setters", () => {
  it("prefixes the default binary and routes through execChecked", async () => {
    const client = clientFor();
    await client.setTimeLimitWeek(86400);
    expect(transport.checked).toHaveLength(1);
    expect(transport.checked[0]?.argv).toEqual([
      ...DEFAULT_TIMEKPRA_BINARY,
      "--settimelimitweek",
      "alice",
      "86400",
    ]);
    expect(transport.checked[0]?.target).toBe(TARGET);
  });

  it("builds each command with the right argv", async () => {
    const client = clientFor();
    await client.setAllowedDays([1, 2, 3, 4, 5]);
    await client.setAllowedHours("ALL", [{ hour: 9 }, { hour: 17, startMinute: 0, endMinute: 30 }]);
    await client.setTimeLimits([3600, 7200]);
    await client.setTimeLimitMonth(360000);
    await client.setPlayTimeEnabled(true);
    await client.setPlayTimeLimitOverride(false);
    await client.setPlayTimeUnaccountedIntervalsEnabled(true);
    await client.setPlayTimeAllowedDays([6, 7]);
    await client.setPlayTimeLimits([0, 3600]);
    await client.setPlayTimeActivities([{ mask: "minetest", description: "Minetest" }]);

    const argvs = transport.checked.map((c) => c.argv.slice(DEFAULT_TIMEKPRA_BINARY.length));
    expect(argvs).toEqual([
      ["--setalloweddays", "alice", "1;2;3;4;5"],
      ["--setallowedhours", "alice", "ALL", "9;17[00-30]"],
      ["--settimelimits", "alice", "3600;7200"],
      ["--settimelimitmonth", "alice", "360000"],
      ["--setplaytimeenabled", "alice", "true"],
      ["--setplaytimelimitoverride", "alice", "false"],
      ["--setplaytimeunaccountedintervalsenabled", "alice", "true"],
      ["--setplaytimealloweddays", "alice", "6;7"],
      ["--setplaytimelimits", "alice", "0;3600"],
      ["--setplaytimeactivities", "alice", "minetest[Minetest]"],
    ]);
  });

  it("honours a binary override and forwarded exec options", async () => {
    const client = new TimekprClient(transport, TARGET, "alice", {
      binary: ["/usr/bin/timekpra"],
      execOptions: { timeoutMs: 5000 },
    });
    await client.setTimeLimitWeek(10);
    expect(transport.checked[0]?.argv).toEqual([
      "/usr/bin/timekpra",
      "--settimelimitweek",
      "alice",
      "10",
    ]);
    expect(transport.checked[0]?.options).toEqual({ timeoutMs: 5000 });
  });

  it("validates inputs before touching the transport", async () => {
    const client = clientFor();
    await expect(client.setTimeLimitWeek(-1)).rejects.toThrow(TimekprArgumentError);
    expect(transport.checked).toHaveLength(0);
  });

  it("propagates an SshCommandError from a failed setter unchanged", async () => {
    transport.checkedError = new SshCommandError(
      { host: "client.local", port: 22, username: "pct-agent" },
      ["sudo", "timekpra"],
      { code: 1, signal: null, stdout: "", stderr: "boom" },
    );
    await expect(clientFor().setTimeLimitWeek(1)).rejects.toBeInstanceOf(SshCommandError);
  });
});

describe("TimekprClient.getUserInfo", () => {
  it("runs --userinfo through execAndParse and returns the parsed struct", async () => {
    const info = await clientFor().getUserInfo();
    expect(transport.parsed).toHaveLength(1);
    expect(transport.parsed[0]?.argv).toEqual([...DEFAULT_TIMEKPRA_BINARY, "--userinfo", "alice"]);
    expect(info.get("TIME_LIMIT_PER_WEEK")).toBe("86400");
  });

  it("lets a parse failure surface (the schema rejects non-userinfo output)", async () => {
    transport.userInfoStdout = "not userinfo output";
    await expect(clientFor().getUserInfo()).rejects.toBeInstanceOf(Error);
  });
});
