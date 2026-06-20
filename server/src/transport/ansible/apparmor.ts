/**
 * AppArmor per-app **hard-deny** plan generation and push (#92).
 *
 * Phase 6's second client-enforcement playbook (after e2guardian, #90): turn
 * policy **always-on per-app `deny`** rules into AppArmor profiles dropped on a
 * client that hard-block the designated executables. The plan is generated and
 * validated here; {@link pushAppArmorProfiles} hands it to the existing Ansible
 * runner (a subprocess) and records the run in the audit log (#85).
 *
 * `docs/architecture.md` → Enforcement responsibilities:
 * "Per-app deny (hard block) | AppArmor | Ansible-deployed profile".
 *
 * ## License & tamper-resistance boundaries
 *
 * AppArmor is configured **only** by writing profile files and signalling a
 * reload (`apparmor_parser`), driven by `ansible-playbook` as a subprocess — no
 * in-process/GPL linkage, no GPL binary added to the dashboard image
 * (`CLAUDE.md` → License boundaries, rules 3 & 6). This is in-scope per-app
 * *blocking* enforcement: it denies designated apps. It does **not** lock down
 * `/etc`, `/usr`, or boot media against root, and does not fight a root user —
 * staying under the bounded tamper-resistance posture (`docs/client-install.md`).
 *
 * ## What maps to an AppArmor deny
 *
 * AppArmor confines by **executable path**, not by Linux UID — a profile
 * attaches to a binary and applies machine-wide when that binary is exec'd. So
 * the unit of this mapping is "block executable E on client C". The scope of
 * policy rules consumed mirrors #90's conservative first slice:
 *
 * - **Always-on `deny` schedules** only — `action = "deny"` with every
 *   recurrence/date-scoping column `NULL`. Windowed / date-scoped denies need a
 *   scheduler to swap profiles in and out and are deferred.
 * - Targeting an **app activity** (`targetKind = "activity"` → an `app`-kind
 *   activity) or an **activity group** (`targetKind = "group"`, expanded to its
 *   `app`-kind members).
 * - Only `matchType = "exact"` matchers that are **absolute paths** are
 *   mappable to an AppArmor attachment; `app_group` named-bundle activities and
 *   non-`exact` / non-absolute matchers are skipped (richer matching is
 *   #178/#195's domain — we never guess a path).
 *
 * ## Per-UID precision — documented limitation
 *
 * Because AppArmor attaches per executable (not per UID), a deployed profile
 * blocks the binary for everyone on the client. The plan still records, per
 * executable, which supervised users contributed the deny (for the audit trail
 * and a future per-UID mechanism), but the profile is keyed by executable;
 * where users on one client differ, the **union** is blocked. True per-UID exec
 * gating is a separate, harder problem tracked as a follow-up.
 */
import { z } from "zod";

import type { PolicyDb } from "../../policy/db.js";
import {
  getActivity,
  getClient,
  listClientLinks,
  listGroupActivities,
  listUserSchedules,
} from "../../policy/repository.js";
import type { ScheduleRow } from "../../policy/repository.js";
import { redactArgv, type AuditContext, type AuditEntry, type AuditSink } from "../audit/index.js";
import type { AuditOutcome } from "../../policy/enums.js";
import type { SshTargetRef } from "../ssh/errors.js";
import {
  AnsibleUnreachableError,
  type AnsibleHost,
  type AnsibleRunner,
  type AnsibleRunResult,
} from "./index.js";

export const moduleName = "transport/ansible/apparmor";

/** The default playbook name within `<ansibleDir>/playbooks/`. */
export const APPARMOR_PLAYBOOK = "apparmor-profiles.yml";

/** SSH port assumed for the audit target (clients carry no port column today). */
const DEFAULT_SSH_PORT = 22;

/** Cap on a recorded error summary so a verbose PLAY RECAP cannot bloat a row. */
const MAX_ERROR_MESSAGE = 500;

/** Raised when a plan cannot be built (e.g. an unknown client). */
export class AppArmorPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppArmorPlanError";
  }
}

/** A single supervised user a deny is attributed to. */
export const appArmorBlockedForSchema = z.object({
  userId: z.number().int(),
  linuxUid: z.number().int(),
  linuxUsername: z.string().min(1),
});
export type AppArmorBlockedFor = z.infer<typeof appArmorBlockedForSchema>;

