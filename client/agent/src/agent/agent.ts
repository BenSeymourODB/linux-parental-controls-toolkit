/**
 * The per-user agent orchestrator (#103, Phase 8b).
 *
 * Wires the pieces of `docs/client-notifications.md` → Components/2 together:
 * it reads server events off the bridge socket ({@link AgentSocketClient}) and
 * renders them, and runs a local tick loop that polls the {@link UsageSource},
 * computes each budget's remaining time against the cached totals, and fires the
 * warning cadence + per-app force-close **locally** so warnings tick between
 * server pulls and while briefly offline.
 *
 * Division of labour with the rest of the system:
 * - `grant.applied` / `policy.changed` / `lockout.cleared` render toasts and
 *   (for grants) top up the cached budget + cancel any in-flight countdown.
 * - `enforce.force_close` starts the grace countdown for that activity; the tick
 *   loop starts the *same* countdown as a local fallback when a per-app budget
 *   reaches zero (both idempotent per activity).
 * - `enforce.session_lock` is only announced here — Timekpr-nExT (via the
 *   bridge, Phase 8c) performs the actual session kill; the agent never does.
 *
 * All timers are the injected {@link Scheduler} and every effect is an injected
 * seam, so the whole orchestrator unit-tests deterministically with no clock,
 * sockets, or desktop processes.
 *
 * License boundary: none touched — local socket + REST + subprocess seams only.
 */
import type { Logger } from "../bridge/logger.js";
import type { ServerEvent } from "../bridge/protocol.js";
import { budgetKey, remainingSeconds, type BudgetCache, type CachedBudget } from "./budget.js";
import {
  CadenceTracker,
  coalesceWarnings,
  formatCadenceMessage,
  type CadenceWarning,
  type CoalescedWarning,
} from "./cadence.js";
import type { AgentConfig, NotificationPrefs } from "./config.js";
import { soundNameForEvent, type Notifier, type SoundEvent, type SoundPlayer } from "./effects.js";
import type { ForceClose } from "./force-close.js";
import type { Scheduler, TimerHandle } from "./scheduler.js";
import { AgentSocketClient, type SocketFactory } from "./socket-client.js";
import type { UsageSource } from "./usage.js";

/** A warning at or below this threshold uses the sharper "final-warning" sound. */
const FINAL_WARNING_SECONDS = 60;

/** Everything the {@link Agent} orchestrates through (all injectable). */
export interface AgentOptions {
  config: AgentConfig;
  budgets: BudgetCache;
  usage: UsageSource;
  notifier: Notifier;
  soundPlayer: SoundPlayer;
  forceClose: ForceClose;
  scheduler: Scheduler;
  logger: Logger;
  /** Passed through to the socket client (tests inject a fake socket). */
  socketFactory?: SocketFactory;
  rng?: () => number;
}

/** The running per-user agent: event intake + the local cadence tick loop. */
export class Agent {
  readonly #opts: AgentOptions;
  readonly #prefs: NotificationPrefs;
  readonly #socket: AgentSocketClient;
  readonly #trackers = new Map<string, CadenceTracker>();
  #tickTimer: TimerHandle | null = null;

