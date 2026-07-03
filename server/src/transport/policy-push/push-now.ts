/**
 * The manual "push saved policy now" lever (#304, Phase 4 transport).
 *
 * An admin affordance that re-pushes a supervised user's **currently saved**
 * effective policy to the client(s) they are linked to, and reports a per-client
 * result. Unlike the CRUD routes' fire-and-forget dispatcher
 * (`./dispatcher.ts`), this **awaits** the push so the admin gets an
 * applied/queued/failed answer back for each client.
 *
 * It reuses the exact executor path the CRUD pushes and the offline-queue
 * drainer use ({@link import("../queue/facade.js").pushOrEnqueue} over the
 * injected {@link ActionExecutor}), so it needs no new remote plumbing:
 *
 * - The executor resolves the user's **own persisted** budgets/schedules and
 *   sends **absolute** `timekpra` limits — an idempotent push. Re-pushing is
 *   therefore safe, and (unlike the additive `--settimeleft` time-today lever,
 *   which is deliberately online-only) a re-push to an unreachable client is
 *   safe to durably **queue** for idempotent replay on reconnect — reported as
 *   `queued` rather than a bare failure.
 * - Every issued command is recorded in the audit log (#85) for free, because
 *   the injected executor runs `timekpra` over the `AuditingTransport`. The
 *   bootstrap injects an **admin-attributed** executor here (mirroring the
 *   time-today lever), so a deliberate re-push is distinguishable from the
 *   `actor:"system"` CRUD-side-effect pushes; a queued replay of an offline
 *   client is later driven by the system drainer and attributed accordingly.
 *
 * The what-if edits in the preview UI are **not** persisted by this lever; it
 * pushes the saved policy. Persist-then-push from a real combined editor is
 * #343.
 *
 * License boundary: none touched — orchestration over Drizzle + the injected
 * executor, which execs `timekpra` over the SSH subprocess facade. No GPL code
 * is linked in-process (`CLAUDE.md` → "License boundaries").
 */
import type { PolicyDb } from "../../policy/db.js";
import { getClient, listUserLinks } from "../../policy/repository.js";
import { pushOrEnqueue } from "../queue/facade.js";
import { queuedActionFromPolicyPush } from "../queue/policy-push.js";
import { errorMessage, type ActionExecutor } from "../queue/types.js";
import type { PolicyPushCommand } from "../stub.js";

/**
 * Per-client outcome of a manual push. `pushed` — delivered now; `queued` — the
 * client was unreachable, so the idempotent absolute push was durably queued for
 * replay on reconnect (#84); `failed` — a non-retriable error (the command
 * itself failed, or the client row vanished mid-fan-out).
 */
export type PolicyPushNowStatus = "pushed" | "queued" | "failed";

/** What happened on one client for a manual push. */
export interface ClientPushResult {
  /** The client the push targeted. */
  readonly clientId: number;
  /** The client's hostname (for the UI). */
  readonly hostname: string;
  /** The supervised Linux account on that client. */
  readonly osUsername: string;
  /** Whether the push was delivered, queued for replay, or failed. */
  readonly status: PolicyPushNowStatus;
  /** A secret-free summary for a non-`pushed` outcome. */
  readonly error?: string;
}

/** The outcome of a manual push across all targeted clients. */
export interface PushUserPolicyResult {
  readonly results: ClientPushResult[];
}

/** A single manual-push request. */
export interface PushUserPolicyRequest {
  /** The supervised user whose saved policy is re-pushed. */
  readonly userId: number;
  /**
   * Restrict the push to one client the user is linked to; when omitted it
   * pushes to **every** client the user is linked to.
   */
  readonly clientId?: number;
}

/**
 * Applies a manual "push saved policy now" over the live transport. Awaitable
 * (unlike the fire-and-forget dispatcher) so the admin route can return a
 * per-client result. Present only when the live transport is wired (SSH key
 * exists); absent, the route reports the transport as unavailable (503).
 */
export type PolicyPushNow = (request: PushUserPolicyRequest) => Promise<PushUserPolicyResult>;

/** Distinguishes "no such link" (a caller error) from a per-client push failure. */
export class PushNowTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushNowTargetError";
  }
}

/**
 * Re-push `userId`'s saved policy to each of their linked clients (or the single
 * `clientId` requested).
 *
 * Targeting errors throw {@link PushNowTargetError} (the caller maps these to a
 * 4xx): the user has no links, or the requested `clientId` is not one of them. A
 * per-client *push* failure never throws — it is captured in that client's
 * {@link ClientPushResult} (`queued` for the retriable SSH taxonomy via the
 * offline queue, `failed` otherwise) so a partial fan-out still returns a full
 * report.
 */
export async function pushUserPolicyNow(
  db: PolicyDb,
  executor: ActionExecutor,
  request: PushUserPolicyRequest,
): Promise<PushUserPolicyResult> {
  const { userId, clientId } = request;

  const links = listUserLinks(db, userId);
  const targets = clientId === undefined ? links : links.filter((l) => l.clientId === clientId);

  if (clientId !== undefined && targets.length === 0) {
    throw new PushNowTargetError(`User ${userId} is not linked to client ${clientId}`);
  }
  if (targets.length === 0) {
    throw new PushNowTargetError(`User ${userId} is not linked to any client; nothing to push`);
  }

  const results: ClientPushResult[] = [];
  for (const link of targets) {
    // The client could have been deleted between the link read and here; report
    // a dangling link as failed rather than crashing the whole fan-out.
    const client = getClient(db, link.clientId);
    if (client === undefined) {
      results.push({
        clientId: link.clientId,
        hostname: `client ${link.clientId}`,
        osUsername: link.osUsername,
        status: "failed",
        error: `Client ${link.clientId} no longer exists`,
      });
      continue;
    }

    // The user-scoped command re-pushes the user's whole effective policy for
    // this client — the same shape a CRUD `user.updated` push carries — so the
    // executor recomputes and sends absolute limits.
    const command: PolicyPushCommand = {
      clientId: link.clientId,
      userId,
      reason: "user.updated",
      detail: { trigger: "manual.push-now" },
    };

    try {
      const outcome = await pushOrEnqueue(db, queuedActionFromPolicyPush(command), executor);
      results.push({
        clientId: link.clientId,
        hostname: client.hostname,
        osUsername: link.osUsername,
        status: outcome.status === "queued" ? "queued" : "pushed",
        ...(outcome.status === "queued" ? { error: outcome.reason } : {}),
      });
    } catch (error) {
      // `pushOrEnqueue` only rethrows a non-retriable failure (the command
      // itself is wrong) — a retriable one is queued above, never thrown.
      results.push({
        clientId: link.clientId,
        hostname: client.hostname,
        osUsername: link.osUsername,
        status: "failed",
        error: errorMessage(error),
      });
    }
  }

  return { results };
}
