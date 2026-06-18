/**
 * Unit tests for the `timekpra --userinfo` stdout parser.
 *
 * The schema must accept the `KEY: VALUE` block `timekpra` prints, expose the
 * pairs through {@link TimekprUserInfo}, and fail (so the facade raises an
 * `SshParseError`) on output that is not that block.
 */
import { describe, expect, it } from "vitest";

import { timekprUserInfoSchema } from "../../../src/transport/timekpr/userinfo.js";

const SAMPLE = [
  "USER_NAME: alice",
  "ALLOWED_WEEKDAYS: 1;2;3;4;5",
  "TIME_LIMIT_PER_WEEK: 86400",
  "PLAYTIME_ENABLED: True",
].join("\n");

describe("timekprUserInfoSchema", () => {
  it("parses KEY: VALUE lines into a typed lookup", () => {
    const info = timekprUserInfoSchema.parse(SAMPLE);
    expect(info.get("USER_NAME")).toBe("alice");
    expect(info.get("ALLOWED_WEEKDAYS")).toBe("1;2;3;4;5");
    expect(info.get("TIME_LIMIT_PER_WEEK")).toBe("86400");
    expect(info.has("PLAYTIME_ENABLED")).toBe(true);
    expect(info.has("NOT_PRESENT")).toBe(false);
    expect(info.get("NOT_PRESENT")).toBeUndefined();
  });

  it("preserves key order and snapshots to a record", () => {
    const info = timekprUserInfoSchema.parse(SAMPLE);
    expect(info.keys()).toEqual([
      "USER_NAME",
      "ALLOWED_WEEKDAYS",
      "TIME_LIMIT_PER_WEEK",
      "PLAYTIME_ENABLED",
    ]);
    expect(info.toRecord()).toMatchObject({ USER_NAME: "alice", TIME_LIMIT_PER_WEEK: "86400" });
  });

  it("ignores blank lines and trailing CR, and tolerates empty values", () => {
    const info = timekprUserInfoSchema.parse("A: 1\r\n\r\nB:\n");
    expect(info.get("A")).toBe("1");
    expect(info.get("B")).toBe("");
    expect(info.keys()).toEqual(["A", "B"]);
  });

  it("treats a run of spaces/tabs after the colon as the separator", () => {
    const info = timekprUserInfoSchema.parse("K:   value\nT:\tvalue2");
    expect(info.get("K")).toBe("value");
    expect(info.get("T")).toBe("value2");
  });

  it("keeps the last value when a key repeats", () => {
    const info = timekprUserInfoSchema.parse("K: first\nK: second");
    expect(info.get("K")).toBe("second");
  });

  it("rejects output with no KEY: VALUE lines", () => {
    expect(timekprUserInfoSchema.safeParse("").success).toBe(false);
    expect(timekprUserInfoSchema.safeParse("   \n  ").success).toBe(false);
  });

  it("rejects output containing a non KEY: VALUE line", () => {
    const result = timekprUserInfoSchema.safeParse("USER_NAME: alice\nunexpected garbage");
    expect(result.success).toBe(false);
  });
});
