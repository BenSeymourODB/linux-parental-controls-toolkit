# Plan — #303 pct-client-bridge client-side ADR-0007 version handshake

Roadmap: `docs/roadmap.md` → Phase 8b. ADR: `docs/adr/0007-event-stream-version-compatibility.md`.

## Why now

The server side of the handshake (#165) is merged: `server/src/events/protocol.ts`
holds `EVENT_PROTOCOL`, `negotiate()`, and the `hello` / `accept` / `refuse` zod
schemas, and `server/src/events/stream.ts` waits for the client's opening `hello`
(a 10s `DEFAULT_HELLO_TIMEOUT_MS`) before registering the socket.

The bridge's `WsClient` (#101) still ships the deferred stub: on open it connects
straight to frames and never speaks. Against the current server that means the
bridge **is refused after the 10s hello-timeout on every connect and receives no
events at all** — so this is a correctness fix, not just forward-compat plumbing.

## Contract (from ADR 0007 §2–§4, mirrored from the server)

- Client speaks first on every (re)connect with `hello`:
  `{ type:"hello", agentVersion, eventProtocol, capabilities: string[] }`.
- Server replies with exactly one of:
  - `accept` `{ type:"accept", eventProtocol, apiVersion }` → stream proceeds;
    event frames follow.
  - `refuse` `{ type:"refuse", error:{ code:"incompatible_protocol", message } }`
    → server closes the socket.
- The `accept`/`refuse` is always the **first** inbound message (the server sends
  it before `hub.register`), so the first message after `hello` is the handshake
  reply and everything after is an event frame.
- Capabilities are additive flags naming the enforcement primitives the client
  honours. The Linux bridge forwards all five events, so it advertises both
  server-recognised primitives: `session_budget` and `per_app_close`
  (`server/src/events/capabilities.ts` → `CLIENT_CAPABILITIES`).

## Single-sourcing the schema

The bridge ships as a separate `.deb` with its own bundled Node runtime — there
is no workspace to import `server/src` across (see the existing note in
`client/agent/src/bridge/protocol.ts`, which re-declares the *event* envelope for
the same reason and pins it with a drift test). This slice follows that exact
precedent: it re-declares the `hello`/`accept`/`refuse` shapes in a new
`bridge/handshake.ts` and pins them against the server contract with a drift
test. Noted as a deliberate, precedent-following deviation from the issue's
"do not re-declare a second copy" ideal, which the package split makes impossible.

## Phases

### Phase 1 — the handshake contract module + tests
- `client/agent/src/bridge/handshake.ts`: `EVENT_PROTOCOL` (=1), `BRIDGE_CAPABILITIES`
  (`["session_budget","per_app_close"]`), `helloFrameSchema` + `buildHello(...)`,
  `acceptFrameSchema`, `refuseFrameSchema`, `INCOMPATIBLE_PROTOCOL_CODE`, and
  `parseHandshakeReply(raw) → {kind:"accept"|"refuse", frame} | null`.
- `tests/bridge/handshake.test.ts`: hello shape + capabilities; parse accept /
  refuse / malformed / non-handshake → null; drift guard vs. the server contract.

### Phase 2 — wire the handshake into `WsClient` + config + tests
- `WebSocketLike` gains `send(data: string)`.
- `WsClient` sends `hello` on open, withholds event frames until `accept`, and on
  `refuse` logs + surfaces `update_required` and **stops reconnecting** (no
  hot-loop). A bounded client-side handshake timeout closes → reconnects if no
  reply arrives. Re-handshakes on every reconnect.
- `bridge/config.ts` gains `agentVersion` (`PCT_BRIDGE_AGENT_VERSION`, default
  `"0.0.0"` — the packaging stamps the real `.deb` version).
- `bridge/bridge.ts` passes `agentVersion` + `BRIDGE_CAPABILITIES` and a default
  `onRefuse` that logs the update-required condition.
- Update `ws-client.test.ts` / `bridge.test.ts` / `config.test.ts` for the new
  handshake-first flow; add refuse / timeout / re-handshake coverage.

## License boundary / tamper resistance

None touched — plain TypeScript + zod (`ws` MIT behind the injected factory).
No GPL linkage; no packaging/image change. Not a hardening feature.

## Deferred

- Populating `PCT_BRIDGE_AGENT_VERSION` from the real `.deb` version at install
  time is client-packaging work (#106).
