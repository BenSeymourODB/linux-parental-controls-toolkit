/**
 * Unit tests for the client health/status assembly (#81), over an in-memory
 * policy DB. Exercises the three join sources — the `clients` row, the offline
 * transport queue, and an optional injected {@link ClientProber} — plus the
 * `last_seen` bump on a reachable probe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  reachabilityReason: null,
};

const offlineResult: ClientProbeResult = {
  reachability: "offline",
  at: PROBE_AT,
  components: [
    { component: "timekpr-next", status: "unknown", detail: "host unreachable (timeout)" },
  ],
  reachabilityReason: "timeout",
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
    expect(health?.reachabilityReason).toBeNull();
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
    expect(health?.reachabilityReason).toBeNull();
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
    expect(health?.reachabilityReason).toBe("timeout");
    expect(health?.components[0]?.detail).toBe("host unreachable (timeout)");
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

describe("version drift (#352)", () => {
  it("reports the reported agent version + reported-at, echoing the server version", async () => {
    repo.recordClientAgentVersion(db, client.id, "0.1.0-alpha.4", PROBE_AT);

    const health = await getClientHealth(db, client.id, undefined, "0.1.0-alpha.5");
    expect(health?.agentVersion).toBe("0.1.0-alpha.4");
    expect(health?.versionsReportedAt).toBe(PROBE_AT.toISOString());
    expect(health?.serverVersion).toBe("0.1.0-alpha.5");
    // Behind the server but still protocol-compatible → amber "outdated".
    expect(health?.versionStatus).toBe("outdated");
  });

  it("is up_to_date when the reported version matches the server", async () => {
    repo.recordClientAgentVersion(db, client.id, "0.1.0-alpha.5", PROBE_AT);
    const health = await getClientHealth(db, client.id, undefined, "0.1.0-alpha.5");
    expect(health?.versionStatus).toBe("up_to_date");
  });

  it("is update_required when the handshake flagged the client, over any version", async () => {
    repo.recordClientAgentVersion(db, client.id, "0.1.0-alpha.5", PROBE_AT);
    repo.setClientUpdateRequired(db, client.id, true);
    const health = await getClientHealth(db, client.id, undefined, "0.1.0-alpha.5");
    expect(health?.updateRequired).toBe(true);
    expect(health?.versionStatus).toBe("update_required");
  });

  it("is unknown when the client never reported a version (never-connected case)", async () => {
    const health = await getClientHealth(db, client.id, undefined, "0.1.0-alpha.5");
    expect(health?.agentVersion).toBeNull();
    expect(health?.versionsReportedAt).toBeNull();
    expect(health?.versionStatus).toBe("unknown");
  });

  it("is unknown (no verdict) when the build stamped no server version", async () => {
    repo.recordClientAgentVersion(db, client.id, "0.1.0-alpha.4", PROBE_AT);
    // No serverVersion argument → the dev/test default (null).
    const health = await getClientHealth(db, client.id);
    expect(health?.serverVersion).toBeNull();
    expect(health?.versionStatus).toBe("unknown");
  });

  it("classifies each client in the list against the server version", async () => {
    repo.recordClientAgentVersion(db, client.id, "0.1.0-alpha.4", PROBE_AT);
    const ahead = repo.createClient(db, { hostname: "bob-pc.local", sshUser: "pct-agent" });
    repo.recordClientAgentVersion(db, ahead.id, "0.2.0", PROBE_AT);

    const list = await listClientHealth(db, undefined, { serverVersion: "0.1.0-alpha.5" });
    const byId = new Map(list.map((h) => [h.clientId, h]));
    expect(byId.get(client.id)?.versionStatus).toBe("outdated");
    expect(byId.get(ahead.id)?.versionStatus).toBe("up_to_date");
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

  it("preserves id order even when probes finish out of order (bounded concurrency)", async () => {
    const second = repo.createClient(db, { hostname: "bob-pc.local", sshUser: "pct-agent" });
    // bob's probe resolves before alice's, but the result stays ordered by id.
    const orderedProber: ClientProber = {
      async probe(seen) {
        const delay = seen.hostname === "alice-pc.local" ? 20 : 0;
        await new Promise((r) => setTimeout(r, delay));
        return { ...onlineResult };
      },
    };
    const list = await listClientHealth(db, orderedProber, { concurrency: 2 });
    expect(list.map((h) => h.clientId)).toEqual([client.id, second.id]);
    expect(list.every((h) => h.reachability === "online")).toBe(true);
  });

  it("degrades only the host that misses the per-list deadline; others still probe", async () => {
    const second = repo.createClient(db, { hostname: "bob-pc.local", sshUser: "pct-agent" });
    // A manually-controlled deadline so the test is deterministic.
    let fireDeadline!: () => void;
    const deadlineReached = new Promise<void>((resolve) => {
      fireDeadline = resolve;
    });
    const cancel = vi.fn();
    const deadlineFactory = () => ({ reached: deadlineReached, cancel });

    // alice answers; bob hangs forever (until the deadline fires).
    const hangingProber: ClientProber = {
      async probe(seen) {
        if (seen.hostname === "bob-pc.local") {
          return new Promise<ClientProbeResult>(() => {
            /* never resolves — this host is wedged until the deadline trips */
          });
        }
        return { ...onlineResult };
      },
    };

    const pending = listClientHealth(db, hangingProber, { concurrency: 2, deadlineFactory });
    // Let alice resolve, then trip the deadline for the still-hanging bob.
    await new Promise((r) => setTimeout(r, 0));
    fireDeadline();
    const list = await pending;

    const alice = list.find((h) => h.clientId === client.id);
    const bob = list.find((h) => h.clientId === second.id);
    expect(alice?.reachability).toBe("online");
    expect(bob?.reachability).toBe("unknown");
    expect(bob?.probedAt).toBeNull();
    expect(bob?.components.every((c) => c.detail.includes("#198"))).toBe(true);
    // The deadline timer is released once the walk finishes.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing probe to its client rather than failing the walk", async () => {
    const second = repo.createClient(db, { hostname: "bob-pc.local", sshUser: "pct-agent" });
    const flakyProber: ClientProber = {
      async probe(seen) {
        if (seen.hostname === "bob-pc.local") throw new Error("ssh handshake failed");
        return { ...onlineResult };
      },
    };
    const list = await listClientHealth(db, flakyProber, { concurrency: 2 });
    const alice = list.find((h) => h.clientId === client.id);
    const bob = list.find((h) => h.clientId === second.id);
    expect(alice?.reachability).toBe("online");
    expect(bob?.reachability).toBe("unknown");
    expect(bob?.components[0]?.detail).toContain("ssh handshake failed");
  });

  it("stringifies a non-Error thrown by a probe into the component detail", async () => {
    const oddProber: ClientProber = {
      async probe() {
        throw "boom";
      },
    };
    const list = await listClientHealth(db, oddProber);
    expect(list[0]?.reachability).toBe("unknown");
    expect(list[0]?.components[0]?.detail).toBe("probe failed: boom");
  });

  it("waits for every probe when the deadline is disabled (0)", async () => {
    const second = repo.createClient(db, { hostname: "bob-pc.local", sshUser: "pct-agent" });
    const factory = vi.fn();
    const prober = new FakeProber(onlineResult);
    const list = await listClientHealth(db, prober, { deadlineMs: 0, deadlineFactory: factory });
    expect(list.every((h) => h.reachability === "online")).toBe(true);
    expect(prober.seen).toHaveLength(2);
    expect(second.id).toBeGreaterThan(client.id);
    // A disabled deadline never builds a timer.
    expect(factory).not.toHaveBeenCalled();
  });
});
