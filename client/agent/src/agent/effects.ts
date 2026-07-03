/**
 * Desktop-integration effect seams for the per-user agent (#103, Phase 8b).
 *
 * `docs/client-notifications.md` → Components/2: the agent renders toasts via
 * the desktop notification stack (`gdbus call` against
 * `org.freedesktop.Notifications`, falling back to `notify-send`), plays sounds
 * via `libcanberra`'s `canberra-gtk-play`, and force-closes the user's **own**
 * processes with `SIGTERM`→`SIGKILL`. All of it runs the desktop's own CLI
 * tools as **subprocesses** — "no native D-Bus bindings" — which keeps the
 * agent off any GPL in-process linkage (`CLAUDE.md` → "License boundaries").
 *
 * Every side effect goes through a small injected {@link CommandRunner} (or
 * {@link ProcessSignaller}) seam so the orchestrator and its tests exercise the
 * rendering logic without spawning real desktop processes — the same
 * inject-the-boundary discipline the bridge uses for its WebSocket and timers.
 *
 * License boundary: none touched — `node:child_process` subprocesses only.
 */
import { spawn } from "node:child_process";

import type { Logger } from "../bridge/logger.js";

/** The result of running a command: its exit code and captured output. */
export interface CommandResult {
  /** Process exit code, or `null` if it was terminated by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command and resolves with its {@link CommandResult}. A non-zero exit
 * **resolves** (the caller inspects `code`); the promise only **rejects** when
 * the process could not be spawned at all (e.g. the binary is missing), so a
 * caller can fall back to an alternative renderer.
 */
export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

/** The default {@link CommandRunner}, backed by `node:child_process` `spawn`. */
export class SpawnCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }
}

/** Notification urgency, mapped to the freedesktop `urgency` byte hint. */
export type Urgency = "low" | "normal" | "critical";
const URGENCY_BYTE: Record<Urgency, number> = { low: 0, normal: 1, critical: 2 };

/** What to render in a toast. */
export interface NotifyOptions {
  title: string;
  body: string;
  urgency?: Urgency;
}

/**
 * A handle to a shown notification. `id` is the freedesktop notification id
 * (from `gdbus`) used to replace the toast in place for the grace countdown, or
 * `null` when the fallback path (which cannot update in place) was used.
 */
export interface NotificationHandle {
  id: number | null;
}

/** Renders toasts, optionally replacing one in place (the grace countdown). */
export interface Notifier {
  /** Show a new toast; resolve with a handle usable by {@link update}. */
  notify(options: NotifyOptions): Promise<NotificationHandle>;
  /** Replace an existing toast in place; falls back to a fresh toast. */
  update(handle: NotificationHandle, options: NotifyOptions): Promise<NotificationHandle>;
}

const NOTIFY_DEST = "org.freedesktop.Notifications";
const NOTIFY_PATH = "/org/freedesktop/Notifications";
const NOTIFY_METHOD = "org.freedesktop.Notifications.Notify";
/** freedesktop `expire_timeout`: `-1` lets the server pick a default timeout. */
const DEFAULT_EXPIRE_TIMEOUT = -1;

/**
 * The desktop notifier: `gdbus call … Notify` (which returns a numeric id we
 * can later reuse as `replaces_id` to update the countdown toast in place),
 * falling back to `notify-send` when `gdbus` is unavailable or errors.
 */
export class DesktopNotifier implements Notifier {
  readonly #runner: CommandRunner;
  readonly #appName: string;
  readonly #logger: Logger | undefined;

  constructor(options: { runner: CommandRunner; appName?: string; logger?: Logger }) {
    this.#runner = options.runner;
    this.#appName = options.appName ?? "pct-client-agent";
    this.#logger = options.logger;
  }

  notify(options: NotifyOptions): Promise<NotificationHandle> {
    return this.#send(0, options);
  }

  update(handle: NotificationHandle, options: NotifyOptions): Promise<NotificationHandle> {
    // `replaces_id` 0 means "new toast"; a real id replaces that toast in place.
    return this.#send(handle.id ?? 0, options);
  }

