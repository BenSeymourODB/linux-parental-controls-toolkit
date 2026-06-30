/**
 * The enforcement sweep (#292): the long-lived driver that turns each telemetry
 * rollup into per-activity force-closes.
 *
 * After each rollup the dashboard re-checks every supervised user's per-activity
 * / per-group budgets (`docs/architecture.md` → "Inbound — telemetry pull",
 * step 4). This module is that loop: for each supervised user it runs the #98
 * decision seam ({@link evaluateUserEnforcement}), carries the per-user cool-down
 * state across passes (so a near-boundary sample doesn't re-fire every rollup),
 * and feeds the decisions into a single long-lived force-close trigger (#99,
 * `./force-close.ts`) whose in-flight grace timers de-dup across passes.
 *
 * It is built as a seam-injected `start*` unit, mirroring
 * `transport/reapply/scheduler.ts`: every I/O boundary — the DB, the user
 * loader, the decision evaluation, the clock — is injected, so it unit-tests
 * with fakes and no live SSH or WebSocket. `tick()` is the body each cron tick
 * runs and the seam the boot wiring calls right after the telemetry rollup pass
 * (so enforcement reads fresh usage). The boot composition itself — wiring the
 * telemetry pull + the #88 normaliser + this sweep into `main.ts` — is deferred
 * (see the issue), as is cancelling a pending grace timer on a grant top-up
 * (Part 2, the Phase-10 grant pipeline).
 *
 * License boundary: none touched — Drizzle reads + croner over the existing
 * seam-injected #99 trigger. No GPL linkage, no GPL binary added to the image.
 */
import { Cron, type CronOptions } from "croner";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import { resolveEffectiveTz } from "../policy/budget-window.js";
import type { PolicyDb } from "../policy/db.js";
import { users, usersOnClients } from "../policy/schema.js";

import type { EnforcementDecision } from "./decision.js";
import { evaluateUserEnforcement } from "./evaluate.js";

/** croner pattern: every five minutes, matching the telemetry pull cadence. */
export const DEFAULT_SWEEP_PATTERN = "*/5 * * * *";

/** Default cool-down passed to the decision core (#98) — five minutes. */
export const DEFAULT_COOLDOWN_SECONDS = 300;

/** Log component for the sweep's lines. */
export const SWEEP_LOG_COMPONENT = "enforcement/sweep";

/** A supervised user the sweep evaluates: id + nullable effective timezone. */
export interface SupervisedUser {
  readonly id: number;
  readonly tz: string | null;
}

/** Loads the supervised users to evaluate this pass (injected; prod wraps a query). */
export type SupervisedUserLoader = () => readonly SupervisedUser[];

/**
 * The narrow slice of the force-close trigger the sweep drives — one method, so
 * tests can pass a spy and the real `ForceCloseTrigger` (#99) drops in unchanged.
 */
export interface EnforcementTrigger {
  enforce(userId: number, decisions: readonly EnforcementDecision[]): void;
}

/** The decision seam (#98); defaults to {@link evaluateUserEnforcement}. */
export type EvaluateEnforcement = typeof evaluateUserEnforcement;

/** Options for {@link startEnforcementSweep}. */
export interface EnforcementSweepOptions {
  /** Policy store, read-only here. */
  readonly db: PolicyDb;
  /** Loads the supervised users each pass (prod: {@link loadSupervisedUsers}). */
  readonly loadSupervisedUsers: SupervisedUserLoader;
  /** The single long-lived trigger; its grace timers de-dup across passes. */
  readonly trigger: EnforcementTrigger;
  /** Base logger; a {@link SWEEP_LOG_COMPONENT} child is derived. */
  readonly log: FastifyBaseLogger;
  /** Server-default IANA timezone (`User.tz ?? this`, ADR 0001). */
  readonly defaultTz: string;
  /** Cool-down seconds threaded to the decision core; defaults to {@link DEFAULT_COOLDOWN_SECONDS}. */
  readonly cooldownSeconds?: number;
  /** croner pattern; defaults to {@link DEFAULT_SWEEP_PATTERN}. */
  readonly pattern?: string;
  /** IANA timezone the pattern is interpreted in; defaults to the host's. */
  readonly timezone?: string;
  /** Clock seam for the evaluation instant; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Decision seam; defaults to {@link evaluateUserEnforcement}. */
  readonly evaluate?: EvaluateEnforcement;
}

/** Outcome of one sweep pass (logged + returned for diagnostics/tests). */
export interface EnforcementSweepResult {
  /** Supervised users evaluated this pass. */
  readonly evaluated: number;
  /** Users that produced at least one decision fed to the trigger. */
  readonly enforced: number;
  /** Total decisions handed to the trigger this pass. */
  readonly decisions: number;
  /** Users whose evaluation threw and were isolated. */
  readonly failed: number;
}

