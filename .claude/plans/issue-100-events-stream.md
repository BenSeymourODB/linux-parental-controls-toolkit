# Issue #100 — events module: `GET /api/events/stream` WebSocket

Roadmap: `docs/roadmap.md` → Phase 8b (first bullet, "build it first").
Design: `docs/client-notifications.md` → "Event channel".

## Goal

The server-to-client WebSocket event channel the `pct-client-bridge`
connects to. Per-client bearer-token auth (the enrolment token, #77),
a typed event taxonomy, and a per-client fan-out registry that the later
event *producers* (#99 enforcement, #108 lockout, Phase-10 grants) publish
onto. This PR ships the **channel + publish API**, not the producers and
not the client-side consumer (#101).

## Scope (this PR)

1. **Event taxonomy** (`events/taxonomy.ts`) — zod schemas + inferred types
   for the five documented events (`grant.applied`, `policy.changed`,
   `enforce.force_close`, `enforce.session_lock`, `lockout.cleared`) as a
   discriminated union on `type`, plus the wire **frame** envelope
   `{ seq, at, event }`. Payloads are minimal/forward-compatible v1 shapes
   grounded in `client-notifications.md`; producers fill them in per phase,
   guarded by the `/api/meta` `apiVersion` handshake (#165).
2. **Fan-out hub** (`events/hub.ts`) — `EventHub`: register/unregister a
   socket under its `clientId`, `publishToClient`, `broadcast`, liveness +
   counts. Decoupled from `ws` via a minimal `EventSocket` interface so it
   unit-tests with fakes. Stamps a monotonic `seq` + `at` per published event.
3. **Heartbeat** (`events/heartbeat.ts`) — `startHeartbeat(socket, ms)`:
   ping/pong keepalive that `terminate()`s a peer that missed the last ping.
   Pure timer logic over a minimal socket interface (fake-timer tested).
4. **Auth** (`events/auth.ts`) — `authenticateEventClient(db, header)`:
   `Authorization: Bearer <token>` → SHA-256 hash lookup against
   `clients.bearer_token_hash` → `ClientRow`, or `ApiError(401)`. Reuses
   `parseBearer` + `hashToken`.
5. **Route** (`events/stream.ts`) — registers `@fastify/websocket` (already a
   dep) in an encapsulated child scope and mounts `GET /events/stream` (→
   `/api/events/stream`). A `preHandler` authenticates before the upgrade
   (failure ⇒ 401 envelope, no upgrade). On open: register in the hub, touch
   `last_seen`, start heartbeat; on close/error: stop heartbeat, unregister,
   touch `last_seen`. Decorates `app.eventHub` so producers can publish.
6. **Repository** — `findClientByBearerTokenHash` + `touchClientLastSeen` in
   `policy/repository.ts`.
7. **Wiring** — `buildApp` creates the hub + `app.decorate("eventHub", …)`;
   `registerApi`/`apiPlugin` thread it into `registerEventStream`. Taxonomy
   schemas/types re-exported from the `api/` barrel (the contract the bridge
   consumes).
8. **Dep** — add `@types/ws` (devDependency only): `@fastify/websocket`'s
   types `import * as WebSocket from 'ws'`, which ships no bundled types, so
   `tsc --noEmit` needs them; `ws` itself is already present transitively and
   is the client used by the route's end-to-end test (and later by #101).

## Reconnect semantics

Connections are stateless and client-initiated; on reconnect the bridge
re-authenticates and re-registers. No server-side event buffering/resume in
this PR — missed *policy/grant* state is reconciled over the SSH transport
(#84), not replayed on the event stream. The server-side heartbeat detects
half-open sockets; client-side backoff/reconnect is #101.

## Tests (`tests/events/`)

- `taxonomy.test.ts` — each event parses valid / rejects invalid; frame
  envelope; discriminated-union rejection of unknown `type`.
- `hub.test.ts` — register/unregister, per-client fan-out isolation,
  skip non-open sockets, broadcast, liveness + counts, seq monotonicity.
- `heartbeat.test.ts` — ping on each tick, `terminate` after a missed pong,
  `onPong` keeps alive, `stop` clears the timer (fake timers).
- `auth.test.ts` — missing/malformed/unknown token ⇒ 401; valid ⇒ ClientRow.
- `stream.test.ts` — real `app.listen({port:0})` + `ws` client: reject
  no/invalid token (401 unexpected-response); valid token connects, a
  `publishToClient` frame is received, `last_seen` is set, hub tracks the
  connection, and close unregisters it.
- `policy/repository.test.ts` — the two new client functions.

## License boundary

None touched — Fastify + `@fastify/websocket` (MIT) + zod + Drizzle. No GPL
linkage, no subprocess/REST boundary, no Docker-image change.
