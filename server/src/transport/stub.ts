/**
 * Phase-2 stub transport (#54): the explicit, testable seam where outbound
 * policy pushes will plug in.
 *
 * The roadmap's Phase 2 ships with "no transport integration yet; all 'push'
 * actions are stubbed to log" (`docs/roadmap.md`). Rather than leave that as an
 * unmarked TODO, every mutating policy write (the #51 CRUD routes) runs through
 * this stub: it computes the *intended* per-client effect and **logs** it — no
 * SSH, no Ansible, no external call.
 *
 * The logged {@link PolicyPushCommand} is shaped like the future per-client
 * transport command (target client, affected user, the change detail) so the
 * Phase-4 swap from "log" to "invoke `timekpra` over SSH"
 * (`docs/architecture.md` → "Outbound (server → client) — policy push", steps
 * 2–4) and the Phase-6 Ansible push are drop-in: replace the body of
 * {@link PolicyPushStub.push} with a real dispatch over the
 * `transport/ssh` + `transport/ansible` facades; the call sites and the
 * computed commands do not change.
 *
 * License boundary: none touched — plain TypeScript + the pino logger that
 * already ships inside Fastify. This module *establishes* the
 * subprocess/REST boundary that Phase 4/6 fill in; it does not collapse one.
 */
import type { FastifyBaseLogger } from "fastify";

/** Pino `component` tag identifying stub-transport log lines (per #11). */
export const PUSH_STUB_COMPONENT = "transport/stub";

/** The message every stub "would push" line carries (stable for log queries). */
export const PUSH_STUB_MESSAGE = "stub transport: would push policy change to client";

/**
 * Which policy mutation triggered a would-be push. Mirrors the #51/#148 CRUD
 * operations one-to-one so a log reader can trace a line back to its cause.
 *
 * `budget.*`, `schedule.*`, `exception.*`, and `notification.*` are
 * user-scoped (#148/#104): they change what is enforced or rendered for one
 * supervised user, so a real transport would push to every client that user is
 * linked to — exactly like `user.*`. (A `NotificationPolicy` is pushed "with
 * the rest of policy" and cached client-side; eventual wire delivery is the
 * `policy.changed` event, #100.) Activity / ActivityGroup / membership are
 * *definitions* with no per-client effect until a budget or schedule
 * references them, so they do not push.
 */
export type PolicyPushReason =
  | "user.created"
  | "user.updated"
  | "user.deleted"
  | "client.created"
  | "client.updated"
  | "client.deleted"
  | "link.upserted"
  | "link.deleted"
  | "budget.created"
  | "budget.updated"
  | "budget.deleted"
  | "schedule.created"
  | "schedule.updated"
  | "schedule.deleted"
  | "exception.created"
  | "exception.updated"
  | "exception.deleted"
  | "notification.upserted"
  | "notification.deleted";

/**
 * The intended effect of one policy mutation on **one** client — the unit a
 * Phase-4 transport would dispatch ("invoke `timekpra` over SSH for each
 * affected client").
 */
export interface PolicyPushCommand {
  /** Target client the command would be dispatched to. */
  readonly clientId: number;
  /**
   * Affected user, or `null` for a client-level change not scoped to a single
   * user (e.g. a client record was created/renamed/removed).
   */
  readonly userId: number | null;
  /** The mutation that triggered the push. */
  readonly reason: PolicyPushReason;
  /** Diff detail describing what changed (logged as structured fields). */
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * A change reason that affects every client a single user is linked to: the
 * `user.*` account changes plus the user-scoped policy changes (`budget.*`,
 * `schedule.*`, `exception.*`). All fan out the same way.
 */
export type UserPushReason = Extract<
  PolicyPushReason,
  | `user.${string}`
  | `budget.${string}`
  | `schedule.${string}`
  | `exception.${string}`
  | `notification.${string}`
>;
/** A client-scoped change reason (affects that one client). */
export type ClientPushReason = Extract<PolicyPushReason, `client.${string}`>;
/** A link-scoped change reason (affects that one user/client pair). */
export type LinkPushReason = Extract<PolicyPushReason, `link.${string}`>;

/**
 * Commands for a user-level change: one per client the user is linked to.
 *
 * `clientIds` must be resolved by the caller *before* a delete, since the
 * `UserOnClient` links cascade away with the user (and a budget/schedule/
 * exception delete needs its owner's clients resolved before the row is gone).
 * A user with no links yields an empty list (nothing is enforced anywhere yet →
 * no push).
 */
export function userPushCommands(
  reason: UserPushReason,
  userId: number,
  clientIds: readonly number[],
  detail: Readonly<Record<string, unknown>>,
): PolicyPushCommand[] {
  return clientIds.map((clientId) => ({ clientId, userId, reason, detail }));
}

/** Command for a client-level change: the one client, no specific user. */
export function clientPushCommands(
  reason: ClientPushReason,
  clientId: number,
  detail: Readonly<Record<string, unknown>>,
): PolicyPushCommand[] {
  return [{ clientId, userId: null, reason, detail }];
}

/** Command for a link-level change: the one user on the one client. */
export function linkPushCommands(
  reason: LinkPushReason,
  userId: number,
  clientId: number,
  detail: Readonly<Record<string, unknown>>,
): PolicyPushCommand[] {
  return [{ clientId, userId, reason, detail }];
}

/** The stub transport: logs what a real transport would push. */
export interface PolicyPushStub {
  /**
   * Emit one structured "would push" log line per command. A no-op for an
   * empty list (e.g. a change with no affected clients).
   */
  push(commands: readonly PolicyPushCommand[]): void;
}

/**
 * Build the stub over a base logger (typically `app.log` / the route scope's
 * logger). Binds the {@link PUSH_STUB_COMPONENT} child once so every emitted
 * line carries the `component` field, per the #11 logging convention.
 */
export function createPolicyPushStub(log: FastifyBaseLogger): PolicyPushStub {
  // Deliberately mirrors `web/logger.ts` → `componentLogger` (which is just
  // `app.log.child({ component })`); inlined here because callers hold a bare
  // logger, not the `FastifyInstance` that helper takes.
  const child = log.child({ component: PUSH_STUB_COMPONENT });
  return {
    push(commands) {
      for (const command of commands) {
        child.info(
          {
            clientId: command.clientId,
            userId: command.userId,
            reason: command.reason,
            detail: command.detail,
          },
          PUSH_STUB_MESSAGE,
        );
      }
    },
  };
}
