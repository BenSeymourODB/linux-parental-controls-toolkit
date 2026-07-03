/**
 * The save-and-push **preview** endpoint (#64, Phase 4):
 * `POST /api/users/:userId/policy-preview`.
 *
 * Before an admin commits a policy edit, this shows exactly what the push would
 * change — and which clients it would reach. It resolves the user's *current*
 * persisted policy and the *proposed* policy in the request body through the one
 * Phase-4 resolver (`transport/policy-push/resolve.ts`), diffs the two resolved
 * pushes (`transport/policy-push/diff.ts`), and lists the user's linked clients
 * annotated with their last-seen time and current offline-queue depth.
 *
 * **Faithful to what is actually pushed.** Current policy is read with the
 * group-aware `gatherUserScheduleRules` + `gatherUserBudgets` — exactly what the
 * live executor (`transport/policy-push/executor.ts`) now resolves and pushes
 * since group rules reach `timekpra` (#362). The *proposed* side merges the
 * request body's own rules with the same persisted group layer
 * (`mergeScheduleRulesWithGroups` / `mergeBudgetsWithGroups`): the admin editor
 * only edits the user's own rules, so an accurate preview holds the group layer
 * constant on both sides and diffs only the own-rule change the push will re-merge.
 *
 * **Side-effect-free by default.** Preview reads + computes only: no SSH probe,
 * no push, no queue write. The per-client push-vs-queue decision still happens
 * at push time against live reachability (`pushOrEnqueue`); the annotations here
 * are the honest, cheap signals available without touching a client. A request
 * may **opt in** to a live-reachability probe (`probe: true`), which — only when
 * the live SSH prober is wired (#39) — additionally reaches each affected client
 * to report an `online`/`offline`/`unknown` marker, reusing the Phase-4
 * `ClientProber` seam and the #198 bounded fan-out. That probe is the only side
 * effect, and it bumps `last_seen` on a client that answers, exactly like the
 * Clients-page health probe.
 *
 * **Scope.** SSH + `timekpra` session limits (what `resolve.ts` models on
 * `main`). The Ansible-side filter diff (e2guardian / iptables) is Phase 6 (#90)
 * and is a tracked follow-up.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle over the
 * read-only policy/queue seams.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Settings } from "../../config.js";
import { resolveEffectiveTz } from "../../policy/budget-window.js";
import type { PolicyDb } from "../../policy/db.js";
import {
  gatherUserBudgets,
  gatherUserScheduleRules,
  mergeBudgetsWithGroups,
  mergeScheduleRulesWithGroups,
} from "../../policy/group-resolution.js";
import * as repo from "../../policy/repository.js";
import type { ClientRow } from "../../policy/repository.js";
import type { BudgetInput } from "../../policy/resolve.js";
import type { ScheduleRule } from "../../policy/schedule-precedence.js";
import type { ClientProber, ClientReachability } from "../../transport/health/index.js";
import { diffResolvedPush } from "../../transport/policy-push/diff.js";
import { resolvePolicyPush } from "../../transport/policy-push/resolve.js";
import { listForClient } from "../../transport/queue/index.js";
import { mapWithConcurrency, timerDeadline, type DeadlineFactory } from "../../util/concurrency.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  policyPreviewRequestSchema,
  type PolicyPreviewRequest,
  type PolicyPreviewResponse,
  type PreviewAffectedClient,
} from "./preview-dtos.js";

/** `:userId` path param for the preview route. */
const previewParamsSchema = z.object({ userId: z.coerce.number().int().positive() });

/** Map a proposed budget DTO onto the resolver's {@link BudgetInput}. */
function toBudgetInput(b: PolicyPreviewRequest["budgets"][number]): BudgetInput {
  return {
    scope: b.scope,
    targetId: b.targetId,
    window: b.window,
    secondsAllowed: b.secondsAllowed,
  };
}

