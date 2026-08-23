/**
 * Per-device AdGuard DNS blocklist composition + apply (Phase 7, #97; ADR 0015).
 *
 * Three well-separated halves so the interesting logic is pure and hermetically
 * unit-testable, and only the thin orchestrator touches the network:
 *
 * 1. {@link buildDnsBlocklistPlan} resolves, from the policy store, the set of
 *    always-on `domain` denies for each dashboard `Client` (device) — the union
 *    across that device's supervised users (own + inherited group denies) — and
 *    maps each device to one `pct:`-prefixed AdGuard client keyed on its reported
 *    IPs. A device with denies but no reported IPs cannot be targeted, so it is
 *    reported as `skipped` rather than silently dropped.
 * 2. {@link composeUserRules} is the pure read-modify-write over AdGuard's global
 *    `user_rules`: strip the dashboard's previous marker block (preserving every
 *    foreign, hand-written rule), then append a freshly-composed, sorted block.
 * 3. {@link applyDnsBlocklist} is the orchestrator: reconcile the `pct:` clients
 *    to match the plan, then push the recomposed `user_rules`. It talks to AdGuard
 *    only through the injected {@link AdGuardHomeClient}.
 *
 * License boundary: AdGuard Home is driven over its REST API only — no AdGuard
 * code is linked, imported, or vendored (`CLAUDE.md` → "License boundaries" rule
 * 4; `docs/licensing-analysis.md`).
 */
import { listClientLinks, listClients } from "../../policy/repository.js";
import type { PolicyDb } from "../../policy/db.js";
import { resolveAlwaysOnDomainDenies } from "../../policy/domain-denies.js";

import type { AdGuardClient, AdGuardClientInput } from "./schemas.js";

/**
 * The narrow slice of {@link AdGuardHomeClient} this module needs — the managed
 * clients + `user_rules` read/write surface, plus the namespace prefix. Depending
 * on this structural interface (which `AdGuardHomeClient` satisfies) rather than
 * the concrete class keeps the composition logic decoupled and lets a test supply
 * a recording fake without casts.
 */
export interface DnsBlocklistClient {
  /** The managed-namespace prefix (`pct:`) AdGuard client names carry. */
  readonly clientPrefix: string;
  /** Dashboard-owned (`pct:`) persistent clients only. */
  listManagedClients(): Promise<AdGuardClient[]>;
  /** Create a dashboard-owned client. */
  addClient(input: AdGuardClientInput): Promise<void>;
  /** Replace a dashboard-owned client's config. */
  updateClient(name: string, data: AdGuardClientInput): Promise<void>;
  /** Remove a dashboard-owned client. */
  deleteClient(name: string): Promise<void>;
  /** The global custom-rules list. */
  getUserRules(): Promise<string[]>;
  /** Replace the global custom-rules list. */
  setUserRules(rules: readonly string[]): Promise<void>;
}

/**
 * Sentinel comment lines that bracket the dashboard-owned rules inside AdGuard's
 * global `user_rules`. Deliberately verbose so an accidental collision with a
 * household's own hand-written rule is vanishingly unlikely (ADR 0015). AdGuard
 * treats a `!`-prefixed line as a comment, so these are inert as rules.
 */
export const MANAGED_BLOCK_BEGIN =
  "! >>> pct-managed: do not edit (managed by the parental-controls dashboard) >>>";
export const MANAGED_BLOCK_END = "! <<< pct-managed <<<";

/** One device's composed DNS blocklist: an AdGuard client name, its IPs, and the denied domains. */
export interface DnsClientBlocklist {
  /** The `pct:`-prefixed AdGuard client name (`${clientPrefix}${friendlyName ?? hostname}`). */
  readonly name: string;
  /** The device's reported IPs, deduplicated and sorted — the AdGuard client `ids`. */
  readonly ids: string[];
  /** Domains always-on denied for this device (union across its users), deduplicated and sorted. */
  readonly domains: string[];
}

/** A device with domain denies that cannot be enforced over DNS, with the reason. */
export interface DnsSkippedClient {
  /** The dashboard `Client.id`. */
  readonly clientId: number;
  /** The AdGuard client name it *would* have used. */
  readonly name: string;
  /** The human label (`friendlyName ?? hostname`). */
  readonly label: string;
  /** Why the device was skipped. Currently only "no reported IPs to target". */
  readonly reason: "no_reported_ips";
  /** The domains that would be denied once the device has an addressable IP. */
  readonly domains: string[];
}

