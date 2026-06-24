/**
 * `TimekprClient` — the typed Timekpr-nExT control surface for one supervised
 * user on one enrolled client.
 *
 * It binds an SSH {@link SshTarget} and an OS `username` to the pure argv
 * builders in {@link ./commands.ts}, runs each command over the Phase-4 SSH
 * facade ({@link ../ssh/facade.ts}) as a **subprocess**, and confirms reads by
 * zod-parsing stdout. Setters use the facade's `execChecked` (a non-zero
 * `timekpra` exit becomes an `SshCommandError`); {@link getUserInfo} uses
 * `execAndParse`. The facade's error taxonomy — `SshUnreachableError` (the
 * offline-queue's retry signal, #84), `SshCommandError`, `SshParseError`,
 * `SshExecTimeoutError` — propagates unchanged, so callers branch on it exactly
 * as they do for any other transport command.
 *
 * License boundary: the dashboard only ever *execs* `timekpra` (GPL) over SSH;
 * it never links Timekpr-nExT in-process and never parses its on-disk state with
 * its own code (`CLAUDE.md` → "License boundaries" rules 1–2;
 * `docs/licensing-analysis.md`). This module adds no new boundary crossing.
 */
import type { ZodType } from "zod";

import type { ExecOptions, ExecResult, SshTarget } from "../ssh/facade.js";
import { buildWeeklyAllowedHoursCommands, type WeeklyAllowedWindows } from "./allowed-hours.js";
import {
  buildSetAllowedDays,
  buildSetAllowedHours,
  buildSetPlayTimeActivities,
  buildSetPlayTimeAllowedDays,
  buildSetPlayTimeEnabled,
  buildSetPlayTimeLimitOverride,
  buildSetPlayTimeLimits,
  buildSetPlayTimeUnaccountedIntervalsEnabled,
  buildSetTimeLeft,
  buildSetTimeLimits,
  buildSetTimeLimitMonth,
  buildSetTimeLimitWeek,
  buildUserInfo,
  type AllowedHour,
  type AllowedHoursDay,
  type IsoWeekday,
  type PlayTimeActivity,
  type TimeLeftOperation,
} from "./commands.js";
import { TimekprArgumentError } from "./errors.js";
import { timekprUserInfoSchema, type TimekprUserInfo } from "./userinfo.js";

/**
 * The slice of {@link SshTransport} the client needs: a checked exec for the
 * setters and a parse-on-success exec for reads. Declared structurally (rather
 * than depending on the whole class) so a real `SshTransport` satisfies it and
 * a test can pass a lightweight fake without an `as` cast.
 */
export interface TimekprTransport {
  execChecked(
    target: SshTarget,
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
  execAndParse<T>(
    target: SshTarget,
    argv: readonly string[],
    schema: ZodType<T>,
    options?: ExecOptions,
  ): Promise<T>;
}

/** The argv prefix that runs the `timekpra` admin CLI as root on the client.
 *
 * `pct-agent` is provisioned with `NOPASSWD: /usr/bin/timekpra` (#78), so the
 * dashboard runs `sudo timekpra …`. Overridable for clients that expose the
 * binary differently. */
export const DEFAULT_TIMEKPRA_BINARY: readonly string[] = ["sudo", "timekpra"];

/** Construction options for {@link TimekprClient}. */
export interface TimekprClientOptions {
  /** Argv prefix invoking `timekpra` on the client. Default {@link DEFAULT_TIMEKPRA_BINARY}. */
  readonly binary?: readonly string[];
  /** Per-exec overrides (e.g. `timeoutMs`) forwarded to the transport. */
  readonly execOptions?: ExecOptions;
}

export class TimekprClient {
  readonly #transport: TimekprTransport;
  readonly #target: SshTarget;
  readonly #username: string;
  readonly #binary: readonly string[];
  readonly #execOptions: ExecOptions | undefined;

  /**
   * @param transport the SSH transport (or a structural stand-in) to run on.
   * @param target the enrolled client to reach.
   * @param username the supervised Linux account `timekpra` acts on.
   * @param options binary override and per-exec options.
   */
  constructor(
    transport: TimekprTransport,
    target: SshTarget,
    username: string,
    options: TimekprClientOptions = {},
  ) {
    const binary = options.binary ?? DEFAULT_TIMEKPRA_BINARY;
    if (binary.length === 0) {
      throw new TimekprArgumentError("timekpra: binary prefix must name the timekpra program");
    }
    // `buildUserInfo` (and every other builder) validates the username, but do
    // it once up front so an invalid name fails at construction rather than on
    // the first call.
    buildUserInfo(username);
    this.#transport = transport;
    this.#target = target;
    this.#username = username;
    this.#binary = binary;
    this.#execOptions = options.execOptions;
  }

  /** The supervised Linux account this client controls. */
  get username(): string {
    return this.#username;
  }

  /** Set the weekdays the user may log in (`--setalloweddays`). */
  setAllowedDays(days: readonly IsoWeekday[]): Promise<ExecResult> {
    return this.#exec(() => buildSetAllowedDays(this.#username, days));
  }

  /** Set the allowed hours for one weekday (or every day) (`--setallowedhours`). */
  setAllowedHours(day: AllowedHoursDay, hours: readonly AllowedHour[]): Promise<ExecResult> {
    return this.#exec(() => buildSetAllowedHours(this.#username, day, hours));
  }

