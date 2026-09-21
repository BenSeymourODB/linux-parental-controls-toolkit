/**
 * Unit tests for the AdGuard per-device DNS blocklist composition + apply
 * (#97; ADR 0015). No network: the AdGuard surface is a recording in-memory
 * fake. Live behaviour is out of scope (REST-only integration is #94's tier).
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  createActivity,
  createClient,
  createSchedule,
  createUser,
  upsertLink,
} from "../../../src/policy/repository.js";
import { clients } from "../../../src/policy/schema.js";
import type { TestDb } from "../../helpers/db.js";
import { testDb } from "../../helpers/db.js";
import {
  applyDnsBlocklist,
  buildDnsBlocklistPlan,
  composeUserRules,
  formatBlockRule,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  reconcileManagedClients,
  stripManagedRules,
  type DnsBlocklistClient,
  type DnsBlocklistPlan,
} from "../../../src/transport/adguard/blocklist.js";
import type { AdGuardClient, AdGuardClientInput } from "../../../src/transport/adguard/schemas.js";

const PREFIX = "pct:";

/** Set a client's self-reported IPs (only settable via enrolment in production). */
function setReportedIps(db: TestDb, clientId: number, ips: string[]): void {
  db.update(clients).set({ reportedIps: ips }).where(eq(clients.id, clientId)).run();
}

/** Create a client with reported IPs and link one supervised user who denies `domains`. */
function deviceDenying(
  db: TestDb,
  opts: {
    hostname: string;
    friendlyName?: string;
    ips?: string[];
    domains: string[];
    displayName?: string;
  },
): number {
  const clientId = createClient(db, {
    hostname: opts.hostname,
    sshUser: "pct-agent",
    ...(opts.friendlyName !== undefined ? { friendlyName: opts.friendlyName } : {}),
  }).id;
  if (opts.ips !== undefined) setReportedIps(db, clientId, opts.ips);
  const userId = createUser(db, { displayName: opts.displayName ?? opts.hostname }).id;
  upsertLink(db, userId, clientId, { osUsername: "child", osUserRef: "1001" });
  for (const domain of opts.domains) {
    const activity = createActivity(db, { kind: "domain", matcher: domain });
    createSchedule(db, { userId, targetKind: "activity", targetId: activity.id, action: "deny" });
  }
  return clientId;
}

/** Build a stored client row from an add/update input, carrying use_global_settings. */
function rowFromInput(input: AdGuardClientInput): AdGuardClient {
  const ugs = input.use_global_settings;
  return {
    name: input.name,
    ids: [...input.ids],
    ...(typeof ugs === "boolean" ? { use_global_settings: ugs } : {}),
  };
}

/** A recording in-memory {@link DnsBlocklistClient}. */
class FakeDnsClient implements DnsBlocklistClient {
  readonly clientPrefix = PREFIX;
  rows: AdGuardClient[];
  userRules: string[];
  readonly calls = { added: [] as string[], updated: [] as string[], deleted: [] as string[] };
  readonly addInputs: AdGuardClientInput[] = [];
  readonly updateInputs: AdGuardClientInput[] = [];
  setRulesCount = 0;

  constructor(init: { clients?: AdGuardClient[]; userRules?: string[] } = {}) {
    this.rows = init.clients ?? [];
    this.userRules = init.userRules ?? [];
  }

  async listManagedClients(): Promise<AdGuardClient[]> {
    return this.rows.filter((row) => row.name.startsWith(this.clientPrefix));
  }

  async addClient(input: AdGuardClientInput): Promise<void> {
    this.rows.push(rowFromInput(input));
    this.calls.added.push(input.name);
    this.addInputs.push(input);
  }

  async updateClient(name: string, data: AdGuardClientInput): Promise<void> {
    this.rows = this.rows.map((row) => (row.name === name ? rowFromInput(data) : row));
    this.calls.updated.push(name);
    this.updateInputs.push(data);
  }

