/**
 * Live integration test for {@link TimekprClient} over a real SSH connection
 * (issue #157, deferred from #83).
 *
 * `client.test.ts` drives the client through an in-process fake transport — it
 * asserts *what* argv the client would run, but never crosses a process or
 * network boundary. This test runs the client over a real `ssh2` connection to
 * a live OpenSSH server carrying the **stub** `timekpra`, which records every
 * invocation. Reading that log back over SSH confirms the full chain — builder
 * → client → SSH facade → shell-quote → real sshd → process argv — delivers
 * each argument intact, including the `;`-list, `[mm-mm]` bracket and `!`
 * grammar that shell-quoting must protect.
 *
 * Scope note: this asserts the argv **we emit** reaches the remote process
 * verbatim, against a stub. Confirming the *real* Timekpr-nExT binary accepts
 * that grammar (a daemon round-trip) needs a Timekpr-nExT D-Bus container and
 * is tracked as separate follow-up work — see the PR for #157.
 *
 * Env-gated via {@link liveSshEnabled}; the unit run never collects
 * `*.int.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SshTarget } from "../../../src/transport/ssh/facade.js";
import { SshTransport } from "../../../src/transport/ssh/facade.js";
import { TimekprClient } from "../../../src/transport/timekpr/client.js";
import { ALL_DAYS } from "../../../src/transport/timekpr/commands.js";
import {
  STUB_INVOCATION_LOG,
  STUB_TIMEKPRA,
  liveSshEnabled,
  liveSshTarget,
  waitForSshReady,
} from "../../helpers/ssh-live.js";

describe.skipIf(!liveSshEnabled)("TimekprClient over live SSH (stub timekpra)", () => {
  const transport = new SshTransport({ readyTimeoutMs: 8000 });
  let target: SshTarget;
  let client: TimekprClient;

  beforeAll(async () => {
    target = liveSshTarget();
    // The stub default `["sudo", "timekpra"]` prefix needs neither here: call
    // the mounted stub by absolute path so there's no sudoers/PATH dependency.
    client = new TimekprClient(transport, target, "alice", { binary: [STUB_TIMEKPRA] });
    await waitForSshReady(transport, target);
    // Start from an empty log so assertions only see this run's invocations.
    await transport.execChecked(target, ["/bin/sh", "-c", `: > ${STUB_INVOCATION_LOG}`]);
  }, 60_000);

  afterAll(() => {
    transport.disposeAll();
  });

  async function invocationLog(): Promise<string> {
    const result = await transport.exec(target, ["/bin/cat", STUB_INVOCATION_LOG]);
    return result.stdout;
  }

  it("delivers each setter's argv to the remote timekpra verbatim", async () => {
    await client.setTimeLimits([3600, 3600, 3600, 3600, 3600, 7200, 7200]);
    await client.setTimeLimitWeek(86_400);
    await client.setTimeLimitMonth(360_000);
    // Weekday-list day position + a [mm-60] minute window + an unaccounted
    // hour — the exact grammar items PR #155's review flagged.
    await client.setAllowedHours(
      [1, 2, 3, 4, 5],
      [{ hour: 8, startMinute: 30, endMinute: 60 }, { hour: 9 }, { hour: 22, unaccounted: true }],
    );
    await client.setAllowedHours(ALL_DAYS, [{ hour: 0 }, { hour: 23 }]);
    await client.setPlayTimeActivities([
      { mask: "minetest", description: "Minetest" },
      { mask: "steam" },
    ]);

    const log = await invocationLog();
    expect(log).toContain("--settimelimits alice 3600;3600;3600;3600;3600;7200;7200");
    expect(log).toContain("--settimelimitweek alice 86400");
    expect(log).toContain("--settimelimitmonth alice 360000");
    expect(log).toContain("--setallowedhours alice 1;2;3;4;5 8[30-60];9;!22");
    expect(log).toContain("--setallowedhours alice ALL 0;23");
    expect(log).toContain("--setplaytimeactivities alice minetest[Minetest];steam");
  });

  it("getUserInfo parses the stub's --userinfo block over the wire", async () => {
    const info = await client.getUserInfo();
    // The stub echoes the username arg ($2), so this also confirms the client
    // passed the right user through to `--userinfo`.
    expect(info.get("USER_NAME")).toBe("alice");
    expect(info.get("TIME_LIMIT_PER_WEEK")).toBe("86400");
    expect(info.get("TIME_LIMIT_PER_MONTH")).toBe("360000");
  });
});
