# Issue #232 — Key transport-facade per-client dispatch on platform/capability, not `if (linux)`

Roadmap: `docs/roadmap.md` → Phase 4 (SSH + `timekpra` transport).
Design source: `docs/windows-client-support.md` → "Modularity tweaks to make
cheaply now" item 6; `Client.platform` column from #229.

## Problem

The live policy-push path (`transport/policy-push`) is the one place that wires
real **per-client** dispatch today, and it bakes in "every client is Linux":
`createPolicyPushExecutor` loads the `ClientRow` (which already carries
`client.platform`, `linux`/`windows`) and then **unconditionally** builds a
`timekpra`-over-SSH client and pushes. There is no seam where a future
`WindowsAgentRunner` could be selected.

Item 6 of the Windows design doc asks us to make that seam **now**: route
per-client dispatch on the client's declared platform, defaulting to the Linux
runner, so Windows is purely additive.

## Decision

Introduce a small **platform-keyed runner registry** local to `policy-push`.
The executor becomes a thin, platform-agnostic dispatcher that:

1. parses the payload and runs the existing platform-agnostic no-op branches
   (`userId === null`, missing client, missing user-client link);
2. selects a `PlatformPolicyRunner` by `client.platform` from the registry;
3. if none is registered for that platform -> log a warning and no-op
   (consistent with the module's existing warn+no-op branches);
4. otherwise resolves the platform-agnostic enforcement context (tz, schedules,
   budgets, now) and delegates to `runner.enforce(ctx)`.

Selection is exact-match, not "default to Linux for anything unknown" — pushing
`timekpra` to a Windows box would be wrong. The registry is seeded with the
Linux runner; since `Client.platform` defaults to `linux` and is the only
platform with a runner, every real client today still resolves to Linux —
behaviour unchanged.

## Shape

- New `platform-runner.ts`: `PolicyEnforcementContext`, `PlatformPolicyRunner`,
  `PlatformRunnerRegistry`, `createPlatformRunnerRegistry` (throws on duplicate
  platform).
- New `linux-runner.ts`: `createLinuxPolicyRunner({ buildClient, log? })` —
  `platform: "linux"`, `enforce` = the exact body lifted from today's executor
  (resolvePolicyPush -> timekpr setters -> full-lockout allowed-hours skip). The
  `PolicyPushClient*` types move/re-export here.
- `executor.ts`: swap `buildClient` option for `registry`; keep db/defaultTz/
  log?/now?.
- `bootstrap.ts`: wrap the existing audited Linux runner in a registry, pass it
  to the executor. No behavioural change in production.

## Tests (unit only — pure TS, no Docker)

- `platform-runner.test.ts`: resolve registered/unregistered, `platforms`,
  duplicate-registration throws.
- `linux-runner.test.ts`: setter sequence, full-lockout skip + warn, error
  propagation — reusing the existing recording-client fake.
- `executor.test.ts` (updated): wrap recording client in runner + registry; add
  an unsupported-platform (windows) -> warn + no-op case; keep all existing
  no-op/error cases green.

## Out of scope (tracked follow-up)

- Ansible re-apply path (`transport/reapply`) also iterates clients
  Linux-unconditionally but is not live-wired yet -> file + link a follow-up.
- No `WindowsAgentRunner` is implemented (seam only).

## License boundary

Unchanged — still exec-over-SSH of `timekpra` (GPL) as a subprocess via the
existing audited facade. No in-process GPL linkage, no GPL binary, no new
dependency, no boundary collapsed.
