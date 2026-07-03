/**
 * Unit tests for the preview endpoint's opt-in reachability probe helper
 * (`probeReachability`, #281) against a fake {@link ClientProber}. Exercises the
 * online (with `last_seen` bump), offline, thrown-error → `unknown`, and
 * deadline-timeout → `unknown` outcomes, plus that every client is annotated.
 *
 * The route-level wiring (probe only when `probe: true` + a prober is wired) is
 * covered by the HTTP tests in `policy-preview.test.ts`; this isolates the
 * probe/annotate logic and the injected-deadline seam.
 */
import { describe, expect, it } from "vitest";

import { probeReachability } from "../../src/api/policy/preview-routes.js";
import type { PolicyDb } from "../../src/policy/db.js";
import * as repo from "../../src/policy/repository.js";
import type { ClientRow } from "../../src/policy/repository.js";
import { clients } from "../../src/policy/schema.js";
import type {
  ClientProber,
  ClientProbeResult,
  ClientReachability,
} from "../../src/transport/health/index.js";
import type { Deadline } from "../../src/util/concurrency.js";
import { testDb } from "../helpers/db.js";

const AT = new Date("2026-06-17T12:00:05Z");

/** Insert a client and return its full row. */
function seedClient(db: PolicyDb, hostname: string): ClientRow {
  const inserted = db
    .insert(clients)
    .values({ hostname, sshUser: "pct-agent" })
    .returning({ id: clients.id })
    .get();
  if (inserted === undefined) throw new Error("client insert returned no row");
  const row = repo.getClient(db, inserted.id);
  if (row === undefined) throw new Error("client not found after insert");
  return row;
}

/** A prober that answers per-host from a map (missing host → rejects). */
function proberFrom(verdicts: Map<string, ClientReachability>): ClientProber {
  return {
    probe: (client: Pick<ClientRow, "hostname" | "sshUser">): Promise<ClientProbeResult> => {
      const reachability = verdicts.get(client.hostname);
      if (reachability === undefined) {
        return Promise.reject(new Error(`no verdict for ${client.hostname}`));
      }
      return Promise.resolve({ reachability, at: AT, components: [], reachabilityReason: null });
    },
  };
}

/** A deadline that has already elapsed — forces every probe to lose the race. */
function elapsedDeadline(): Deadline {
  return { reached: Promise.resolve(), cancel: () => undefined };
}

describe("probeReachability", () => {
  it("reports online with the probe instant and bumps last_seen", async () => {
    const db = testDb();
    const client = seedClient(db, "mint-online");
    const annotations = await probeReachability(
      db,
      proberFrom(new Map([["mint-online", "online"]])),
      [{ client, pendingQueueDepth: 0 }],
    );
    expect(annotations.get(client.id)).toEqual({
      reachability: "online",
      probedAt: AT,
      lastSeen: AT,
    });
    // The bump is persisted.
    expect(repo.getClient(db, client.id)?.lastSeen).toEqual(AT);
    db.$client.close();
  });

  it("reports offline without touching last_seen", async () => {
    const db = testDb();
    const client = seedClient(db, "mint-offline");
    const annotations = await probeReachability(
      db,
      proberFrom(new Map([["mint-offline", "offline"]])),
      [{ client, pendingQueueDepth: 0 }],
    );
    expect(annotations.get(client.id)).toEqual({
      reachability: "offline",
      probedAt: AT,
      lastSeen: null,
    });
    expect(repo.getClient(db, client.id)?.lastSeen).toBeNull();
    db.$client.close();
  });

  it("degrades a probe that throws to unknown", async () => {
    const db = testDb();
    const client = seedClient(db, "mint-boom");
    // No verdict for this host → the fake prober rejects.
    const annotations = await probeReachability(db, proberFrom(new Map()), [
      { client, pendingQueueDepth: 0 },
    ]);
    expect(annotations.get(client.id)).toEqual({
      reachability: "unknown",
      probedAt: null,
      lastSeen: null,
    });
    db.$client.close();
  });

  it("degrades a probe that misses the deadline to unknown", async () => {
    const db = testDb();
    const client = seedClient(db, "mint-slow");
    // Prober never settles; the already-elapsed deadline wins the race.
    const hangingProber: ClientProber = {
      probe: () =>
        new Promise<ClientProbeResult>(() => {
          /* never settles — the deadline must win */
        }),
    };
    const annotations = await probeReachability(
      db,
      hangingProber,
      [{ client, pendingQueueDepth: 0 }],
      { deadlineFactory: elapsedDeadline },
    );
    expect(annotations.get(client.id)).toEqual({
      reachability: "unknown",
      probedAt: null,
      lastSeen: null,
    });
    db.$client.close();
  });

  it("annotates every client across a mixed batch", async () => {
    const db = testDb();
    const online = seedClient(db, "a-online");
    const offline = seedClient(db, "b-offline");
    const annotations = await probeReachability(
      db,
      proberFrom(
        new Map<string, ClientReachability>([
          ["a-online", "online"],
          ["b-offline", "offline"],
        ]),
      ),
      [
        { client: online, pendingQueueDepth: 0 },
        { client: offline, pendingQueueDepth: 3 },
      ],
      { concurrency: 2 },
    );
    expect(annotations.get(online.id)?.reachability).toBe("online");
    expect(annotations.get(offline.id)?.reachability).toBe("offline");
    expect(annotations.size).toBe(2);
    db.$client.close();
  });
});