/** The full composition plan: enforceable devices plus the ones that had to be skipped. */
export interface DnsBlocklistPlan {
  readonly clients: DnsClientBlocklist[];
  readonly skipped: DnsSkippedClient[];
}

/** Counts from a reconcile of the `pct:` AdGuard clients against a plan. */
export interface DnsReconcileSummary {
  readonly added: number;
  readonly updated: number;
  readonly deleted: number;
  readonly unchanged: number;
}

/** The outcome of an {@link applyDnsBlocklist} run. */
export interface DnsApplySummary {
  /** Devices with rules pushed. */
  readonly clientsManaged: number;
  /** Devices with denies but no reported IP (not pushed). */
  readonly skipped: number;
  /** Total dashboard-owned rules written across all devices. */
  readonly ruleCount: number;
  /** Whether the `user_rules` list actually changed (a no-op re-apply writes nothing). */
  readonly rulesChanged: boolean;
  /** Per-client reconcile counts. */
  readonly clients: DnsReconcileSummary;
}

/** Options for {@link buildDnsBlocklistPlan}. */
export interface BuildDnsBlocklistPlanOptions {
  /** The managed-namespace prefix AdGuard client names carry (e.g. `pct:`). */
  readonly clientPrefix: string;
}

interface PlanAccumulator {
  label: string;
  ids: Set<string>;
  domains: Set<string>;
}

/** The human label for a device: its friendly name if set, else its hostname. */
function labelForClient(friendlyName: string | null, hostname: string): string {
  return (friendlyName ?? hostname).trim() || hostname;
}

/**
 * Build the per-device DNS blocklist plan from the policy store.
 *
 * Every dashboard `Client` with at least one always-on `domain` deny among its
 * supervised users is considered; users' denies are unioned per device. A device
 * with reported IPs becomes an enforceable {@link DnsClientBlocklist}; one
 * without is {@link DnsSkippedClient} (DNS can only target an address). Devices
 * that share a name (same friendly name / hostname) are merged — their IPs and
 * domains unioned — so the plan is deterministic and never drops data.
 *
 * Output is fully sorted (clients by name, ids and domains within each), so
 * re-running against unchanged policy yields an identical plan and the push is
 * idempotent.
 */