  constructor(opts: AgentOptions) {
    this.#opts = opts;
    this.#prefs = opts.config.notifications;
    this.#socket = new AgentSocketClient({
      socketPath: opts.config.socketPath,
      onEvent: (event) => void this.#onEvent(event),
      backoff: opts.config.backoff,
      scheduler: opts.scheduler,
      logger: opts.logger,
      ...(opts.socketFactory !== undefined ? { factory: opts.socketFactory } : {}),
      ...(opts.rng !== undefined ? { rng: opts.rng } : {}),
    });
  }

  /** Connect to the bridge and start the cadence tick loop. */
  start(): void {
    this.#socket.start();
    this.#tickTimer = this.#opts.scheduler.interval(() => {
      void this.tick();
    }, this.#opts.config.tickIntervalMs);
    this.#opts.logger.info({ userId: this.#opts.config.userId }, "pct-client-agent started");
  }

  /** Stop the socket, the tick loop, and any in-flight force-close. */
  stop(): void {
    this.#socket.stop();
    if (this.#tickTimer !== null) {
      this.#opts.scheduler.cancel(this.#tickTimer);
      this.#tickTimer = null;
    }
    this.#opts.forceClose.stop();
  }

  /**
   * One cadence tick: read usage, recompute each budget's remaining time, fire
   * the coalesced warnings, and start a local force-close for any per-app
   * budget that reached zero. Exposed for the tick loop and tests.
   */
  async tick(): Promise<void> {
    const usedByKey = await this.#opts.usage.usedSeconds();
    const warnings: CadenceWarning[] = [];
    for (const budget of this.#opts.budgets.list()) {
      const used = usedByKey.get(budget.key) ?? 0;
      const remaining = remainingSeconds(budget.totalSeconds, used);
      const warning = this.#trackerFor(budget).observe(remaining);
      if (warning !== null) warnings.push(warning);
    }
    for (const group of coalesceWarnings(warnings)) await this.#render(group);
  }

  #trackerFor(budget: CachedBudget): CadenceTracker {
    let tracker = this.#trackers.get(budget.key);
    if (tracker === undefined) {
      tracker = new CadenceTracker(budget.key, budget.label, budget.totalSeconds);
      this.#trackers.set(budget.key, tracker);
    }
    return tracker;
  }

  async #render(group: CoalescedWarning): Promise<void> {
    if (group.kind === "timesUp") {
      await this.#renderTimesUp(group);
      return;
    }
    if (this.#prefs.enabled) {
      await this.#opts.notifier.notify({
        title: "Time remaining",
        body: group.message,
        urgency: group.thresholdSeconds <= FINAL_WARNING_SECONDS ? "critical" : "normal",
      });
      await this.#playSound(this.#soundEventFor(group));
    }
  }

  async #renderTimesUp(group: CoalescedWarning): Promise<void> {
    // A per-app budget at zero begins the local grace countdown — whose own
    // countdown toast IS the "time's up" toast, so the agent does not also
    // toast those budgets (that would double up). Only the overall budget,
    // which has no force-close (Timekpr handles the session lock), is toasted.
    const overall = group.budgets.filter((b) => this.#activityIdForKey(b.key) === null);
    for (const b of group.budgets) {
      const activityId = this.#activityIdForKey(b.key);
      if (activityId !== null) await this.#opts.forceClose.begin({ activityId, label: b.label });
    }
    if (overall.length > 0 && this.#prefs.enabled) {
      await this.#opts.notifier.notify({
        title: "Time's up",
        body: formatCadenceMessage({ kind: "timesUp", thresholdSeconds: 0, budgets: overall }),
        urgency: "critical",
      });
      await this.#playSound("timesUp");
    }
  }

  #soundEventFor(group: CoalescedWarning): SoundEvent {
    if (group.kind === "timesUp") return "timesUp";
    return group.thresholdSeconds <= FINAL_WARNING_SECONDS ? "final-warning" : "warning";
  }

  async #onEvent(event: ServerEvent): Promise<void> {
    switch (event.type) {
      case "grant.applied":
        await this.#onGrant(event.activityId, event.grantedSeconds, event.reason);
        break;
      case "policy.changed":
        if (event.summary !== undefined)
          await this.#toast("Limit updated", event.summary, "normal");
        this.#opts.logger.info(
          { userId: event.userId },
          "policy changed; awaiting SSH policy pull",
        );
        break;
      case "enforce.force_close": {
        // The server fires this only after the grace period has already
        // elapsed, so kill straight away rather than starting a fresh countdown.
        const label = this.#opts.budgets.get(budgetKey(event.activityId))?.label ?? "This app";
        await this.#opts.forceClose.forceCloseNow({ activityId: event.activityId, label });
        break;
      }
      case "enforce.session_lock":
        await this.#toast("Time's up", "You're out of screen time for now.", "critical");
        break;
      case "lockout.cleared":
        await this.#toast("More time!", "You can log back in.", "normal");
        break;
    }
  }

  async #onGrant(activityId: number | null, grantedSeconds: number, reason: string): Promise<void> {
    const updated = this.#opts.budgets.applyGrant(activityId, grantedSeconds);
    if (updated !== null) {
      // Re-arm the cadence for the new total so warnings fire again later.
      this.#trackers.set(
        updated.key,
        new CadenceTracker(updated.key, updated.label, updated.totalSeconds),
      );
    } else {
      this.#opts.logger.warn({ activityId }, "grant for an uncached budget; awaiting policy pull");
    }
    // A per-app grant cancels that activity's in-flight force-close countdown.
    if (activityId !== null) {
      await this.#opts.forceClose.cancel(
        activityId,
        `+${minutes(grantedSeconds)} min — keep going`,
      );
    }
    await this.#toast(
      "More time!",
      `+${minutes(grantedSeconds)} min granted · ${reason}`,
      "normal",
    );
    await this.#playSound("grant");
  }

  async #toast(title: string, body: string, urgency: "low" | "normal" | "critical"): Promise<void> {
    if (!this.#prefs.enabled) return;
    await this.#opts.notifier.notify({ title, body, urgency });
  }

  async #playSound(event: SoundEvent): Promise<void> {
    if (!this.#prefs.enabled || this.#prefs.soundProfile === "off") return;
    await this.#opts.soundPlayer.play(soundNameForEvent(event));
  }

  /** The `Activity.id` a budget key targets, or `null` for the overall budget. */
  #activityIdForKey(key: string): number | null {
    const match = /^activity:(\d+)$/.exec(key);
    return match?.[1] !== undefined ? Number(match[1]) : null;
  }
}

/**
 * Whole minutes for a granted-seconds figure, for the toast copy. A positive
 * sub-minute grant rounds up to 1 so it never reads as "+0 min granted".
 */
function minutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}