  async deleteClient(name: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.name !== name);
    this.calls.deleted.push(name);
  }

  async getUserRules(): Promise<string[]> {
    return [...this.userRules];
  }

  async setUserRules(rules: readonly string[]): Promise<void> {
    this.userRules = [...rules];
    this.setRulesCount += 1;
  }
}

describe("buildDnsBlocklistPlan", () => {
  it("maps a device with denies + reported IPs to one pct: client keyed on its IPs", () => {
    const db = testDb();
    deviceDenying(db, {
      hostname: "mint-01",
      friendlyName: "Alice laptop",
      ips: ["192.168.1.50", "10.0.0.5"],
      domains: ["youtube.com", "tiktok.com"],
    });

    const plan = buildDnsBlocklistPlan(db, { clientPrefix: PREFIX });

    expect(plan.skipped).toEqual([]);
    expect(plan.clients).toEqual([
      {
        name: "pct:Alice laptop",
        ids: ["10.0.0.5", "192.168.1.50"],
        domains: ["tiktok.com", "youtube.com"],
      },
    ]);
    db.$client.close();
  });

  it("falls back to the hostname when there is no friendly name", () => {
    const db = testDb();
    deviceDenying(db, { hostname: "mint-02", ips: ["192.168.1.51"], domains: ["youtube.com"] });

    const plan = buildDnsBlocklistPlan(db, { clientPrefix: PREFIX });

    expect(plan.clients[0]?.name).toBe("pct:mint-02");
    db.$client.close();
  });

  it("skips a device with denies but no reported IP, surfacing the reason", () => {
    const db = testDb();
    const clientId = deviceDenying(db, { hostname: "mint-03", domains: ["youtube.com"] });

    const plan = buildDnsBlocklistPlan(db, { clientPrefix: PREFIX });

    expect(plan.clients).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        clientId,
        name: "pct:mint-03",
        label: "mint-03",
        reason: "no_reported_ips",
        domains: ["youtube.com"],
      },
    ]);
    db.$client.close();
  });

  it("omits a device with no domain denies entirely", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "mint-04", sshUser: "pct-agent" }).id;
    setReportedIps(db, clientId, ["192.168.1.52"]);
    const userId = createUser(db, { displayName: "Bob" }).id;
    upsertLink(db, userId, clientId, { osUsername: "bob", osUserRef: "1002" });

    const plan = buildDnsBlocklistPlan(db, { clientPrefix: PREFIX });

    expect(plan.clients).toEqual([]);
    expect(plan.skipped).toEqual([]);
    db.$client.close();
  });

  it("unions the denies of every supervised user on a device", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "family-pc", sshUser: "pct-agent" }).id;
    setReportedIps(db, clientId, ["192.168.1.60"]);
    for (const [name, domain] of [
      ["alice", "youtube.com"],
      ["bob", "roblox.com"],
    ] as const) {
      const userId = createUser(db, { displayName: name }).id;
      upsertLink(db, userId, clientId, { osUsername: name, osUserRef: name });
      const activity = createActivity(db, { kind: "domain", matcher: domain });
      createSchedule(db, { userId, targetKind: "activity", targetId: activity.id, action: "deny" });
    }

    const plan = buildDnsBlocklistPlan(db, { clientPrefix: PREFIX });

    expect(plan.clients[0]?.domains).toEqual(["roblox.com", "youtube.com"]);
    db.$client.close();
  });

  it("merges two devices that share a name, unioning their IPs and domains", () => {
    const db = testDb();
    deviceDenying(db, {
      hostname: "h1",
      friendlyName: "Shared",
      ips: ["1.1.1.1"],
      domains: ["a.com"],
    });
    deviceDenying(db, {
      hostname: "h2",
      friendlyName: "Shared",
      ips: ["2.2.2.2"],
      domains: ["b.com"],
    });

    const plan = buildDnsBlocklistPlan(db, { clientPrefix: PREFIX });

    expect(plan.clients).toEqual([
      { name: "pct:Shared", ids: ["1.1.1.1", "2.2.2.2"], domains: ["a.com", "b.com"] },
    ]);
    db.$client.close();
  });

  it("merges an IP-less same-name row into the enforced client rather than stranding its domains", () => {
    const db = testDb();
    // Same friendly name; one device has an address, the other does not.
    deviceDenying(db, {
      hostname: "h1",
      friendlyName: "Shared",
      ips: ["1.1.1.1"],
      domains: ["a.com"],
    });
    deviceDenying(db, { hostname: "h2", friendlyName: "Shared", domains: ["b.com"] });

    const plan = buildDnsBlocklistPlan(db, { clientPrefix: PREFIX });

    // b.com is unioned into the addressable client; the name is not also skipped.
    expect(plan.clients).toEqual([
      { name: "pct:Shared", ids: ["1.1.1.1"], domains: ["a.com", "b.com"] },
    ]);
    expect(plan.skipped).toEqual([]);
    db.$client.close();
  });
});

