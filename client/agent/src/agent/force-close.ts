/**
 * Grace-period + per-app force-close state machine (#103, Phase 8b).
 *
 * `docs/client-notifications.md` → "Grace period and force-close": when a
 * per-app budget reaches 0:00 **locally** the agent shows the "time's up" toast
 * immediately with a visible countdown of the grace period (default 15 s,
 * `policy.grace_seconds`, 0–60), updating the toast each second; if a grant tops
 * the budget back up during the countdown it is cancelled with a "keep going"
 * toast. After the grace period the agent `SIGTERM`s the activity's processes,
 * waits 5 s, then `SIGKILL`s survivors — always the user's **own** processes.
 * A server `enforce.force_close` means the grace period has *already* elapsed
 * server-side, so {@link ForceCloseController.forceCloseNow} skips the countdown
 * and kills straight away.
 *
 * Toasts and sound respect the per-user {@link ForceCloseDeps.renderToasts}
 * master switch and the injected sound player (which `main.ts` omits when the
 * profile is `off`) — enforcement runs regardless, but the *UX* around it obeys
 * the notification policy, matching what `agent.ts` does for its own toasts.
 *
 * The countdown/kill schedule is driven by an injected {@link Scheduler} so the
 * whole state machine is unit-testable with no real time. PID resolution is an
 * injected seam ({@link ForceCloseDeps.resolvePids}); wiring it to the activity
 * matchers the server pushes to the client is a tracked follow-up (#381), so the
 * kill machinery ships complete while resolution stays degraded (`[]`).
 *
 * License boundary: none touched — signals go through the {@link ProcessSignaller}
 * seam (`process.kill`), never a GPL binary.
 */
import type { Logger } from "../bridge/logger.js";
import type { Notifier, NotificationHandle, ProcessSignaller, SoundPlayer } from "./effects.js";
import { soundNameForEvent } from "./effects.js";
import type { Scheduler, TimerHandle } from "./scheduler.js";

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
  /** Resolve the PIDs to close for an activity (degraded `[]` until #381). */
  resolvePids: (activityId: number) => Promise<number[]>;
  /** Grace-period length in seconds (0 skips the countdown). */
  graceSeconds: number;
  /** Delay between `SIGTERM` and the `SIGKILL` escalation, in ms. */
  sigkillEscalationMs: number;
  /** Whether to render countdown/keep-going toasts (the `enabled` master switch). */
  renderToasts: boolean;
  /** Optional sound player; omitted when the sound profile is `off`. */
  soundPlayer?: SoundPlayer;
  logger?: Logger;
}

/** The force-close surface the agent orchestrator drives (injectable in tests). */
export interface ForceClose {
  begin(target: ForceCloseTarget): Promise<void>;
  forceCloseNow(target: ForceCloseTarget): Promise<void>;
  cancel(activityId: number, message: string): Promise<void>;
  stop(): void;
}

/** Per-activity countdown state. */
interface Countdown {
  target: ForceCloseTarget;
  remaining: number;
  handle: NotificationHandle;
  /** The 1 Hz countdown interval (null once the countdown has elapsed). */
  timer: TimerHandle | null;
  /** The pending SIGTERM→SIGKILL escalation timeout (null until SIGTERM sent). */
  escalation: TimerHandle | null;
}

/**
 * Drives the grace countdown and force-close for each per-app budget that
 * exhausts. One countdown per `activityId` at a time; a repeat `begin` /
 * `forceCloseNow` for an activity already in flight is ignored.
 */
export class ForceCloseController implements ForceClose {
  readonly #deps: ForceCloseDeps;
  readonly #active = new Map<number, Countdown>();

  constructor(deps: ForceCloseDeps) {
    this.#deps = deps;
  }

  /** Whether a countdown or escalation is in flight for an activity (for tests). */
  isCountingDown(activityId: number): boolean {
    return this.#active.has(activityId);
  }

  /**
   * Begin the local grace countdown for `target`: the "time's up" toast + the
   * per-second countdown, then force-close after the grace period (immediately
   * if `graceSeconds` is 0). Used for the local pre-zero decision.
   */
  begin(target: ForceCloseTarget): Promise<void> {
    return this.#start(target, Math.max(0, Math.floor(this.#deps.graceSeconds)));
  }

