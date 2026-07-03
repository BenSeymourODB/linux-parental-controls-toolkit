# Plan — #103 `pct-client-agent` core (Phase 8b)

The per-user notification daemon (`systemd --user`) that renders the
supervised-user-facing experience in
[`docs/client-notifications.md`](../../docs/client-notifications.md)
§Components/2: it connects to the `pct-client-bridge`'s per-user `AF_UNIX`
socket, keeps a locally-cached budget + `NotificationPolicy`, computes the
warning cadence and grace/force-close locally, and renders toasts + sound
through the desktop's own CLI tools.

Authoritative design: `docs/client-notifications.md` (Goals, Components/2,
Event channel, "Notification cadence — exact rules", "Sound design", "Grace
period and force-close", "Configuration knobs", "Failure modes").

## Why implementable end-to-end now

Everything the agent consumes is already on `main`:

- The **bridge** (#101) owns and *listens* on `/run/pct/<uid>.sock` and writes
  **newline-delimited JSON `EventFrame`s** to the connected agent
  (`client/agent/src/bridge/dispatch.ts`). The agent is the connecting reader.
- The **frame/event contract** (`{ seq, at, event }` + the 5-member
  `ServerEvent` union) is mirrored client-side in
  `client/agent/src/bridge/protocol.ts` with `decodeFrame` — the agent reuses it.
- Reusable pure utilities already in the package: `bridge/backoff.ts`
  (full-jitter exponential backoff) and `bridge/logger.ts` (`StreamLogger`).
- `NotificationPolicy` vocabulary/defaults are fixed in
  `server/src/policy/notification.ts` (`enabled`, `soundProfile`
  `off`/`subtle`/`prominent`, `graceSeconds` 0–60, loose `cadenceOverrides`).

`client/agent/src/agent/` is greenfield → no merge-conflict surface against the
open PRs (all server-side transport-health / group-UI / dashboard / ansible).

## Scope of this PR (agent core), under `client/agent/src/agent/`

Same package as the bridge; reuses `../bridge/{protocol,backoff,logger}.js`.

1. **`config.ts`** — zod-validated `AgentConfig` (own `userId`, `socketPath`,
   `awBaseUrl`, backoff knobs, kill-signal grace/escalation) + `NotificationPrefs`
   mirror of `NotificationPolicyValues`. `loadConfigFromEnv()`.
2. **`cadence.ts`** — **pure** warning-cadence engine implementing the exact
   15/5/1-minute boundary rules. Threshold set = every 15-min multiple ≥ 15min,
   plus 10, 5, 4, 3, 2, 1 min, bounded by the budget total. A `CadenceTracker`
   per budget remembers the last-announced threshold (monotonic) so a warning
   fires once per boundary as remaining ticks down; `0` → the final "time's up".
   A `coalesce()` groups budgets that crossed within the same tick into one toast.
3. **`budget.ts`** — the locally cached budgets: `{ key, label, totalSeconds,
   activityId|null }` + remaining = `max(0, total − used)`. `grant.applied`
   adds seconds to the matching budget; `policy.changed` marks stale (re-pull).
4. **`effects.ts`** — desktop-integration seams as **subprocess** calls behind
   an injected `Spawn`: `Notifier` (`gdbus call … Notify`, falling back to
   `notify-send`, supporting in-place countdown updates via the returned id),
   `SoundPlayer` (`canberra-gtk-play`, `off`/`subtle`/`prominent` → sound-name
   map), `ProcessSignaller` (`process.kill`). No native bindings (license rule).
5. **`force-close.ts`** — grace-countdown state machine: on 0:00 / a per-app
   `enforce.force_close`, show the countdown toast updating each second (injected
   clock), cancel + "keep going" toast if a grant tops the budget back up, else
   after grace `SIGTERM`→(5s)→`SIGKILL` the resolved PIDs.
6. **`usage.ts`** — `UsageSource` interface + `AwUsageSource` polling
   `aw-server` on `http://127.0.0.1:5600` over REST (injected `fetch`), per the
   doc ("Polls aw-server on localhost:5600 … render warnings locally").
7. **`agent.ts`** — orchestrator: socket intake (reconnecting reader over the
   bridge socket, reusing `decodeFrame` + `backoff`) → cache updates + toasts;
   a tick loop (injected clock + `UsageSource`) → cadence → notifier;
   `enforce.force_close` → the force-close state machine.
8. **`main.ts`** — thin bootstrap (load config, build logger + agent, SIGTERM).
   Coverage-excluded like `bridge`/`main.ts`.

Tooling already exists (the package is shared with the bridge): the CI
`client-agent` job, `package.json`, `tsconfig`, eslint, vitest 80% gate.

## Deferred (tracked follow-ups, linked from the PR)

- **Activity-matcher → PID resolution for force-close.** Needs the activity
  matchers pushed to the *client* as part of policy distribution (a transport
  concern not yet built). The kill state machine ships fully; PID resolution is
  behind an injected `resolvePids(activityId)` seam that returns `[]` (logged
  degraded) until a **new follow-up issue** wires client-side matchers.
- **`enforce.session_lock` / lockout `timekpra --kill-session`** — the bridge's
  privileged Phase-8c surface (#107/#108); the agent only toasts around it.
- **Interactive toast action buttons + client→server action frame** — #337
  (buttons stay inert here).
- **`.deb` packaging, `systemd --user` unit, `/run/pct` tmpfiles** — #106.
- **Structured `cadence_overrides` semantics** — #302 (the agent honours a
  simple per-budget mute; the rich override schema is that issue's).
- **ADR-0007 version handshake** — follow-up gated on the #165 server side.

## Phasing (commit + push per phase; first push opens the draft PR)

- **Phase 1** — `config.ts` + `cadence.ts` + `budget.ts` (pure cores) + tests.
- **Phase 2** — `effects.ts` + `force-close.ts` + `usage.ts` + tests.
- **Phase 3** — `agent.ts` orchestrator (socket intake + tick loop) + `main.ts`
  + an integration-style test (bridge `Dispatcher` → real socket → agent
  receives + renders); quality gate, follow-ups filed, mark ready, review pass.

## License boundary

No GPL linkage: the agent talks to the bridge over a local JSON `AF_UNIX`
socket, to `aw-server` over REST, and renders via the desktop's own CLI tools
(`gdbus`/`notify-send`/`canberra-gtk-play`) as **subprocesses**. `timekpra`
session-kill is the bridge's job (Phase 8c), not this PR. No GPL binaries added
to any image; the `.deb` (deferred, #106) bundles its own Node runtime.

## Tamper resistance

Within bounds — a notification/relay daemon acting on the user's *own*
processes only. No anti-tamper, obfuscation, or `/etc`/`/usr` lockdown.