  /**
   * Push a whole week of recurring allowed-access windows (#140) — the
   * effective-policy resolver's per-weekday `allowedWindows` translated to
   * `timekpra` allowed-days + allowed-hours via
   * {@link buildWeeklyAllowedHoursCommands}. Runs `--setalloweddays` first, then
   * the `--setallowedhours` command(s), **in order**, returning each result.
   *
   * Not atomic: a failed step rejects (the facade's `SshCommandError` /
   * `SshUnreachableError` taxonomy propagates unchanged) and leaves earlier
   * steps applied; the offline queue (#84) replays the whole push on the next
   * reachable probe, so a partial application is transient. A window set the
   * `timekpra` grammar cannot represent surfaces as a rejected promise (the
   * builder throws {@link TimekprArgumentError} synchronously, caught by this
   * async method), uniformly with the per-command setters.
   */
  async setWeeklyAllowedHours(weekly: WeeklyAllowedWindows): Promise<ExecResult[]> {
    const commands = buildWeeklyAllowedHoursCommands(this.#username, weekly);
    const results: ExecResult[] = [];
    for (const argv of commands) {
      results.push(
        await this.#transport.execChecked(
          this.#target,
          [...this.#binary, ...argv],
          this.#execOptions,
        ),
      );
    }
    return results;
  }

  /** Set the per-weekday daily session-time limits in seconds (`--settimelimits`). */
  setTimeLimits(perDaySeconds: readonly number[]): Promise<ExecResult> {
    return this.#exec(() => buildSetTimeLimits(this.#username, perDaySeconds));
  }

  /** Set the rolling weekly session-time limit in seconds (`--settimelimitweek`). */
  setTimeLimitWeek(seconds: number): Promise<ExecResult> {
    return this.#exec(() => buildSetTimeLimitWeek(this.#username, seconds));
  }

  /** Set the rolling monthly session-time limit in seconds (`--settimelimitmonth`). */
  setTimeLimitMonth(seconds: number): Promise<ExecResult> {
    return this.#exec(() => buildSetTimeLimitMonth(this.#username, seconds));
  }

  /**
   * Adjust or set the user's **remaining time for today** (`--settimeleft`) —
   * the same-day "add 30 minutes" / "set time left" lever (#257), independent of
   * the standing daily limit. `operation` is `"+"`/`"-"` for an additive delta
   * or `"="` to set outright; `seconds` is a non-negative count.
   */
  setTimeLeft(operation: TimeLeftOperation, seconds: number): Promise<ExecResult> {
    return this.#exec(() => buildSetTimeLeft(this.#username, operation, seconds));
  }

  /** Enable or disable PlayTime (app-group time) for the user (`--setplaytimeenabled`). */
  setPlayTimeEnabled(enabled: boolean): Promise<ExecResult> {
    return this.#exec(() => buildSetPlayTimeEnabled(this.#username, enabled));
  }

  /** Set whether PlayTime limits override the overall limit (`--setplaytimelimitoverride`). */
  setPlayTimeLimitOverride(enabled: boolean): Promise<ExecResult> {
    return this.#exec(() => buildSetPlayTimeLimitOverride(this.#username, enabled));
  }

  /** Set whether PlayTime counts during free hours (`--setplaytimeunaccountedintervalsenabled`). */
  setPlayTimeUnaccountedIntervalsEnabled(enabled: boolean): Promise<ExecResult> {
    return this.#exec(() => buildSetPlayTimeUnaccountedIntervalsEnabled(this.#username, enabled));
  }

  /** Set the weekdays PlayTime is allowed (`--setplaytimealloweddays`). */
  setPlayTimeAllowedDays(days: readonly IsoWeekday[]): Promise<ExecResult> {
    return this.#exec(() => buildSetPlayTimeAllowedDays(this.#username, days));
  }

  /** Set the per-weekday PlayTime limits in seconds (`--setplaytimelimits`). */
  setPlayTimeLimits(perDaySeconds: readonly number[]): Promise<ExecResult> {
    return this.#exec(() => buildSetPlayTimeLimits(this.#username, perDaySeconds));
  }

  /** Set the PlayTime activity matchers (`--setplaytimeactivities`). */
  setPlayTimeActivities(activities: readonly PlayTimeActivity[]): Promise<ExecResult> {
    return this.#exec(() => buildSetPlayTimeActivities(this.#username, activities));
  }

  /** Read the user's current Timekpr configuration (`--userinfo`), zod-parsed. */
  async getUserInfo(): Promise<TimekprUserInfo> {
    return this.#transport.execAndParse(
      this.#target,
      [...this.#binary, ...buildUserInfo(this.#username)],
      timekprUserInfoSchema,
      this.#execOptions,
    );
  }

  /**
   * Run a command as a checked exec. The argv `build`er is invoked **inside**
   * this async method so a {@link TimekprArgumentError} from an out-of-grammar
   * value surfaces as a rejected promise, exactly like the transport's own
   * failures — the method never throws synchronously.
   */
  async #exec(build: () => readonly string[]): Promise<ExecResult> {
    return this.#transport.execChecked(
      this.#target,
      [...this.#binary, ...build()],
      this.#execOptions,
    );
  }
}