export function buildDnsBlocklistPlan(
  db: PolicyDb,
  options: BuildDnsBlocklistPlanOptions,
): DnsBlocklistPlan {
  const { clientPrefix } = options;
  const byName = new Map<string, PlanAccumulator>();
  const skipped: DnsSkippedClient[] = [];

  for (const client of listClients(db)) {
    const domains = new Set<string>();
    for (const link of listClientLinks(db, client.id)) {
      for (const domain of resolveAlwaysOnDomainDenies(db, link.userId)) domains.add(domain);
    }
    if (domains.size === 0) continue;

    const label = labelForClient(client.friendlyName, client.hostname);
    const name = `${clientPrefix}${label}`;
    const ids = (client.reportedIps ?? []).filter((ip) => ip.trim().length > 0);

    if (ids.length === 0) {
      skipped.push({
        clientId: client.id,
        name,
        label,
        reason: "no_reported_ips",
        domains: [...domains].sort(),
      });
      continue;
    }

    const entry = byName.get(name) ?? { label, ids: new Set<string>(), domains: new Set<string>() };
    for (const ip of ids) entry.ids.add(ip);
    for (const domain of domains) entry.domains.add(domain);
    byName.set(name, entry);
  }

  const clients = [...byName.entries()]
    .map(([name, entry]) => ({
      name,
      ids: [...entry.ids].sort(),
      domains: [...entry.domains].sort(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  skipped.sort((a, b) => a.clientId - b.clientId);
  return { clients, skipped };
}

/**
 * Format a single AdGuard blocking rule scoping a domain to one client:
 * `||<domain>^$client='<name>'`. The client name is single-quoted with `\` and
 * `'` escaped, so a name with spaces or punctuation stays a valid `$client`
 * value.
 */
export function formatBlockRule(domain: string, clientName: string): string {
  const escaped = clientName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `||${domain}^$client='${escaped}'`;
}

/** The dashboard-owned rule lines for a plan, sorted; empty when nothing is denied. */
function managedRules(clients: readonly DnsClientBlocklist[]): string[] {
  const rules: string[] = [];
  for (const client of clients) {
    for (const domain of client.domains) rules.push(formatBlockRule(domain, client.name));
  }
  return rules.sort();
}

/** The full managed marker block for a plan, or `[]` when there are no rules to write. */
function managedBlock(clients: readonly DnsClientBlocklist[]): string[] {
  const rules = managedRules(clients);
  if (rules.length === 0) return [];
  return [MANAGED_BLOCK_BEGIN, ...rules, MANAGED_BLOCK_END];
}

/**
 * Return `existing` with every dashboard-owned marker block removed, preserving
 * all other (foreign) lines in order. Tolerant of a malformed list — a `begin`
 * with no matching `end` drops to the end of the list, and repeated blocks are
 * all removed — so a partially-written state always converges on the next apply.
 */
export function stripManagedRules(existing: readonly string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of existing) {
    if (line === MANAGED_BLOCK_BEGIN) {
      inBlock = true;
      continue;
    }
    if (line === MANAGED_BLOCK_END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) out.push(line);
  }
  return out;
}

/**
 * The read-modify-write: the new complete `user_rules` list = the household's own
 * rules (everything outside the dashboard's marker block) followed by a freshly
 * composed managed block. Pure; the sole shape AdGuard's whole-list `set_rules`
 * accepts (`CLAUDE.md` "Validate all external input" — the read is validated by
 * the client).
 */
export function composeUserRules(existing: readonly string[], plan: DnsBlocklistPlan): string[] {
  return [...stripManagedRules(existing), ...managedBlock(plan.clients)];
}

/** Order-independent equality of two id lists. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * Reconcile the dashboard-owned (`pct:`) AdGuard clients so they match the plan:
 * add missing ones, update ones whose IPs drifted, and delete ones no longer in
 * the plan. Foreign clients are never touched (the client's `pct:` guard enforces
 * this, and we only ever list/delete managed ones). On update the existing client
 * config is round-tripped so AdGuard fields the dashboard does not manage survive.
 */
export async function reconcileManagedClients(
  client: DnsBlocklistClient,
  plan: DnsBlocklistPlan,
): Promise<DnsReconcileSummary> {
  const desired = new Map(plan.clients.map((entry) => [entry.name, entry.ids]));
  const existing = await client.listManagedClients();
  const existingByName = new Map(existing.map((row: AdGuardClient) => [row.name, row]));

  let added = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;

  for (const [name, ids] of desired) {
    const current = existingByName.get(name);
    if (current === undefined) {
      await client.addClient({ name, ids: [...ids] });
      added += 1;
    } else if (!sameIds(current.ids, ids)) {
      await client.updateClient(name, { ...current, name, ids: [...ids] });
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  for (const row of existing) {
    if (!desired.has(row.name)) {
      await client.deleteClient(row.name);
      deleted += 1;
    }
  }

  return { added, updated, deleted, unchanged };
}

/**
 * Apply the DNS blocklist end-to-end against a wired AdGuard instance: build the
 * plan, reconcile the `pct:` clients (so every `$client=` rule references an
 * existing client), then push the recomposed `user_rules` — writing only when the
 * list actually changed. The caller (the API layer) is responsible for deciding
 * the instance is reachable/enabled before calling; this only needs the client.
 */
export async function applyDnsBlocklist(
  client: DnsBlocklistClient,
  db: PolicyDb,
): Promise<DnsApplySummary> {
  const plan = buildDnsBlocklistPlan(db, { clientPrefix: client.clientPrefix });
  const clients = await reconcileManagedClients(client, plan);

  const existingRules = await client.getUserRules();
  const nextRules = composeUserRules(existingRules, plan);
  const rulesChanged =
    existingRules.length !== nextRules.length ||
    existingRules.some((line, index) => line !== nextRules[index]);
  if (rulesChanged) await client.setUserRules(nextRules);

  const ruleCount = plan.clients.reduce((total, entry) => total + entry.domains.length, 0);
  return {
    clientsManaged: plan.clients.length,
    skipped: plan.skipped.length,
    ruleCount,
    rulesChanged,
    clients,
  };
}