  /**
   * Force-close `target` immediately, with no grace countdown — the server's
   * `enforce.force_close` fires only after the grace period has already elapsed
   * server-side, so a fresh countdown would double the wait.
   */
  forceCloseNow(target: ForceCloseTarget): Promise<void> {
    return this.#start(target, 0);
  }

  async #start(target: ForceCloseTarget, grace: number): Promise<void> {
    if (this.#active.has(target.activityId)) return;

    const handle = await this.#notify({
      title: "Time's up",
      body: this.#countdownBody(target.label, grace),
      urgency: "critical",
    });
    await this.#playTimesUp();

    const countdown: Countdown = {
      target,
      remaining: grace,
      handle,
      timer: null,
      escalation: null,
    };
    this.#active.set(target.activityId, countdown);

    if (grace <= 0) {
      await this.#forceClose(target.activityId);
      return;
    }
    countdown.timer = this.#deps.scheduler.interval(() => this.#tick(target.activityId), 1_000);
  }

  /**
   * Cancel an in-flight force-close because time was restored (a grant top-up),
   * dismissing it with a "keep going" toast. Cancels both the countdown and any
   * pending SIGKILL escalation, so a grant that lands in the escalation window
   * truly spares the process. No-op if the activity is not in flight.
   */
  async cancel(activityId: number, message: string): Promise<void> {
    const countdown = this.#active.get(activityId);
    if (countdown === undefined) return;
    this.#clearTimers(countdown);
    this.#active.delete(activityId);
    await this.#update(countdown.handle, { title: "More time!", body: message, urgency: "normal" });
  }

  /** Stop all in-flight countdowns and escalations (shutdown). */
  stop(): void {
    for (const countdown of this.#active.values()) this.#clearTimers(countdown);
    this.#active.clear();
  }

  #tick(activityId: number): void {
    const countdown = this.#active.get(activityId);
    if (countdown === undefined) return;
    countdown.remaining -= 1;
    if (countdown.remaining > 0) {
      void this.#update(countdown.handle, {
        title: "Time's up",
        body: this.#countdownBody(countdown.target.label, countdown.remaining),
        urgency: "critical",
      }).then((h) => {
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
        "force-close: no processes resolved for activity (degraded until client-side matchers land, #381)",
      );
      this.#active.delete(activityId);
      return;
    }

    for (const pid of pids) this.#deps.signaller.signal(pid, "SIGTERM");
    this.#deps.logger?.info({ activityId, pids, signal: "SIGTERM" }, "force-close: SIGTERM sent");

    countdown.escalation = this.#deps.scheduler.timeout(() => {
      for (const pid of pids) this.#deps.signaller.signal(pid, "SIGKILL");
      this.#deps.logger?.info({ activityId, pids, signal: "SIGKILL" }, "force-close: SIGKILL sent");
      this.#active.delete(activityId);
    }, this.#deps.sigkillEscalationMs);
  }

  #clearTimers(countdown: Countdown): void {
    if (countdown.timer !== null) this.#deps.scheduler.cancel(countdown.timer);
    if (countdown.escalation !== null) this.#deps.scheduler.cancel(countdown.escalation);
  }

  #notify(options: Parameters<Notifier["notify"]>[0]): Promise<NotificationHandle> {
    if (!this.#deps.renderToasts) return Promise.resolve({ id: null });
    return this.#deps.notifier.notify(options);
  }

  #update(
    handle: NotificationHandle,
    options: Parameters<Notifier["notify"]>[0],
  ): Promise<NotificationHandle> {
    if (!this.#deps.renderToasts) return Promise.resolve(handle);
    return this.#deps.notifier.update(handle, options);
  }

  async #playTimesUp(): Promise<void> {
    if (!this.#deps.renderToasts) return;
    await this.#deps.soundPlayer?.play(soundNameForEvent("timesUp"));
  }

  #countdownBody(label: string, secondsLeft: number): string {
    if (secondsLeft <= 0) return `${label} is out of time — closing now.`;
    const unit = secondsLeft === 1 ? "second" : "seconds";
    return `${label} is out of time. Save now — closing in ${secondsLeft} ${unit}.`;
  }
}
