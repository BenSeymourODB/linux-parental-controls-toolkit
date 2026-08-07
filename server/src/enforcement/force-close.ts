/**
 * The per-activity **force-close trigger** (#99, Phase 8).
 *
 * Turns the enforcement *decisions* (#98, `./decision.ts`) into action: after a
 * decision's grace period elapses, ask each of the user's clients to close the
 * over-budget app. The preferred path is the event stream — emit
 * `enforce.force_close` (#100) and let the per-user `pct-client-agent` do the
 * kill, avoiding an SSH round-trip and a privileged client helper
 * (`docs/roadmap.md` → Phase 8). When no agent receives that frame, fall back to
 * an ad-hoc, user-scoped `pkill` over the Phase-4 SSH facade. Both paths are
 * recorded in the #85 audit log.
 *
 * This module is the pure orchestration core: the grace timer, the
 * decision→client fan-out, and the "agent reachable? else pkill" choice. Every
 * I/O boundary (DB reads, the event hub, the SSH command, the audit sink, the
 * clock/timer) is injected via {@link ForceCloseDeps} so it unit-tests with
 * fakes and no live SSH or WebSocket. The DB/transport/hub/sink-backed
 * implementation of those deps is `./force-close-deps.ts`; the croner that
 * calls {@link ForceCloseTrigger.enforce} after each telemetry rollup is the
 * scheduler (#117), wired separately.
 *
 * **The delivery count is the dispatch signal, not a separate probe.**
 * `publishToClient` returns how many live sockets actually received the frame;
 * `> 0` means an agent has it and will do the kill. `0` means none did — the
 * client is offline, **or** it is connected but did not advertise the
 * `per_app_close` capability, so the hub withheld the frame it couldn't honour
 * (ADR 0007 §4). Both cases resolve to the same correct fallback: the
 * capability-independent, server-side SSH `pkill` (which is how such a client is
 * enforced at all), audited as the SSH path it actually took. Reading delivery
 * rather than a prior `isClientLive()` also closes the check-then-close race (a
 * socket dropping between the two) for free.
 *
 * License boundary: none touched — plain TypeScript over injected seams.
 */
import type { ServerEvent } from "../events/taxonomy.js";
import type { MatchType } from "../policy/enums.js";
import type { SshTarget } from "../transport/ssh/facade.js";

import type { EnforcementDecision, EnforcementScope } from "./decision.js";

/** One client a supervised user is enrolled on, with what the fallback needs. */
export interface ForceCloseClient {
  /** `Client.id` — the event hub's fan-out key and the audit attribution. */
  readonly clientId: number;
  /** The supervised account reference (`users_on_clients.os_user_ref`, a uid). */
  readonly osUserRef: string;
  /** The SSH target for the `pkill` fallback (host/user/key already resolved). */
  readonly sshTarget: SshTarget;
}

/** One app activity to force-close, resolved from a decision's `(scope,target)`. */
export interface ForceCloseActivity {
  /** `Activity.id` carried in the `enforce.force_close` event. */
  readonly activityId: number;
  /** The process matcher (`activities.matcher`) for the `pkill` fallback. */
  readonly matcher: string;
  /** How `matcher` is interpreted (`activities.match_type`, ADR 0006). */
  readonly matchType: MatchType;
}

/** The narrow logger the trigger reports unexpected dispatch failures to. */
export interface ForceCloseLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** The injected I/O seams the trigger drives. See the module doc. */
export interface ForceCloseDeps {
  /** Publish one event to a client's live connections; returns sockets reached. */
  publishToClient(clientId: number, event: ServerEvent): number;
  /** The clients a supervised user is enrolled on (empty ⇒ nothing to do). */
  clientsForUser(userId: number): readonly ForceCloseClient[];
  /** Expand a decision's `(scope, targetId)` into the concrete apps to close. */
  resolveActivities(scope: EnforcementScope, targetId: number): readonly ForceCloseActivity[];
  /**
   * Run the user-scoped `pkill` fallback for one app on a client whose agent
   * did not receive the event frame (offline, or lacking `per_app_close`) and
   * record its audit entry. Contract: **never throws** — it audits every
   * outcome (including failures) so a wedged client can't break the fan-out.
   */
  forceCloseOverSsh(input: {
    readonly client: ForceCloseClient;
    readonly activity: ForceCloseActivity;
    readonly userId: number;
  }): Promise<void>;
  /** Record the audit entry for a force-close delivered over the event stream. */
  recordEventAudit(input: {
    readonly client: ForceCloseClient;
    readonly userId: number;
    readonly activityId: number;
  }): void;
  /** Timer seam: invoke `callback` after `delayMs` (real `setTimeout` in prod). */
  schedule(callback: () => void, delayMs: number): void;
  readonly logger: ForceCloseLogger;
}

