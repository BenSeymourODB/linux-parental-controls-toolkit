/**
 * Covers the defensive "dangling link" branch in {@link adjustTimeToday}: a link
 * row still resolves but its client has vanished between the read and the
 * dispatch (a TOCTOU race the FK cascade normally prevents). The repository is
 * mocked so `listUserLinks` returns a link whose `getClient` is `undefined`,
 * which can't be constructed against a real FK-enforced DB.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/policy/repository.js", () => ({
  listUserLinks: () => [{ userId: 1, clientId: 7, osUsername: "alice", osUserRef: "1001" }],
  getClient: () => undefined,
}));

const { adjustTimeToday } = await import("../../../src/transport/time-today/adjust.js");
const { testDb } = await import("../../helpers/db.js");

describe("adjustTimeToday — dangling link", () => {
  it("marks the client failed and never builds a client when getClient returns undefined", async () => {
    const db = testDb();
    let built = 0;
    const result = await adjustTimeToday(
      db,
      () => {
        built += 1;
        return { setTimeLeft: async () => undefined };
      },
      { userId: 1, operation: "+", seconds: 1800 },
    );

    expect(built).toBe(0);
    expect(result.results).toEqual([
      {
        clientId: 7,
        osUsername: "alice",
        status: "failed",
        error: "Client 7 no longer exists",
      },
    ]);
    db.$client.close();
  });
});
