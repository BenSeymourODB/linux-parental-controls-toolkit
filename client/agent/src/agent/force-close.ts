/**
 * Grace-period + per-app force-close state machine (#103, Phase 8b).
 *
 * `docs/client-notifications.md` → "Grace period and force-close": when a
 * per-app budget reaches 0:00 (or an `enforce.force_close` arrives), the agent
 * shows the "time's up" toast **immediately** with a visible countdown of the
 * grace period (default 15 s, `policy.grace_seconds`, 0–60), updating the toast
 * each second. If a grant tops the budget back up during the countdown, it is
 * cancelled with a "keep going" toast. After the grace period the agent
 * `SIGTERM`s the activity's processes, waits 5 s, then `SIGKILL`s survivors —
 * always the user's **own** processes, so no privilege escalation.
 *
 * The countdown/kill schedule is driven by an injected {@link Scheduler} so the
 * whole state machine is unit-testable with no real time, matching the bridge's
 * injected-timer discipline. PID resolution is itself an injected seam
 * ({@link ForceCloseDeps.resolvePids}); wiring it to the activity matchers the
 * server pushes to the client is a tracked follow-up, so the kill machinery
 * ships complete while resolution stays degraded (`[]`) until then.
 *
 * License boundary: none touched — signals go through the {@link ProcessSignaller}
 * seam (`process.kill`), never a GPL binary.
 */
import type { Logger } from "../bridge/logger.js";
import type { Notifier, NotificationHandle, ProcessSignaller, SoundPlayer } from "./effects.js";
import { soundNameForEvent } from "./effects.js";

/** An opaque cancellable timer handle from a {@link Scheduler}. */
export interface TimerHandle {
  readonly token: unknown;
}

/** Timer seam: a repeating tick and a one-shot delay, injectable for tests. */
export interface Scheduler {
  interval(callback: () => void, ms: number): TimerHandle;
  timeout(callback: () => void, ms: number): TimerHandle;
  cancel(handle: TimerHandle): void;
}

/** The default {@link Scheduler}, backed by `node:timers` (unref'd). */
export class SystemScheduler implements Scheduler {
  interval(callback: () => void, ms: number): TimerHandle {
    const token = setInterval(callback, ms);
    token.unref?.();
    return { token };
  }
  timeout(callback: () => void, ms: number): TimerHandle {
    const token = setTimeout(callback, ms);
    token.unref?.();
    return { token };
  }
  cancel(handle: TimerHandle): void {
    const token = handle.token;
    // Both clearInterval and clearTimeout accept the same timer object.
    clearInterval(token as ReturnType<typeof setInterval>);
    clearTimeout(token as ReturnType<typeof setTimeout>);
  }
}

/** The budget whose exhaustion triggers a force-close. */
export interface ForceCloseTarget {
  /** The `Activity.id` whose processes to close. */
  activityId: number;
  /** Human label for the countdown toast ("YouTube"). */
  label: string;
}

/** Collaborators the {@link ForceCloseController} acts through. */
export interface ForceCloseDeps {
  notifier: Notifier;
  signaller: ProcessSignaller;
  scheduler: Scheduler;
  /** Resolve the PIDs to close for an activity (degraded `[]` until #wired). */
  resolvePids: (activityId: number) => Promise<number[]>;
  /** Grace-period length in seconds (0 skips the countdown). */
  graceSeconds: number;
  /** Delay between `SIGTERM` and the `SIGKILL` escalation, in ms. */
  sigkillEscalationMs: number;
  /** Optional sound player; a `null` play (or omission) is silent. */
  soundPlayer?: SoundPlayer;
  logger?: Logger;
}

/** Per-activity countdown state. */
interface Countdown {
  target: ForceCloseTarget;
  remaining: number;
  handle: NotificationHandle;
  timer: TimerHandle | null;
}

/**
 * Drives the grace countdown and force-close for each per-app budget that
 * exhausts. One countdown per `activityId` at a time; a repeat `begin` for an
 * activity already counting down is ignored.
 */
