# Plan — #101 `pct-client-bridge` core (Phase 8b)

System-level client daemon that holds the WebSocket connection to the
dashboard's `/api/events/stream`, reconnects with backoff, validates incoming
event frames, and fans each one out to the per-supervised-user
`pct-client-agent` (#103) over an `AF_UNIX` socket at `/run/pct/<linux-uid>.sock`.

Authoritative design: [`docs/client-notifications.md`](../../docs/client-notifications.md)
§"Components" + §"Event channel"; the wire frame and event union are
[`server/src/events/taxonomy.ts`](../../server/src/events/taxonomy.ts) (on `main`).

## Why this is implementable end-to-end now

Everything the core consumes is already on `main`:

- The event **frame envelope** (`{ seq, at, event }`) and the 5-member
  `ServerEvent` discriminated union — `server/src/events/taxonomy.ts`.
- The **bearer-auth WebSocket endpoint** `GET /api/events/stream`
  (`server/src/events/stream.ts` + `auth.ts`): `Authorization: Bearer <client-token>`.
- The **socket layout** `/run/pct/<linux-uid>.sock` — `docs/client-notifications.md`.

`client/agent/` is empty greenfield → zero merge-conflict surface against the
17 open PRs.

## Scope of this PR (bridge core)

New self-contained TypeScript package under `client/agent/` (CLAUDE.md →
"client/agent/ — pct-client bridge + agent"). The package will later also host
the per-user agent (#103); this PR adds only the bridge.

Modules (`client/agent/src/bridge/`):

1. **`protocol.ts`** — zod schemas for `EventFrame` + `ServerEvent`, a
   deliberate **mirror** of `server/src/events/taxonomy.ts`, plus
   `parseFrame(raw: unknown): EventFrame`. No workspace exists to import the
   server schemas cross-package and the `.deb` bundles its own runtime, so the
   bridge owns its copy of the contract (the standard "generated client" shape);
   a fidelity test pins the event-type set so drift surfaces. Validating all
   external input with zod is the CLAUDE.md rule.
2. **`backoff.ts`** — pure `nextDelay(attempt, opts, rand)` exponential backoff
   with full jitter and a cap; injected `rand` keeps it deterministic in tests.
3. **`config.ts`** — zod-validated `BridgeConfig` (server WS URL, client bearer
   token, `userId → { linuxUid, socketPath }` routing map, socket dir, backoff
   knobs, heartbeat). `loadConfigFromEnv()`. The routing map's *provisioning*
   (from enrolment) is install-script work — here it is validated input.
4. **`dispatch.ts`** — `UnixDispatcher`: owns one `net` **listening** socket per
   configured user at `socketPath` (the bridge is the system service that owns
   `/run/pct`; the agent connects in and reads — "subscribes to its own socket
   from the bridge"). `dispatch(event)` routes by `event.userId` → uid → that
   user's server → writes a newline-delimited JSON frame to every connected
   agent. Unknown userId / no connected agent → log + drop (degraded mode per
   the doc). `close()` tears down all servers. Socket filesystem
   ownership/permissions and `/run/pct` creation are install/tmpfiles work
   (deferred); the dispatcher takes the path + mode as input.
5. **`ws-client.ts`** — `EventStreamClient`: opens the WebSocket with the bearer
   header, validates each message via `parseFrame`, invokes an `onFrame`
   callback, and on `close`/`error` schedules a reconnect using `backoff.ts`.
   The `ws` socket is created through an injected factory (`WebSocketFactory`)
   so the lifecycle unit-tests with a fake — no live server needed. `ws`
   auto-answers server pings (matches the server heartbeat in `heartbeat.ts`).
6. **`bridge.ts`** — orchestrator: wires `EventStreamClient.onFrame` →
   `UnixDispatcher.dispatch`. `start()` / `stop()`.
7. **`main.ts`** — thin bootstrap (load config, build logger, start bridge,
   handle SIGTERM). Coverage-excluded like `server/src/main.ts`.
8. **`logger.ts`** — minimal structured logger writing JSON lines to
   stdout/stderr via `process.stdout.write` (journald captures it); avoids
   `console.*` so the same `no-console` discipline as the server holds.

Tooling: `package.json` (deps `ws` + `zod`; dev `vitest`, `eslint`,
`typescript-eslint`, `prettier`, `@types/node`, `@types/ws`,
`@vitest/coverage-v8`), `tsconfig.json` (mirror server: strict, NodeNext, ESM,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`),
`eslint.config.js` (mirror server incl. `no-console` on `src/`), `.prettierrc`
(`printWidth: 100`), `vitest.config.ts` (80% gate, exclude `main.ts`).
CI: add a `client-agent` job to `.github/workflows/ci.yml` mirroring the server
lint/typecheck/test gate, guarded on `client/agent/package.json` existing.

### New dependencies (justification for PR body)

- **`ws`** — standalone WebSocket *client*; the server's `@fastify/websocket`
  is a server-side Fastify plugin and can't drive an outbound client
  connection. `ws` is what `@fastify/websocket` itself wraps, so it's already
  transitively vetted in the tree. MIT.
- **`zod`** — runtime frame validation; same validate-all-external-input rule
  and same library already used server-wide. MIT.

## Deferred (tracked follow-ups, linked from the PR)

- **ADR-0007 version handshake** (`hello`/`accept`/`refuse`, `eventProtocol`
  N-1 window). Its server side + shared zod schemas land with **#165 (PR #286)**,
  not yet on `main`. Building against an unmerged contract invites rework, so
  the connect path ships with a documented negotiation seam and this becomes a
  **new follow-up issue** that depends on #286. The frame envelope it negotiates
  is already stable on `main`.
- **Privileged enforcement actions** — `timekpra --kill-session` on
  `enforce.session_lock`, lockout set/clear — Phase 8c, **#107 / #108**. Their
  frame producers aren't on `main` either; the dispatcher exposes the routing
  seam and 8c adds the sudoers-backed execution.
- **`.deb` packaging, systemd units, narrow sudoers, `/run/pct` tmpfiles** —
  **#106**.

## Phasing

- **Phase 1** — package scaffold + `protocol.ts` + `backoff.ts` + `config.ts` +
  their unit tests + CI job. First push → draft PR.
- **Phase 2** — `dispatch.ts` (real `node:net` AF_UNIX in tests) + `ws-client.ts`
  (fake-ws seam) + unit tests.
- **Phase 3** — `bridge.ts` + `main.ts` + `logger.ts`; an integration-style test
  (fake ws frame → bridge → real unix-socket reader receives it). Quality gate,
  follow-ups filed, PR marked ready, review subagent.

## License boundary

No GPL linkage: `ws` + `zod` are MIT; the bridge talks to the dashboard over
WebSocket and to the per-user agent over a local JSON socket. `timekpra` is
invoked only as a subprocess and that path is **deferred to Phase 8c** — not in
this PR. No GPL binaries added to any image. The `.deb` (deferred, #106) bundles
its own Node runtime.

## Tamper-resistance

Within bounds: the bridge is a plain notification/event relay. No anti-tamper,
no obfuscation, no `/etc`/`/usr` lockdown. The privileged surface (narrow
sudoers, deferred to 8c) is the documented minimum.
