# Issue #325 — Key the Ansible re-apply path on platform/capability

Roadmap: `docs/roadmap.md` → Phase 6 (Ansible config push / tamper-reversion).
Follow-up to **#232** (the policy-push half), explicitly tracked in that
issue's plan doc under "Out of scope (tracked follow-up)".
Design source: `docs/windows-client-support.md` → "Modularity tweaks to make
cheaply now" item 6 (names both `SSHTr` and `AnsTr`); `Client.platform` from
#229.

## Problem

The periodic re-apply (tamper-reversion) scheduler (`transport/reapply`) walks
the enrolled fleet via its injected `ClientLoader` and runs the Phase-6 Ansible
playbooks against **every** target unconditionally — the same "every client is
Linux" assumption #232 removed from the live policy-push path, just in the other
runner. The scheduler is **not live-wired yet** (not started in `buildApp`; its
start lands with the Phase-6 playbook work, #90/#91/#92), so this is a clean
standalone change that gives Windows the seam before a real call site exists.

## Decision

Add the same **exact-match, skip-not-coerce** platform selection #232
established, expressed as a **served-platforms capability gate** rather than a
per-platform runner registry.

Why a set, not a runner registry (the difference from #232): the live push has a
genuinely *different enforcement mechanism per platform* (`timekpra`-over-SSH vs.
a future Windows agent), so a `Platform → PlatformPolicyRunner` registry is the
honest model there. The re-apply path is a **single Ansible reconciler** — the
`playbooks` are inherently Linux Ansible YAML and the injected `AnsibleRunner`
execs `ansible-playbook`. A non-Linux client is not reconciled by a *different
Ansible runner*; it is reconciled by an *entirely different mechanism* that is
not this scheduler at all. So the correct seam is "which platforms does this
Ansible re-apply reconciler serve" — a client outside that set is **skipped**
(its drift is somebody else's job), never coerced onto the Linux playbooks.

Default served set is `{ linux }`. Because `Client.platform` is `NOT NULL
DEFAULT 'linux'` (#229) — every existing and newly-enrolled client is `linux` —
this preserves today's behaviour exactly: no real client is skipped.

## Shape

- `reapply/types.ts`: `ReapplyTarget` gains a required `platform: Platform`.
  A full Drizzle `clients` select row (`ClientRow`, which carries `platform`)
  stays assignable, so the production loader `() => listClients(db)` needs no
  change.
- `reapply/scheduler.ts`:
  - Export `DEFAULT_REAPPLY_PLATFORMS: ReadonlySet<Platform> = new Set(["linux"])`.
  - `PeriodicReapplyOptions` gains an optional `reapplyPlatforms?:
    ReadonlySet<Platform>` (defaults to the constant).
  - In the `tick` per-client loop, **before** the backoff/probe checks, skip a
    client whose `platform` is not in the served set with a `debug` line
    (`re-apply skipped: no re-apply runner for client platform`). A skipped
    client is never probed, reconciled, or backed off.
  - `debug` (not `warn` as #232's one-shot push uses): re-apply is a periodic
    fleet sweep, so a warn per unsupported client every tick would be log spam.
- `reapply/index.ts`: re-export `DEFAULT_REAPPLY_PLATFORMS`.

No `WindowsAgentRunner` / Windows reconciler is implemented — seam only, same as
#232.

## Tests (unit only — pure TS, no Docker)

Extend `tests/transport/reapply/scheduler.test.ts`:

- Update the existing `ReapplyTarget` literals to carry `platform: "linux"`.
- New: a `windows` client is skipped — runner never called, nothing audited,
  never probed, `debug` skip line emitted, no backoff recorded.
- New: mixed fleet (`linux` + `windows`) reconciles only the linux client.
- New: a custom `reapplyPlatforms` override (adding `windows`) reconciles the
  windows client — proves the gate is the only thing keying selection.
- New: `DEFAULT_REAPPLY_PLATFORMS` is `{ linux }`.

## License boundary

Unchanged — pure in-process TypeScript dispatch/gating over the injected seams;
the real reconciliation still execs `ansible-playbook` as a subprocess via the
merged `transport/ansible` runner. No GPL code linked in-process, no GPL binary
added, no new dependency, no subprocess/REST boundary collapsed
(`CLAUDE.md` → "License boundaries").