/** The cool-down/de-dup key for a pending force-close. */
function pendingKey(userId: number, scope: EnforcementScope, targetId: number): string {
  return `${userId}:${scope}:${targetId}`;
}

/**
 * Schedules and dispatches per-activity force-closes from enforcement decisions.
 *
 * One instance is held by the scheduler (#117) across rollups so its in-flight
 * grace timers de-dup against repeated decisions for the same target.
 */
export class ForceCloseTrigger {
  readonly #deps: ForceCloseDeps;
  /** Targets with a force-close already scheduled (cleared when it fires). */
  readonly #pending = new Set<string>();

  constructor(deps: ForceCloseDeps) {
    this.#deps = deps;
  }

  /**
   * Schedule a force-close for each decision after its grace period. A target
   * already pending grace is skipped, so re-deciding it on the next rollup (the
   * decision core's cool-down permitting) doesn't double-fire.
   */
  enforce(userId: number, decisions: readonly EnforcementDecision[]): void {
    for (const decision of decisions) {
      const key = pendingKey(userId, decision.scope, decision.targetId);
      if (this.#pending.has(key)) continue;
      this.#pending.add(key);
      this.#deps.schedule(() => {
        this.#pending.delete(key);
        this.#dispatch(userId, decision).catch((err: unknown) => {
          this.#deps.logger.error(
            { err, userId, scope: decision.scope, targetId: decision.targetId },
            "force_close dispatch failed",
          );
        });
      }, decision.graceSeconds * 1000);
    }
  }

  /** Fan one elapsed-grace decision out to every client the user is on. */
  async #dispatch(userId: number, decision: EnforcementDecision): Promise<void> {
    const activities = this.#deps.resolveActivities(decision.scope, decision.targetId);
    if (activities.length === 0) {
      this.#deps.logger.warn(
        { userId, scope: decision.scope, targetId: decision.targetId },
        "force_close decision resolved to no closable app activities; skipping",
      );
      return;
    }

    const clients = this.#deps.clientsForUser(userId);
    if (clients.length === 0) {
      this.#deps.logger.warn({ userId }, "force_close: user is enrolled on no clients; skipping");
      return;
    }

    for (const client of clients) {
      for (const activity of activities) {
        await this.#closeOnClient(userId, client, activity);
      }
    }
  }

  /** Emit the event to one client, or `pkill`-fall-back if no agent received it. */
  async #closeOnClient(
    userId: number,
    client: ForceCloseClient,
    activity: ForceCloseActivity,
  ): Promise<void> {
    const event: ServerEvent = {
      type: "enforce.force_close",
      userId,
      activityId: activity.activityId,
    };
    const delivered = this.#deps.publishToClient(client.clientId, event);
    if (delivered > 0) {
      this.#deps.recordEventAudit({ client, userId, activityId: activity.activityId });
      return;
    }
    // No agent received the frame on this client (offline, or it lacks the
    // per_app_close capability so the hub withheld it) — fall back to the SSH
    // pkill, the capability-independent enforcement path. Defensive catch only:
    // forceCloseOverSsh's contract is to audit + swallow, but a bug there must
    // not abort the rest of the fan-out.
    try {
      await this.#deps.forceCloseOverSsh({ client, activity, userId });
    } catch (err: unknown) {
      this.#deps.logger.error(
        { err, clientId: client.clientId, userId, activityId: activity.activityId },
        "force_close pkill fallback threw unexpectedly",
      );
    }
  }
}
