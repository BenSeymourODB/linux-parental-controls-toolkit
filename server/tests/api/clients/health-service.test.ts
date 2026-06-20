/**
 * Unit tests for the client health/status assembly (#81), over an in-memory
 * policy DB. Exercises the three join sources — the `clients` row, the offline
 * transport queue, and an optional injected {@link ClientProber} — plus the
 * `last_seen` bump on a reachable probe.
 */
import { beforeEach, describe, expect, it } from "vitest";

import * as repo from "../../../src/policy/repository.js";
import type { ClientRow } from "../../../src/policy/repository.js";
import { enqueue, markFailed } from "../../../src/transport/queue/index.js";
import type { ClientProber, ClientProbeResult } from "../../../src/transport/health/index.js";
import { getClientHealth, listClientHealth } from "../../../src/api/clients/health-service.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const PROBE_AT = new Date("2026-06-19T12:00:00.000Z");

/** A canned prober returning one result for every client it sees. */
class FakeProber implements ClientProber {
  readonly seen: { hostname: string; sshUser: string }[] = [];
  constructor(private readonly result: ClientProbeResult) {}
  async probe(client: { hostname: string; sshUser: string }): Promise<ClientProbeResult> {
    this.seen.push(client);
    return this.result;
  }
}

const onlineResult: ClientProbeResult = {
  reachability: "online",
  at: PROBE_AT,
  components: [{ component: "timekpr-next", status: "ok", detail: "active" }],
};

const offlineResult: ClientProbeResult = {
  reachability: "offline",
  at: PROBE_AT,
  components: [{ component: "timekpr-next", status: "unknown", detail: "host unreachable" }],
};

let db: TestDb;
let client: ClientRow;

beforeEach(() => {
  db = testDb();
  client = repo.createClient(db, { hostname: "alice-pc.local", sshUser: "pct-agent" });
});

describe("getClientHealth", () => {
  it("returns undefined for a missing client", async () => {
    expect(await getClientHealth(db, 999)).toBeUndefined();
  });

  it("degrades to unknown reachability/components when no prober is wired", async () => {
    const health = await getClientHealth(db, client.id);
    expect(health?.reachability).toBe("unknown");
    expect(health?.probedAt).toBeNull();
    expect(health?.lastSeen).toBeNull();
    // One row per catalogue component, all unknown with the pre-#39 detail.
    expect(health?.components).toHaveLength(5);
    expect(health?.components.every((c) => c.status === "unknown")).toBe(true);
    expect(health?.components[0]?.detail).toMatch(/#39/);
  });

  it("reports a live probe and bumps last_seen when the client is reachable", async () => {
    const prober = new FakeProber(onlineResult);
    const health = await getClientHealth(db, client.id, prober);

    expect(prober.seen).toHaveLength(1);
    expect(prober.seen[0]).toMatchObject({ hostname: "alice-pc.local", sshUser: "pct-agent" });
    expect(health?.reachability).toBe("online");
    expect(health?.probedAt).toBe("2026-06-19T12:00:00.000Z");
    expect(health?.lastSeen).toBe("2026-06-19T12:00:00.000Z");
    expect(health?.components).toEqual([
      { component: "timekpr-next", status: "ok", detail: "active" },
    ]);
    // Persisted, not just reported.
    expect(repo.getClient(db, client.id)?.lastSeen).toEqual(PROBE_AT);
  });

  it("falls back to the read row if the client is deleted during the probe", async () => {
    // A probe that races a concurrent delete: recordClientLastSeen finds no row,
    // so the assembly reports the (now-stale) row it read rather than crashing.
    const racingProber: ClientProber = {
      async probe(seen) {
        repo.deleteClient(db, client.id);
        void seen;
        return onlineResult;
      },
    };
    const health = await getClientHealth(db, client.id, racingProber);
    expect(health?.reachability).toBe("online");
    expect(health?.lastSeen).toBeNull();
    expect(repo.getClient(db, client.id)).toBeUndefined();
  });

  it("does not touch last_seen when the probe reports the client offline", async () => {
    const health = await getClientHealth(db, client.id, new FakeProber(offlineResult));
    expect(health?.reachability).toBe("offline");
    expect(health?.lastSeen).toBeNull();
    expect(health?.probedAt).toBe("2026-06-19T12:00:00.000Z");
    expect(repo.getClient(db, client.id)?.lastSeen).toBeNull();
  });

  it("surfaces the offline queue: pending/failed counts and per-row detail", async () => {
    enqueue(db, {
      clientId: client.id,
      coalesceKey: "policy.push:user:1",
      kind: "policy.push",
      payload: { a: 1 },
    });
    const stuck = enqueue(db, {
      clientId: client.id,
      coalesceKey: "policy.push:user:2",
      kind: "policy.push",
      payload: { b: 2 },
    });
    markFailed(db, stuck.id, "exit code 1");

    const health = await getClientHealth(db, client.id);
    expect(health?.queue.pending).toBe(1);
    expect(health?.queue.failed).toBe(1);
    expect(health?.queue.actions).toHaveLength(2);
    expect(health?.queue.actions.map((a) => a.coalesceKey)).toEqual([
      "policy.push:user:1",
      "policy.push:user:2",
    ]);
    expect(health?.queue.actions.find((a) => a.status === "failed")?.lastError).toBe("exit code 1");
  });
});

describe("listClientHealth", () => {
  it("returns one record per client, ascending by id, probing each", async () => {
    const second = repo.createClient(db, { hostname: "bob-pc.local", sshUser: "pct-agent" });
    const prober = new FakeProber(onlineResult);

    const list = await listClientHealth(db, prober);

    expect(list.map((h) => h.clientId)).toEqual([client.id, second.id]);
    expect(prober.seen).toHaveLength(2);
    expect(list.every((h) => h.reachability === "online")).toBe(true);
  });

  it("returns an empty list when no clients are enrolled", async () => {
    const empty = testDb();
    expect(await listClientHealth(empty)).toEqual([]);
  });
});