describe("formatBlockRule", () => {
  it("scopes a domain to a client", () => {
    expect(formatBlockRule("youtube.com", "pct:Alice")).toBe("||youtube.com^$client='pct:Alice'");
  });

  it("escapes single quotes and backslashes in the client name", () => {
    expect(formatBlockRule("x.com", "pct:O'Brien\\PC")).toBe(
      "||x.com^$client='pct:O\\'Brien\\\\PC'",
    );
  });
});

describe("stripManagedRules", () => {
  it("removes the managed block and preserves foreign rules in order", () => {
    const existing = [
      "||household-rule.com^",
      MANAGED_BLOCK_BEGIN,
      "||youtube.com^$client='pct:Alice'",
      MANAGED_BLOCK_END,
      "@@||allowlisted.com^",
    ];
    expect(stripManagedRules(existing)).toEqual(["||household-rule.com^", "@@||allowlisted.com^"]);
  });

  it("leaves a list with no managed block untouched", () => {
    const existing = ["||a.com^", "! a comment", "@@||b.com^"];
    expect(stripManagedRules(existing)).toEqual(existing);
  });

  it("tolerates a begin marker with no matching end (strips to the end)", () => {
    const existing = ["||keep.com^", MANAGED_BLOCK_BEGIN, "||orphan.com^$client='pct:x'"];
    expect(stripManagedRules(existing)).toEqual(["||keep.com^"]);
  });
});

describe("composeUserRules", () => {
  const plan: DnsBlocklistPlan = {
    clients: [{ name: "pct:Alice", ids: ["1.1.1.1"], domains: ["tiktok.com", "youtube.com"] }],
    skipped: [],
  };

  it("preserves foreign rules and appends a fresh sorted managed block", () => {
    const next = composeUserRules(["||foreign.com^"], plan);
    expect(next).toEqual([
      "||foreign.com^",
      MANAGED_BLOCK_BEGIN,
      "||tiktok.com^$client='pct:Alice'",
      "||youtube.com^$client='pct:Alice'",
      MANAGED_BLOCK_END,
    ]);
  });

  it("is idempotent — re-composing over its own output is a fixed point", () => {
    const once = composeUserRules(["||foreign.com^"], plan);
    expect(composeUserRules(once, plan)).toEqual(once);
  });

  it("writes no marker block when the plan denies nothing", () => {
    expect(composeUserRules(["||foreign.com^"], { clients: [], skipped: [] })).toEqual([
      "||foreign.com^",
    ]);
  });
});

