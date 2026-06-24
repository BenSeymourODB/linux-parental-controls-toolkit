# Issue #101 — `pct-client-bridge`: system-level WebSocket service + AF_UNIX dispatch

- **Issue:** [#101](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/101)
- **Phase:** 8b (`docs/roadmap.md`)
- **Design source of truth:** [`docs/client-notifications.md`](../../docs/client-notifications.md)
  (§ "Components → 1. `pct-client-bridge`", § "Event channel"),
  [`docs/adr/0007-event-stream-version-compatibility.md`](../../docs/adr/0007-event-stream-version-compatibility.md)

## Goal

Deliver the **independently-shippable core** of `pct-client-bridge`: the
system-level TypeScript daemon that holds the outbound WebSocket to the
dashboard's `/api/events/stream`, reconnects with backoff, and fans each
server-pushed event out to the right per-user `pct-client-agent` over an
AF_UNIX socket at `/run/pct/<linux-uid>.sock`.

Everything this slice builds against is **already on `main`**:

- The event taxonomy + wire frame envelope — `server/src/events/taxonomy.ts`
  (`ServerEvent` discriminated union; `EventFrame = { seq, at, event }`).
- The stream endpoint + its auth — `server/src/events/{stream,auth}.ts`
  (`Authorization: Bearer <client-token>`, ping/pong heartbeat).
- The socket path + topology — `docs/client-notifications.md` "Event channel".

So this PR has **zero merge-conflict surface** against the 17 in-flight PRs
(it is all new files under the empty `client/agent/`) and waits on none of
them to merge.

## Explicitly deferred (tracked follow-ups, linked from the PR)

1. **ADR-0007 version handshake** (`hello`/`accept`/`refuse`, the
   `eventProtocol` N-1 window, `capabilities`). The server side + the shared
   `hello`/`accept`/`refuse` zod schemas land with **#165 (PR #286)**, which is
   **not on `main`** yet. Building the bridge's handshake against an unmerged,
   still-moving contract would invite rework. The connect path ships with a
   clean `negotiate` seam (an injected hook, default no-op against `main`'s
   current handshake-less stream); the handshake is a **new follow-up issue**
   that depends on #286. The frame envelope it negotiates is already stable on
   `main`, so deferring the handshake does not destabilise frame handling.
2. **Privileged enforcement actions** — `timekpra --kill-session` on
   `enforce.session_lock`, and lockout set/clear. These are Phase **8c**
   (**#107 / #108**); their frame *producers* (`enforce.*`, `lockout.cleared`)
   are themselves not on `main`. The dispatcher already routes those event
   types to the agent; the sudoers-backed privileged execution is the 8c slice.
3. **`.deb` packaging, systemd units, the narrow `sudoers` rule, and `/run/pct`
   `tmpfiles.d` provisioning / socket ownership** — **#106**. This slice is the
   runnable daemon + tests; turning it into an installed system service is #106.
4. **`userId → linux-uid` map provisioning from enrolment** — the bridge takes
   the map as validated config here; wiring the install script to populate it
   is client-install work (links to the enrolment issues).

## Package shape

New self-contained package `client/agent/` (per `CLAUDE.md`: "client/agent/ —
pct-client bridge + agent (TypeScript)"). It is a separate package from
`server/` because it ships as a `.deb` bundling its own Node runtime
(`docs/client-notifications.md`), so it carries its own `package.json`,
`tsconfig.json`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts`.

```
client/agent/
  package.json          # ESM, Node>=22, deps: ws + zod; dev: vitest, eslint, ...
  tsconfig.json         # strict, NodeNext, mirrors server/tsconfig.json
  eslint.config.js      # mirrors server (no-explicit-any, no-console in src/)
  .prettierrc           # { "printWidth": 100 }
  vitest.config.ts      # unit tests + 80% coverage gate, excludes src/main.ts
  src/
    bridge/
      protocol.ts        # zod frame/event schemas (mirror of server taxonomy) + decodeFrame()
      backoff.ts         # pure exponential-backoff-with-jitter calculator
      config.ts          # zod-validated BridgeConfig (+ loadConfigFromEnv)
      logger.ts          # tiny structured logger over process.std{out,err} (no console)
      ws-client.ts       # WS lifecycle: connect+bearer, decode, reconnect-with-backoff
      dispatch.ts        # AF_UNIX per-uid listening sockets; route by userId
      bridge.ts          # orchestrator: wires ws-client -> dispatch
    main.ts              # thin bootstrap (loadConfig -> start bridge); coverage-excluded
  tests/bridge/          # mirrors src layout; *.test.ts
```

### Wire-contract handling

`protocol.ts` re-declares the `EventFrame` / `ServerEvent` zod schemas as the
bridge's own copy of the contract, with a doc-comment pointing at
`server/src/events/taxonomy.ts` as the single conceptual source and a test that
pins every event `type` + the `{ seq, at, event }` envelope. The bridge cannot
import from `server/src` (separate package, no workspace, deb bundles its own
runtime), and ADR 0007 makes the contract a *negotiated* one anyway. A
follow-up may extract a shared contract package if the maintainer wants it;
noted in the PR. All inbound frames are zod-validated before use
(`CLAUDE.md` → "Validate all external input").

### AF_UNIX direction

The **bridge owns the socket** (it is the system service that can write
`/run/pct/`): for each configured supervised user it creates a listening
AF_UNIX server at `socketPath` (default `/run/pct/<uid>.sock`), the per-user
agent connects in and reads newline-delimited JSON frames
(`docs/client-notifications.md`: the agent "subscribes to its own socket from
the bridge"). Events are routed by `event.userId → linux uid → that uid's
server` and written to whatever agent connection(s) are attached. Unknown
`userId`, or no agent attached, is logged and dropped (degraded mode is
acceptable per the doc's "Notification stack unavailable" failure mode).
Filesystem ownership/mode of the socket is install/packaging concern (#106);
the dispatcher takes mode as config and does not perform any privileged chown.

## Phases

- **Phase 1 — scaffold + pure core.** Package files + CI job + `protocol.ts`,
  `backoff.ts`, `config.ts`, `logger.ts` with full unit tests. First push opens
  the draft PR.
- **Phase 2 — transport.** `dispatch.ts` (real `node:net` AF_UNIX in tests) and
  `ws-client.ts` (injected WebSocket factory seam; fake socket in tests).
- **Phase 3 — orchestration + finalize.** `bridge.ts` + `main.ts`; an
  end-to-end-ish test (fake ws → bridge → real unix-socket reader). Quality
  gate, file the deferred follow-ups, mark ready, review subagent.

## Testing

Vitest unit tests, 80% coverage gate (mirrors server). Seams chosen so every
module is deterministically testable without a live server:

- `protocol`/`backoff`/`config`/`logger`: pure — direct assertions, injected RNG/clock.
- `dispatch`: real AF_UNIX socket in a tmpdir; assert the connected reader receives routed frames, unknown-uid drop, multi-frame ordering.
- `ws-client`: inject a fake WebSocket factory; assert bearer header, frame decode/dispatch, reconnect scheduling + backoff escalation, malformed-frame tolerance.
- `bridge`: fake ws + real unix socket reader end-to-end.

## License boundary

None touched. The bridge talks to the dashboard over its own WebSocket/JSON
API (no GPL linkage); `ws` (MIT) + `zod` (MIT) only; no GPL binary is bundled.
The privileged `timekpra` invocation stays out of this slice and, when it lands
in 8c, remains a `child_process` subprocess call (never in-process linkage).
