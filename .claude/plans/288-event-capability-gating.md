# Plan — #288 Event stream: capability-based frame gating (ADR 0007 §4)

Roadmap: Phase 8b. Follow-up to #165 (event-stream version handshake).
ADR: `docs/adr/0007-event-stream-version-compatibility.md` §4.

## Problem

The `/api/events/stream` handshake (#165) already negotiates a client's
`capabilities` set (`events/protocol.ts` → `helloFrameSchema.capabilities`),
but nothing gates outbound frames on it. On `accept`, `stream.ts` calls
`hub.register(clientId, socket)` and **discards** the advertised capabilities;
the `EventHub` fan-out (`publishToClient` / `broadcast`) sends every frame to
every open connection regardless of what the client can honour.

ADR 0007 §4: *"The server only sends a frame type a client advertised support
for; an older client simply never receives a frame it couldn't handle, and is
**not** refused for it."* The `enforce.*` producers already exist (#99), so the
gate is now implementable and testable end-to-end.

## Scope (this PR — the backend correctness core)

1. **Capability vocabulary + frame→capability map** — new
   `server/src/events/capabilities.ts`:
   - `CLIENT_CAPABILITIES` constants: `per_app_close`, `session_budget`
     (the ADR §4 examples with frame producers today; `applocker_deny` /
     `dns_filter` are forward-looking and add trivially when their frames land).
   - `capabilityForEvent(event): ClientCapability | null` — a **pure,
     exhaustive** switch over `ServerEventType`. A new frame type fails to
     compile until its gate is declared (`assertNever`). Mapping:
     | event | required capability |
     | --- | --- |
     | `enforce.force_close` | `per_app_close` |
     | `enforce.session_lock` | `session_budget` |
     | `lockout.cleared` | `session_budget` |
     | `grant.applied` | — (baseline, ungated) |
     | `policy.changed` | — (baseline, ungated) |

     `lockout.cleared` gates on `session_budget`: it only clears an
     overall-budget lockout, which can only happen on a client doing
     session-budget enforcement (matches this issue's `enforce.*`/`lockout.*`
     wording). `grant.applied` / `policy.changed` are informational nudges every
     client re-renders, so they stay ungated.

2. **Hub gating** — `server/src/events/hub.ts`:
   - Store each connection's advertised capabilities alongside the socket
     (`Map<EventSocket, ReadonlySet<string>>` per client).
   - `register(clientId, socket, capabilities = [])` records them; default `[]`
     = advertises nothing = receives only ungated frames (the correct default
     for an older client).
   - `publishToClient` / `broadcast` withhold a gated frame from any connection
     whose advertised set lacks the required capability. `delivered` counts only
     sockets actually written to.

3. **Thread the negotiated capabilities** — `server/src/events/stream.ts`:
   on `accept`, pass `hello.capabilities` into `hub.register`.

4. **Barrels** — export the new surface from `events/index.ts`; re-export the
   capability vocabulary + type from `api/index.ts` (part of the
   `/api/events/stream` contract the bridge consumes).

## Deferred (tracked follow-up, not this PR)

- **Surface per-client capabilities in the admin Clients view** (grey out
  unsupported controls — the Windows-client modularity seam,
  `docs/windows-client-support.md`). That's a schema-persistence + DTO +
  frontend slice; adding an unused `Client.capabilities` column here would be
  dead code until the UI consumes it. File a focused follow-up and link it from
  the PR. The live per-connection gate (this PR) is the load-bearing
  correctness deliverable; the admin surface is a UX nicety on top.

## Tests

- New `tests/events/capabilities.test.ts` — `capabilityForEvent` mapping +
  constant values.
- `tests/events/hub.test.ts` — existing fan-out/stamping tests use
  `lockout.cleared` (now gated), so their fakes register advertising
  `session_budget` (faithful adaptation, not a weakening); **add** a
  `capability gating` describe: withheld without the cap, delivered with it,
  ungated frames reach everyone, mixed connections filtered, `delivered` count,
  broadcast gating, distinct capabilities don't cross-authorise.
- `tests/events/stream.test.ts` — add an end-to-end assertion that a client
  advertising only `session_budget` receives `enforce.session_lock` but not
  `enforce.force_close` (verifies the register-threading through the route).

## License boundary

None touched — pure TypeScript event-hub logic + Fastify/`@fastify/websocket`
(MIT). No GPL linkage, no image change.