describe("reconcileManagedClients", () => {
  it("adds missing, updates drifted IPs, deletes stale, and leaves unchanged + foreign alone", async () => {
    const fake = new FakeDnsClient({
      clients: [
        { name: "pct:keep", ids: ["1.1.1.1"], use_global_settings: true }, // unchanged
        { name: "pct:drift", ids: ["9.9.9.9"], use_global_settings: true }, // ids change
        { name: "pct:stale", ids: ["8.8.8.8"], use_global_settings: true }, // not in plan → delete
        { name: "home-router", ids: ["192.168.1.1"] }, // foreign → never touched
      ],
    });
    const plan: DnsBlocklistPlan = {
      clients: [
        { name: "pct:keep", ids: ["1.1.1.1"], domains: ["a.com"] },
        { name: "pct:drift", ids: ["2.2.2.2"], domains: ["b.com"] },
        { name: "pct:new", ids: ["3.3.3.3"], domains: ["c.com"] },
      ],
      skipped: [],
    };

    const summary = await reconcileManagedClients(fake, plan);

    expect(summary).toEqual({ added: 1, updated: 1, deleted: 1, unchanged: 1 });
    expect(fake.calls.added).toEqual(["pct:new"]);
    expect(fake.calls.updated).toEqual(["pct:drift"]);
    expect(fake.calls.deleted).toEqual(["pct:stale"]);
    // New clients are created inheriting global filtering, so the rules bite.
    expect(fake.addInputs).toEqual([
      { name: "pct:new", ids: ["3.3.3.3"], use_global_settings: true },
    ]);
    expect(fake.rows.map((r) => r.name).sort()).toEqual([
      "home-router",
      "pct:drift",
      "pct:keep",
      "pct:new",
    ]);
  });

  it("self-heals an existing managed client that is not inheriting global filtering", async () => {
    // Same name + same ids, but use_global_settings is not true → must be updated.
    const fake = new FakeDnsClient({ clients: [{ name: "pct:keep", ids: ["1.1.1.1"] }] });
    const plan: DnsBlocklistPlan = {
      clients: [{ name: "pct:keep", ids: ["1.1.1.1"], domains: ["a.com"] }],
      skipped: [],
    };

    const summary = await reconcileManagedClients(fake, plan);

    expect(summary).toEqual({ added: 0, updated: 1, deleted: 0, unchanged: 0 });
    expect(fake.updateInputs).toEqual([
      { name: "pct:keep", ids: ["1.1.1.1"], use_global_settings: true },
    ]);
  });
});

describe("applyDnsBlocklist", () => {
  it("reconciles clients and pushes recomposed rules, preserving foreign rules", async () => {
    const db = testDb();
    deviceDenying(db, {
      hostname: "mint-01",
      friendlyName: "Alice",
      ips: ["192.168.1.50"],
      domains: ["youtube.com"],
    });
    const fake = new FakeDnsClient({ userRules: ["||foreign.com^"] });

    const summary = await applyDnsBlocklist(fake, db);

    expect(summary).toEqual({
      clientsManaged: 1,
      skipped: 0,
      ruleCount: 1,
      rulesChanged: true,
      clients: { added: 1, updated: 0, deleted: 0, unchanged: 0 },
    });
    expect(fake.rows).toEqual([
      { name: "pct:Alice", ids: ["192.168.1.50"], use_global_settings: true },
    ]);
    expect(fake.userRules).toEqual([
      "||foreign.com^",
      MANAGED_BLOCK_BEGIN,
      "||youtube.com^$client='pct:Alice'",
      MANAGED_BLOCK_END,
    ]);
    db.$client.close();
  });

  it("is a no-op on re-apply — no second setUserRules write", async () => {
    const db = testDb();
    deviceDenying(db, {
      hostname: "mint-01",
      friendlyName: "Alice",
      ips: ["192.168.1.50"],
      domains: ["youtube.com"],
    });
    const fake = new FakeDnsClient();

    await applyDnsBlocklist(fake, db);
    expect(fake.setRulesCount).toBe(1);

    const second = await applyDnsBlocklist(fake, db);
    expect(second.rulesChanged).toBe(false);
    expect(fake.setRulesCount).toBe(1);
    db.$client.close();
  });

  it("skips a device with no reported IP (nothing pushed for it)", async () => {
    const db = testDb();
    deviceDenying(db, { hostname: "mint-03", domains: ["youtube.com"] });
    const fake = new FakeDnsClient();

    const summary = await applyDnsBlocklist(fake, db);

    expect(summary.clientsManaged).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.rulesChanged).toBe(false);
    expect(fake.rows).toEqual([]);
    db.$client.close();
  });
});