/** Map a proposed schedule DTO onto the resolver's {@link ScheduleRule}. */
function toScheduleRule(s: PolicyPreviewRequest["schedules"][number]): ScheduleRule {
  return {
    id: s.id,
    ordinal: s.ordinal,
    targetKind: s.targetKind,
    targetId: s.targetId,
    action: s.action,
    recurrenceDays: s.recurrenceDays,
    recurrenceStartMinute: s.recurrenceStartMinute,
    recurrenceEndMinute: s.recurrenceEndMinute,
    effectiveFrom: s.effectiveFrom === null ? null : new Date(s.effectiveFrom),
    effectiveTo: s.effectiveTo === null ? null : new Date(s.effectiveTo),
  };
}

/** A client row the user's push fans out to, paired with its pending depth. */
interface AffectedClientBase {
  readonly client: ClientRow;
  readonly pendingQueueDepth: number;
}

/**
 * The client rows the user's push fans out to, each paired with its
 * pending-queue depth. Ascending by client id for a stable render. This is the
 * cheap, side-effect-free gather; the optional reachability probe layers on top.
 */
function gatherAffectedClients(db: PolicyDb, userId: number): AffectedClientBase[] {
  const result: AffectedClientBase[] = [];
  for (const link of repo.listUserLinks(db, userId)) {
    const client = repo.getClient(db, link.clientId);
    if (client === undefined) continue;
    const pendingQueueDepth = listForClient(db, client.id).filter(
      (row) => row.status === "pending",
    ).length;
    result.push({ client, pendingQueueDepth });
  }
  return result.sort((a, b) => a.client.id - b.client.id);
}

/** The reachability annotation a probe produces for one client. */
interface ReachabilityAnnotation {
  readonly reachability: ClientReachability;
  /** The probe instant, or `null` when the probe timed out / threw before answering. */
  readonly probedAt: Date | null;
  /** The client's last-seen after the probe (bumped when it answered `online`). */
  readonly lastSeen: Date | null;
}

/** Bounds + test seams for {@link probeReachability}. */
export interface ProbeReachabilityOptions {
  /** Max clients probed concurrently. Defaults to 4 (mirrors the health page). */
  readonly concurrency?: number | undefined;
  /** Per-list probe deadline in ms; `0` disables. Defaults to 15_000. */
  readonly deadlineMs?: number | undefined;
  /** Test seam for the deadline timer; defaults to a real `setTimeout` timer. */
  readonly deadlineFactory?: DeadlineFactory;
}

const DEFAULT_PROBE_CONCURRENCY = 4;
const DEFAULT_PROBE_DEADLINE_MS = 15_000;

/**
 * Probe each affected client's live reachability, bounded by concurrency and a
 * shared per-list deadline (the #198 bounds), so one wedged host can't stall the
 * preview. Returns a `clientId → annotation` map (input order preserved by
 * `mapWithConcurrency`, though the map itself is unordered). A client that
 * answers `online` has its `last_seen` bumped to the probe instant (the only
 * write this endpoint ever makes, and only on the opt-in probe path); one whose
 * probe misses the deadline or throws a non-SSH error degrades to `unknown` with
 * no `probedAt` (the prober itself maps SSH-unreachable to `offline`).
 *
 * Exported for direct unit testing against a fake prober.
 */
export async function probeReachability(
  db: PolicyDb,
  prober: ClientProber,
  rows: readonly AffectedClientBase[],
  options: ProbeReachabilityOptions = {},
): Promise<Map<number, ReachabilityAnnotation>> {
  const concurrency = options.concurrency ?? DEFAULT_PROBE_CONCURRENCY;
  const deadlineMs = options.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const deadline =
    deadlineMs > 0 ? (options.deadlineFactory ?? timerDeadline)(deadlineMs) : undefined;
  const annotations = new Map<number, ReachabilityAnnotation>();
  try {
    await mapWithConcurrency(rows, concurrency, async ({ client }) => {
      const probed = prober.probe(client).then(
        (result) => ({ kind: "ok" as const, result }),
        () => ({ kind: "error" as const }),
      );
      const outcome =
        deadline === undefined
          ? await probed
          : await Promise.race([
              probed,
              deadline.reached.then(() => ({ kind: "timeout" as const })),
            ]);

      if (outcome.kind === "ok") {
        const { reachability, at } = outcome.result;
        const lastSeen =
          reachability === "online"
            ? (repo.recordClientLastSeen(db, client.id, at)?.lastSeen ?? client.lastSeen)
            : client.lastSeen;
        annotations.set(client.id, { reachability, probedAt: at, lastSeen });
        return;
      }
      // Timed out or threw before answering: neither online nor a definitive
      // offline — report `unknown`, leave last_seen untouched.
      annotations.set(client.id, {
        reachability: "unknown",
        probedAt: null,
        lastSeen: client.lastSeen,
      });
    });
  } finally {
    deadline?.cancel();
  }
  return annotations;
}

