/**
 * The live {@link ForceCloseDeps} implementation (#99): wires the force-close
 * trigger (`./force-close.ts`) to the policy DB, the event hub (#100), the
 * Phase-4 SSH facade, and the #85 audit sink. This is the one place those
 * collaborators meet for production; the trigger itself stays pure.
 *
 * Every collaborator is injected so this is unit-testable against an in-memory
 * DB and fakes; the scheduler (#117) constructs it with the real
 * `EventHub` / `SshTransport` / `DrizzleAuditSink` at boot.
 *
 * **Why `pkill` isn't routed through `AuditingTransport`.** That decorator maps
 * any non-zero exit to `failed`, but `pkill` exits `1` when *no process matched*
 * — the normal, expected outcome when the app already closed during grace. So
 * the fallback runs over the raw facade `exec` and records its own audit entry,
 * treating exit `0` and `1` alike as `ok`.
 *
 * License boundary: none touched — Drizzle reads + the SSH subprocess facade
 * (`pkill` is exec-over-SSH, the same boundary as `timekpra`); no GPL code is
 * linked and no GPL binary is added to the image.
 */
import { performance } from "node:perf_hooks";

import { and, eq, inArray } from "drizzle-orm";

import type { ServerEvent } from "../events/taxonomy.js";
import type { ActivityKind, AuditOutcome } from "../policy/enums.js";
import type { PolicyDb } from "../policy/db.js";
import { activities, activitiesToGroups, clients, usersOnClients } from "../policy/schema.js";
import type { AuditSink } from "../transport/audit/index.js";
import { redactArgv } from "../transport/audit/index.js";
import {
  SshExecTimeoutError,
  SshUnreachableError,
  type SshTargetRef,
} from "../transport/ssh/errors.js";
import {
  targetFromClient,
  type ExecOptions,
  type ExecResult,
  type SshCredentials,
  type SshTarget,
} from "../transport/ssh/index.js";

import type { EnforcementScope } from "./decision.js";
import { buildPkillArgv } from "./force-close-pkill.js";
import type { ForceCloseActivity, ForceCloseClient, ForceCloseDeps } from "./force-close.js";

/** The slice of the event hub the deps publish through. */
export interface ForceCloseEventHub {
  publishToClient(clientId: number, event: ServerEvent): number;
}

