/**
 * Unit test for `updateActionPayload` (#274): replace a queued row's payload in
 * place (for a deferred-resolve executor that persists its resolved target
 * before issuing the command), leaving status/FIFO position intact.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClient } from "../../../src/policy/repository.js";
import {
  enqueue,
  listForClient,
  updateActionPayload,
} from "../../../src/transport/queue/repository.js";
import { testDb, type TestDb } from "../../helpers/db.js";

describe("updateActionPayload", () => {
  let db: TestDb;
  let clientId: number;

  beforeEach(() => {
    db = testDb();
    clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("replaces the payload in place and reports success", () => {
    const row = enqueue(db, {
      clientId,
      coalesceKey: "time-today:1:abc",
      kind: "timekpr.time-today",
      payload: { resolvedTargetSeconds: null },
    });

    expect(updateActionPayload(db, row.id, { resolvedTargetSeconds: 3600 })).toBe(true);

    const [stored] = listForClient(db, clientId);
    expect(stored?.payload).toEqual({ resolvedTargetSeconds: 3600 });
    expect(stored?.status).toBe("pending");
    expect(stored?.id).toBe(row.id);
  });

  it("reports false when the row no longer exists", () => {
    expect(updateActionPayload(db, 9999, { x: 1 })).toBe(false);
  });
});