/** One executable to hard-deny, with its attributed users. */
export const appArmorDenialSchema = z.object({
  /** AppArmor profile name + filename stem, `pct.<sanitised-exe>`. */
  profileName: z.string().min(1),
  /** Absolute executable path the profile attaches to. */
  executable: z.string().startsWith("/"),
  /** Users whose always-on app-deny contributed this block (audit/context). */
  blockedFor: z.array(appArmorBlockedForSchema).min(1),
});
export type AppArmorDenial = z.infer<typeof appArmorDenialSchema>;

/** The per-client AppArmor plan handed to the playbook. */
export const appArmorPlanSchema = z.object({
  clientId: z.number().int(),
  hostname: z.string().min(1),
  denials: z.array(appArmorDenialSchema),
});
export type AppArmorPlan = z.infer<typeof appArmorPlanSchema>;

/**
 * Derive the AppArmor profile name / filename stem for an executable:
 * `pct.` + the path with its leading `/` removed, `/` → `.`, and any other
 * character outside `[A-Za-z0-9._-]` replaced with `_`. Deterministic and
 * collision-resistant within the `pct.` namespace.
 */
export function profileNameFor(executable: string): string {
  const stem = executable
    .replace(/^\/+/, "")
    .replace(/\//g, ".")
    .replace(/[^A-Za-z0-9._-]/g, "_");
  return `pct.${stem}`;
}

/** A schedule is "always-on" when no recurrence or date-scoping gate is set. */
function isAlwaysOn(rule: ScheduleRow): boolean {
  return (
    rule.recurrenceDays === null &&
    rule.recurrenceStartMinute === null &&
    rule.recurrenceEndMinute === null &&
    rule.effectiveFrom === null &&
    rule.effectiveTo === null
  );
}

/** True for an `app`-kind activity whose matcher is a mappable absolute path. */
function isMappableApp(kind: string, matchType: string, matcher: string): boolean {
  return kind === "app" && matchType === "exact" && matcher.startsWith("/");
}

/**
 * Resolve the executable paths a single always-on app `deny` schedule blocks.
 * Returns absolute executable paths (possibly several, for a group), skipping
 * any non-mappable activity (non-`app`, non-`exact`, non-absolute, `app_group`).
 */
function executablesForDeny(db: PolicyDb, rule: ScheduleRow): string[] {
  if (rule.targetKind === "activity" && rule.targetId !== null) {
    const activity = getActivity(db, rule.targetId);
    if (
      activity !== undefined &&
      isMappableApp(activity.kind, activity.matchType, activity.matcher)
    ) {
      return [activity.matcher];
    }
    return [];
  }
  if (rule.targetKind === "group" && rule.targetId !== null) {
    return listGroupActivities(db, rule.targetId)
      .filter((a) => isMappableApp(a.kind, a.matchType, a.matcher))
      .map((a) => a.matcher);
  }
  // `overall` (or a malformed null target) contributes no per-app block.
  return [];
}

/**
 * Build the AppArmor hard-deny plan for one client from policy.
 *
 * @throws {AppArmorPlanError} if the client does not exist.
 */
export function buildAppArmorPlan(db: PolicyDb, clientId: number): AppArmorPlan {
  const client = getClient(db, clientId);
  if (client === undefined) {
    throw new AppArmorPlanError(`client ${clientId} does not exist`);
  }

  // executable -> (userId -> attribution), so the same user blocking the same
  // executable twice (two rules) collapses, and the union across users is kept.
  const byExecutable = new Map<string, Map<number, AppArmorBlockedFor>>();

  for (const link of listClientLinks(db, clientId)) {
    const attribution: AppArmorBlockedFor = {
      userId: link.userId,
      linuxUid: link.linuxUid,
      linuxUsername: link.linuxUsername,
    };
    for (const rule of listUserAlwaysOnDenies(db, link.userId)) {
      for (const executable of executablesForDeny(db, rule)) {
        let users = byExecutable.get(executable);
        if (users === undefined) {
          users = new Map();
          byExecutable.set(executable, users);
        }
        users.set(link.userId, attribution);
      }
    }
  }

  const denials: AppArmorDenial[] = [...byExecutable.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([executable, users]) => ({
      profileName: profileNameFor(executable),
      executable,
      blockedFor: [...users.values()].sort((a, b) => a.userId - b.userId),
    }));

  return { clientId, hostname: client.hostname, denials };
}

/** A user's always-on `deny` schedules — the rules this mapper consumes. */
function listUserAlwaysOnDenies(db: PolicyDb, userId: number): ScheduleRow[] {
  return listUserSchedules(db, userId).filter((r) => r.action === "deny" && isAlwaysOn(r));
}

/** Options for {@link pushAppArmorProfiles}. */
export interface PushAppArmorOptions {
  /** Policy store handle. */
  db: PolicyDb;
  /** The Ansible runner to dispatch the playbook through. */
  runner: AnsibleRunner;
  /** The client to push to. */
  clientId: number;
  /** Optional audit sink; when omitted, no audit entry is recorded. */
  audit?: AuditSink | undefined;
  /** Attribution for the audit entry (`clientId` is filled from the plan). */
  context?: Omit<AuditContext, "clientId"> | undefined;
  /** Injectable clock for the audit `durationMs` (ms). Defaults to `Date.now`. */
  now?: (() => number) | undefined;
  /** Override the playbook name (defaults to {@link APPARMOR_PLAYBOOK}). */
  playbook?: string | undefined;
}

/** The outcome of a successful {@link pushAppArmorProfiles} run. */
export interface PushAppArmorResult {
  /** The plan that was pushed. */
  plan: AppArmorPlan;
  /** The Ansible run result. */
  result: AnsibleRunResult;
}

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}…` : message;
}

/**
 * Build, validate, and push the AppArmor hard-deny plan for one client, then
 * record the run in the audit log.
 *
 * Runs the playbook even when the plan has no denials so the client-side
 * reconcile step removes any `pct.*` profiles a lifted deny left behind.
 *
 * @throws {AppArmorPlanError} if the plan is malformed (rejected before any run).
 * @throws the Ansible transport error (after recording the audit entry) on a
 *   failed / unreachable / unavailable run.
 */
export async function pushAppArmorProfiles(
  options: PushAppArmorOptions,
): Promise<PushAppArmorResult> {
  const { db, runner, clientId, audit, context, now = Date.now } = options;
  const playbook = options.playbook ?? APPARMOR_PLAYBOOK;

  const client = getClient(db, clientId);
  if (client === undefined) {
    throw new AppArmorPlanError(`client ${clientId} does not exist`);
  }
  const plan = appArmorPlanSchema.parse(buildAppArmorPlan(db, clientId));

  const target: SshTargetRef = {
    host: plan.hostname,
    port: DEFAULT_SSH_PORT,
    username: client.sshUser,
  };
  // A representative argv for the audit record; the runner builds the real one
  // (with the per-run temp inventory) internally. Redacted defensively.
  const command = redactArgv([
    "ansible-playbook",
    playbook,
    "--limit",
    plan.hostname,
    "--extra-vars",
    JSON.stringify({ apparmor_plan: plan }),
  ]);

  const startedAt = now();
  const recordAudit = (
    outcome: AuditOutcome,
    exitCode: number | null,
    errorMessage: string | null,
  ): void => {
    if (audit === undefined) return;
    const entry: AuditEntry = {
      target,
      command,
      outcome,
      exitCode,
      signal: null,
      durationMs: Math.max(0, now() - startedAt),
      errorMessage,
      context: { ...context, clientId },
    };
    audit.record(entry);
  };

  try {
    const result = await runner.runPlaybook({
      playbook,
      hosts: [{ hostname: plan.hostname, sshUser: target.username } satisfies AnsibleHost],
      limit: plan.hostname,
      extraVars: { apparmor_plan: plan },
    });
    recordAudit("ok", result.exitCode, null);
    return { plan, result };
  } catch (err) {
    const { outcome, exitCode } = classifyAnsibleError(err);
    recordAudit(outcome, exitCode, truncate(err instanceof Error ? err.message : String(err)));
    throw err;
  }
}

/** Map an Ansible transport error onto an {@link AuditOutcome} + exit code. */
function classifyAnsibleError(err: unknown): { outcome: AuditOutcome; exitCode: number | null } {
  if (err instanceof AnsibleUnreachableError) {
    return { outcome: "unreachable", exitCode: err.exitCode };
  }
  const exitCode =
    typeof err === "object" && err !== null && "exitCode" in err && typeof err.exitCode === "number"
      ? err.exitCode
      : null;
  return { outcome: "failed", exitCode };
}