/**
 * Build the wire-shape affected-client rows, folding in the optional
 * reachability annotations. Clients not probed (no probe requested, or no
 * prober) carry `reachability: null` / `probedAt: null`.
 */
function toAffectedClients(
  rows: readonly AffectedClientBase[],
  annotations: Map<number, ReachabilityAnnotation>,
): PreviewAffectedClient[] {
  return rows.map(({ client, pendingQueueDepth }) => {
    const annotation = annotations.get(client.id);
    const lastSeen = annotation?.lastSeen ?? client.lastSeen;
    return {
      clientId: client.id,
      hostname: client.hostname,
      lastSeen: lastSeen === null ? null : lastSeen.toISOString(),
      pendingQueueDepth,
      reachability: annotation?.reachability ?? null,
      probedAt: annotation?.probedAt == null ? null : annotation.probedAt.toISOString(),
    };
  });
}

/**
 * Register `POST /api/users/:userId/policy-preview` on an already-`/api`-prefixed
 * scope. Call after {@link registerAuth} so `scope.requireAdmin` exists;
 * `settings` supplies the server-default timezone for users with no `tz` and the
 * #198 probe bounds. The optional `prober` is injected exactly like the Clients
 * health routes: present only once the SSH-key bootstrap (#39) wires the live
 * transport, and absent it a `probe: true` request degrades to
 * `reachability: null` (never a stand-in verdict).
 */
export function registerPreviewRoutes(
  scope: FastifyInstance,
  settings: Settings,
  prober?: ClientProber,
): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.post(
    "/users/:userId/policy-preview",
    { ...guard, schema: { params: previewParamsSchema, body: policyPreviewRequestSchema } },
    async (request): Promise<PolicyPreviewResponse> => {
      const { userId } = request.params;
      const user = repo.getUser(scope.db, userId);
      if (user === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }

      const tz = resolveEffectiveTz(user.tz, settings.defaultTz);
      const now = request.body.now === undefined ? new Date() : new Date(request.body.now);

      // Current policy mirrors the live executor: the user's effective rules —
      // own rules merged with inherited group schedules/budgets (#362), resolved
      // at the same reference instant.
      const before = resolvePolicyPush({
        tz,
        schedules: gatherUserScheduleRules(scope.db, userId),
        budgets: gatherUserBudgets(scope.db, userId),
        now,
      });
      // The proposed side merges the edited OWN rules with the same persisted
      // group layer, so the diff isolates the own-rule change the push re-merges.
      const after = resolvePolicyPush({
        tz,
        schedules: mergeScheduleRulesWithGroups(
          scope.db,
          userId,
          request.body.schedules.map(toScheduleRule),
        ),
        budgets: mergeBudgetsWithGroups(scope.db, userId, request.body.budgets.map(toBudgetInput)),
        now,
      });

      const diff = diffResolvedPush(before, after);

      const affected = gatherAffectedClients(scope.db, userId);
      // Probe only on the opt-in path and only when the live prober is wired;
      // otherwise every client carries `reachability: null` (the default,
      // side-effect-free shape).
      const annotations =
        request.body.probe === true && prober !== undefined
          ? await probeReachability(scope.db, prober, affected, {
              concurrency: settings.clientHealth.probeConcurrency,
              deadlineMs: settings.clientHealth.probeDeadlineMs,
            })
          : new Map<number, ReachabilityAnnotation>();

      return {
        userId,
        hasChanges: diff.hasChanges,
        changes: diff.changes.map((c) => ({
          field: c.field,
          kind: c.kind,
          weekday: c.weekday,
          before: c.before,
          after: c.after,
          summary: c.summary,
        })),
        affectedClients: toAffectedClients(affected, annotations),
      };
    },
  );
}
