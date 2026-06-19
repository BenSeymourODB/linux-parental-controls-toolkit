/**
 * The `transport/timekpr` barrel re-exports the module's public surface and
 * tags the module name. This guards that the intended API stays exported (a
 * rename or accidental drop fails here).
 */
import { describe, expect, it } from "vitest";

import * as timekpr from "../../../src/transport/timekpr/index.js";

describe("transport/timekpr index", () => {
  it("tags the module name", () => {
    expect(timekpr.moduleName).toBe("transport/timekpr");
  });

  it("re-exports the client, builders, error, and userinfo surface", () => {
    expect(timekpr.TimekprClient).toBeTypeOf("function");
    expect(timekpr.TimekprArgumentError).toBeTypeOf("function");
    expect(timekpr.TimekprUserInfo).toBeTypeOf("function");
    expect(timekpr.timekprUserInfoSchema).toBeDefined();
    expect(timekpr.ALL_DAYS).toBe("ALL");
    expect(timekpr.DEFAULT_TIMEKPRA_BINARY).toEqual(["sudo", "timekpra"]);
    for (const builder of [
      timekpr.buildSetAllowedDays,
      timekpr.buildSetAllowedHours,
      timekpr.buildSetTimeLimits,
      timekpr.buildSetTimeLimitWeek,
      timekpr.buildSetTimeLimitMonth,
      timekpr.buildSetPlayTimeEnabled,
      timekpr.buildSetPlayTimeLimitOverride,
      timekpr.buildSetPlayTimeUnaccountedIntervalsEnabled,
      timekpr.buildSetPlayTimeAllowedDays,
      timekpr.buildSetPlayTimeLimits,
      timekpr.buildSetPlayTimeActivities,
      timekpr.buildUserInfo,
      timekpr.assertUsername,
    ]) {
      expect(builder).toBeTypeOf("function");
    }
  });
});