export class ForceCloseController {
  readonly #deps: ForceCloseDeps;
  readonly #active = new Map<number, Countdown>();

  constructor(deps: ForceCloseDeps) {
    this.#deps = deps;
  }

  /** Whether a countdown is currently running for an activity (for tests). */
  isCountingDown(activityId: number): boolean {
    return this.#active.has(activityId);
  }

  /**
   * Begin the grace countdown for `target`. Shows the "time's up" toast with
   * the grace countdown, plays the times-up sound, and — after the grace period
   * (immediately if `graceSeconds` is 0) — force-closes the activity.
   */
  async begin(target: ForceCloseTarget): Promise<void> {
    if (this.#active.has(target.activityId)) return;

    const grace = Math.max(0, Math.floor(this.#deps.graceSeconds));
    const handle = await this.#deps.notifier.notify({
      title: "Time's up",
      body: this.#countdownBody(target.label, grace),
      urgency: "critical",
    });
    await this.#deps.soundPlayer?.play(soundNameForEvent("timesUp"));

    const countdown: Countdown = { target, remaining: grace, handle, timer: null };
    this.#active.set(target.activityId, countdown);

    if (grace <= 0) {
      await this.#forceClose(target.activityId);
      return;
    }
    countdown.timer = this.#deps.scheduler.interval(() => this.#tick(target.activityId), 1_000);
  }

  /**
   * Cancel an in-flight countdown because time was restored (a grant top-up),
   * dismissing the countdown with a "keep going" toast. No-op if the activity
   * is not counting down.
   */
  async cancel(activityId: number, message: string): Promise<void> {
    const countdown = this.#active.get(activityId);
    if (countdown === undefined) return;
    if (countdown.timer !== null) this.#deps.scheduler.cancel(countdown.timer);
    this.#active.delete(activityId);
    await this.#deps.notifier.update(countdown.handle, {
      title: "More time!",
      body: message,
      urgency: "normal",
    });
  }

  /** Stop all countdowns and their timers (shutdown). */
  stop(): void {
    for (const countdown of this.#active.values()) {
      if (countdown.timer !== null) this.#deps.scheduler.cancel(countdown.timer);
    }
    this.#active.clear();
  }

  #tick(activityId: number): void {
    const countdown = this.#active.get(activityId);
    if (countdown === undefined) return;
    countdown.remaining -= 1;
    if (countdown.remaining > 0) {
      void this.#deps.notifier
        .update(countdown.handle, {
          title: "Time's up",
          body: this.#countdownBody(countdown.target.label, countdown.remaining),
          urgency: "critical",
        })
        .then((h) => {
          countdown.handle = h;
        });
      return;
    }
    if (countdown.timer !== null) this.#deps.scheduler.cancel(countdown.timer);
    countdown.timer = null;
    void this.#forceClose(activityId);
  }

  async #forceClose(activityId: number): Promise<void> {
    const countdown = this.#active.get(activityId);
    if (countdown === undefined) return;

    const pids = await this.#deps.resolvePids(activityId);
    if (pids.length === 0) {
      this.#deps.logger?.warn(
        { activityId },
        "force-close: no processes resolved for activity (degraded until client-side matchers land)",
      );
      this.#active.delete(activityId);
      return;
    }

    for (const pid of pids) this.#deps.signaller.signal(pid, "SIGTERM");
    this.#deps.logger?.info({ activityId, pids, signal: "SIGTERM" }, "force-close: SIGTERM sent");

    this.#deps.scheduler.timeout(() => {
      for (const pid of pids) this.#deps.signaller.signal(pid, "SIGKILL");
      this.#deps.logger?.info({ activityId, pids, signal: "SIGKILL" }, "force-close: SIGKILL sent");
      this.#active.delete(activityId);
    }, this.#deps.sigkillEscalationMs);
  }

  #countdownBody(label: string, secondsLeft: number): string {
    if (secondsLeft <= 0) return `${label} is out of time — closing now.`;
    const unit = secondsLeft === 1 ? "second" : "seconds";
    return `${label} is out of time. Save now — closing in ${secondsLeft} ${unit}.`;
  }
}