  async #send(replacesId: number, options: NotifyOptions): Promise<NotificationHandle> {
    const hints =
      options.urgency !== undefined ? `{'urgency': <byte ${URGENCY_BYTE[options.urgency]}>}` : "{}";
    const args = [
      "call",
      "--session",
      "--dest",
      NOTIFY_DEST,
      "--object-path",
      NOTIFY_PATH,
      "--method",
      NOTIFY_METHOD,
      this.#appName,
      String(replacesId),
      "", // app_icon
      options.title,
      options.body,
      "[]", // actions (inert here; interactive buttons are #337)
      hints,
      String(DEFAULT_EXPIRE_TIMEOUT),
    ];

    try {
      const result = await this.#runner.run("gdbus", args);
      if (result.code === 0) {
        return { id: parseNotificationId(result.stdout) };
      }
      this.#logger?.warn({ code: result.code, stderr: result.stderr }, "gdbus notify failed");
    } catch (err) {
      this.#logger?.warn({ err }, "gdbus unavailable; falling back to notify-send");
    }
    return this.#fallback(options);
  }

  async #fallback(options: NotifyOptions): Promise<NotificationHandle> {
    const args = [
      ...(options.urgency !== undefined ? ["--urgency", options.urgency] : []),
      options.title,
      options.body,
    ];
    try {
      await this.#runner.run("notify-send", args);
    } catch (err) {
      // Headless / no notification stack: log and continue (a documented
      // degraded mode) — enforcement still happens regardless of the toast.
      this.#logger?.warn({ err }, "notify-send unavailable; dropping toast");
    }
    return { id: null };
  }
}

/** Extract the `uint32 <n>` id `gdbus` prints for a `Notify` call. */
export function parseNotificationId(stdout: string): number | null {
  const match = /uint32\s+(\d+)/.exec(stdout);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

/** The desktop-sound events the agent plays, from `docs/…` → "Sound design". */
export type SoundEvent = "warning" | "final-warning" | "grant" | "timesUp";

/**
 * The freedesktop sound name for an event. The `subtle`/`prominent` profiles
 * use the same *names* (the doc: "the same set"); the profile only decides
 * on/off and, for `prominent`, louder packaged files + channel (that packaging
 * is #106). The `off` profile is handled by the caller, which simply does not
 * play.
 */
export function soundNameForEvent(event: SoundEvent): string {
  switch (event) {
    case "warning":
      return "message-new-instant";
    case "final-warning":
      return "dialog-warning";
    case "grant":
      return "complete";
    case "timesUp":
      return "bell";
  }
}

/** Plays a named desktop sound (a no-op when passed `null`). */
export interface SoundPlayer {
  play(soundName: string | null): Promise<void>;
}

/** Plays sounds through `canberra-gtk-play -i <name>`. */
export class CanberraSoundPlayer implements SoundPlayer {
  readonly #runner: CommandRunner;
  readonly #logger: Logger | undefined;

  constructor(options: { runner: CommandRunner; logger?: Logger }) {
    this.#runner = options.runner;
    this.#logger = options.logger;
  }

  async play(soundName: string | null): Promise<void> {
    if (soundName === null) return;
    try {
      await this.#runner.run("canberra-gtk-play", ["-i", soundName]);
    } catch (err) {
      this.#logger?.warn({ err, soundName }, "canberra-gtk-play unavailable; dropping sound");
    }
  }
}

/** Sends a signal to a process; the seam the force-close state machine kills through. */
export interface ProcessSignaller {
  /** Deliver `signal` to `pid`. Returns `false` if the process is already gone. */
  signal(pid: number, signal: NodeJS.Signals): boolean;
}

/** The default {@link ProcessSignaller}, using `process.kill` on the user's own PIDs. */
export class OsProcessSignaller implements ProcessSignaller {
  signal(pid: number, signal: NodeJS.Signals): boolean {
    try {
      process.kill(pid, signal);
      return true;
    } catch (err) {
      // ESRCH — the process already exited; treat as delivered-enough.
      if (isNoSuchProcess(err)) return false;
      throw err;
    }
  }
}

/** True if `err` is an `ESRCH` ("no such process") errno error. */
function isNoSuchProcess(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ESRCH"
  );
}