/** The slice of the SSH facade the `pkill` fallback runs over. */
export interface ForceClosePkillTransport {
  exec(target: SshTarget, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
}

/**
 * The activity kinds whose budget exhaustion is force-closed by killing a
 * process: real apps and app *patterns*. Both accrue window consumption
 * (`transport/activitywatch/normalise.ts` → `WINDOW_RESOLVABLE_KINDS`), so a
 * daily budget on either can exhaust and produce an enforcement decision.
 * Domain / domain-group activities are excluded — those are web-filter
 * enforcement (Phase 6/7), not a process kill.
 */
const FORCE_CLOSABLE_KINDS: readonly ActivityKind[] = ["app", "app_group"];

/** Construction options for {@link createForceCloseDeps}. */
export interface CreateForceCloseDepsOptions {
  readonly db: PolicyDb;
  readonly eventHub: ForceCloseEventHub;
  readonly ssh: ForceClosePkillTransport;
  readonly credentials: SshCredentials;
  readonly sink: AuditSink;
  readonly logger: ForceCloseDeps["logger"];
  /** Timer seam; defaults to `setTimeout`. Overridable in tests. */
  readonly schedule?: ForceCloseDeps["schedule"];
}

/** Max length of a recorded error message, matching the audit transport. */
const MAX_ERROR_MESSAGE = 2000;

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}…` : message;
}

/** The credential-free target ref recorded in an audit entry. */
function targetRef(target: SshTarget): SshTargetRef {
  return { host: target.host, port: target.port ?? 22, username: target.username };
}

/** Outcome + exit fields for a settled `pkill` attempt. */
interface PkillOutcome {
  readonly outcome: AuditOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly errorMessage: string | null;
}

/**
 * Classify a thrown SSH error into its audit outcome. Only the facade's
 * taxonomy is expected; an unexpected throw is still recorded as a failure
 * rather than dropped.
 */
function fromThrown(err: unknown): PkillOutcome {
  const message = truncate(err instanceof Error ? err.message : String(err));
  if (err instanceof SshUnreachableError) {
    return { outcome: "unreachable", exitCode: null, signal: null, errorMessage: message };
  }
  if (err instanceof SshExecTimeoutError) {
    return { outcome: "timeout", exitCode: null, signal: null, errorMessage: message };
  }
  return { outcome: "failed", exitCode: null, signal: null, errorMessage: message };
}

/**
 * Classify a resolved `pkill` result. Exit `0` (signalled a match) and `1` (no
 * match — nothing left to close) are both success; `2`/`3` are usage/fatal
 * errors and recorded as failures.
 */
function fromResult(result: ExecResult): PkillOutcome {
  const ok = result.code === 0 || result.code === 1;
  return {
    outcome: ok ? "ok" : "failed",
    exitCode: result.code,
    signal: result.signal,
    errorMessage: ok
      ? null
      : truncate(`pkill exited ${result.code ?? "by signal"}: ${result.stderr.trim()}`),
  };
}

/**
 * Resolve a decision's `(scope, targetId)` to the process-bearing activities
 * whose apps can be force-closed (see {@link FORCE_CLOSABLE_KINDS}). `activity`
 * scope is the activity itself when it is force-closable; `group` scope (an
 * `activityGroups.id`) expands to its force-closable members.
 */
function resolveActivities(
  db: PolicyDb,
  scope: EnforcementScope,
  targetId: number,
): ForceCloseActivity[] {
  const columns = {
    activityId: activities.id,
    matcher: activities.matcher,
    matchType: activities.matchType,
  };
  if (scope === "activity") {
    return db
      .select(columns)
      .from(activities)
      .where(and(eq(activities.id, targetId), inArray(activities.kind, FORCE_CLOSABLE_KINDS)))
      .all();
  }
  return db
    .select(columns)
    .from(activitiesToGroups)
    .innerJoin(activities, eq(activitiesToGroups.activityId, activities.id))
    .where(
      and(eq(activitiesToGroups.groupId, targetId), inArray(activities.kind, FORCE_CLOSABLE_KINDS)),
    )
    .all();
}

/** Build the live {@link ForceCloseDeps} from its collaborators. */
export function createForceCloseDeps(options: CreateForceCloseDepsOptions): ForceCloseDeps {
  const { db, eventHub, ssh, credentials, sink, logger } = options;
  const schedule =
    options.schedule ?? ((callback, delayMs): void => void setTimeout(callback, delayMs));

  function clientsForUser(userId: number): ForceCloseClient[] {
    return db
      .select({
        clientId: usersOnClients.clientId,
        osUserRef: usersOnClients.osUserRef,
        hostname: clients.hostname,
        sshUser: clients.sshUser,
        sshTarget: clients.sshTarget,
      })
      .from(usersOnClients)
      .innerJoin(clients, eq(usersOnClients.clientId, clients.id))
      .where(eq(usersOnClients.userId, userId))
      .all()
      .map((row) => ({
        clientId: row.clientId,
        osUserRef: row.osUserRef,
        // Honour the per-client SSH-target override (#406) so a force-close
        // dials the same host the policy push does.
        sshTarget: targetFromClient(
          { hostname: row.hostname, sshUser: row.sshUser, sshTarget: row.sshTarget },
          credentials,
        ),
      }));
  }

  async function forceCloseOverSsh(input: {
    readonly client: ForceCloseClient;
    readonly activity: ForceCloseActivity;
    readonly userId: number;
  }): Promise<void> {
    const { client, activity, userId } = input;
    const argv = buildPkillArgv(client.osUserRef, activity.matcher, activity.matchType);
    if (argv === undefined) {
      logger.warn(
        {
          clientId: client.clientId,
          userId,
          activityId: activity.activityId,
          matchType: activity.matchType,
        },
        "force_close pkill skipped: matcher yielded an empty pattern",
      );
      return;
    }

    const startedAt = performance.now();
    let fields: PkillOutcome;
    try {
      fields = fromResult(await ssh.exec(client.sshTarget, argv));
    } catch (err: unknown) {
      fields = fromThrown(err);
    }
    // The sink contract forbids throwing, so auditing can't break the fan-out.
    sink.record({
      target: targetRef(client.sshTarget),
      command: redactArgv(argv),
      outcome: fields.outcome,
      exitCode: fields.exitCode,
      signal: fields.signal,
      durationMs: Math.round(performance.now() - startedAt),
      errorMessage: fields.errorMessage,
      context: {
        clientId: client.clientId,
        userId,
        actor: "system",
        reason: "enforce.force_close",
      },
    });
  }

  function recordEventAudit(input: {
    readonly client: ForceCloseClient;
    readonly userId: number;
    readonly activityId: number;
  }): void {
    const { client, userId, activityId } = input;
    sink.record({
      target: targetRef(client.sshTarget),
      command: [
        "enforce.force_close",
        "--user",
        String(userId),
        "--activity",
        String(activityId),
        "--via",
        "event-stream",
      ],
      outcome: "ok",
      exitCode: null,
      signal: null,
      durationMs: 0,
      errorMessage: null,
      context: {
        clientId: client.clientId,
        userId,
        actor: "system",
        reason: "enforce.force_close",
      },
    });
  }

  return {
    publishToClient: (clientId, event) => eventHub.publishToClient(clientId, event),
    clientsForUser,
    resolveActivities: (scope, targetId) => resolveActivities(db, scope, targetId),
    forceCloseOverSsh,
    recordEventAudit,
    schedule,
    logger,
  };
}