/** A running sweep the caller can kick manually or stop on shutdown. */
export interface EnforcementSweepHandle {
  /** Run one sweep pass now (also what each cron tick invokes). */
  tick(): EnforcementSweepResult;
  /** Stop the schedule permanently (e.g. on `app.close()`). */
  stop(): void;
}

/**
 * Production {@link SupervisedUserLoader}: the distinct users that hold at least
 * one client link — the supervised population an enforcement decision can act
 * on. Users with no client link are skipped (the trigger would no-op anyway).
 */
export function loadSupervisedUsers(db: PolicyDb): SupervisedUser[] {
  return db
    .selectDistinct({ id: users.id, tz: users.tz })
    .from(users)
    .innerJoin(usersOnClients, eq(usersOnClients.userId, users.id))
    .all();
}

/** An empty cool-down map reused for a user's first pass. */
const EMPTY_LAST_FIRED: ReadonlyMap<string, Date> = new Map();

/** A safe, loggable message for an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start the enforcement sweep and return a handle.
 *
 * The cool-down state and the single trigger are held in this closure across
 * passes. One user's unexpected error is logged and isolated so it never aborts
 * the rest of the pass (mirrors the telemetry / re-apply passes). The state map
 * is rebuilt each pass from the current supervised set, so a user who lost all
 * client links is pruned rather than leaking memory.
 */
export function startEnforcementSweep(options: EnforcementSweepOptions): EnforcementSweepHandle {
  const { db, loadSupervisedUsers: load, trigger, defaultTz } = options;
  const cooldownSeconds = options.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
  const pattern = options.pattern ?? DEFAULT_SWEEP_PATTERN;
  const now = options.now ?? ((): Date => new Date());
  const evaluate = options.evaluate ?? evaluateUserEnforcement;
  const child = options.log.child({ component: SWEEP_LOG_COMPONENT });

  /** Per-user cool-down state carried across passes (keyed by user id). */
  let lastFiredByUser = new Map<number, ReadonlyMap<string, Date>>();

  /**
   * Run one pass. Total — never throws — so it is safe as the bare cron
   * callback: each user's evaluation is isolated, and a failure of the loader
   * itself (or any unexpected pass-level error) is logged and turns the pass
   * into a no-op that leaves the carried cool-down state untouched.
   */
  function tick(): EnforcementSweepResult {
    const at = now();
    const next = new Map<number, ReadonlyMap<string, Date>>();
    let evaluated = 0;
    let enforced = 0;
    let decisions = 0;
    let failed = 0;

    try {
      for (const user of load()) {
        const previous = lastFiredByUser.get(user.id) ?? EMPTY_LAST_FIRED;
        try {
          const outcome = evaluate(
            db,
            {
              userId: user.id,
              now: at,
              tz: resolveEffectiveTz(user.tz, defaultTz),
              cooldownSeconds,
            },
            previous,
          );
          next.set(user.id, outcome.lastFiredAt);
          evaluated += 1;
          if (outcome.decisions.length > 0) {
            trigger.enforce(user.id, outcome.decisions);
            enforced += 1;
            decisions += outcome.decisions.length;
          }
        } catch (error) {
          failed += 1;
          // Preserve a user's prior cool-down state when their evaluation errored,
          // so a transient read failure doesn't reset their hysteresis next pass.
          next.set(user.id, previous);
          child.error(
            { userId: user.id, error: errorMessage(error) },
            "enforcement sweep failed for user; isolating",
          );
        }
      }
      // Replacing (not merging) prunes state for users no longer supervised.
      // Only on a clean loader pass: a thrown loader leaves prior state intact.
      lastFiredByUser = next;
    } catch (error) {
      child.error({ error: errorMessage(error) }, "enforcement sweep pass failed");
    }

    const result: EnforcementSweepResult = { evaluated, enforced, decisions, failed };
    child.info({ ...result }, "enforcement sweep pass complete");
    return result;
  }

  // `protect` is harmless for a synchronous pass; it keeps the option shape
  // aligned with the other schedulers (`scheduleTelemetryPull`). The callback
  // discards `tick`'s diagnostic return so it satisfies croner's void contract;
  // `tick` is total, so there is no throw for a `catch` handler to field.
  const cronOptions: CronOptions = { name: "enforcement-sweep", protect: true };
  if (options.timezone !== undefined) cronOptions.timezone = options.timezone;

  const cron = new Cron(pattern, cronOptions, () => {
    tick();
  });

  return {
    tick,
    stop: (): void => cron.stop(),
  };
}
