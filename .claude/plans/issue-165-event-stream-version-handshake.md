# Issue #165 — Event-stream version handshake + N-1 compatibility window

Roadmap: `docs/roadmap.md` → Phase 8b. ADR: `docs/adr/0007-event-stream-version-compatibility.md` (Accepted; this PR implements its §7 target). Underpins the Phase-14 fleet-update epic (#163).

## Goal

Make "upgrade the server first, roll the clients afterwards" safe: the
`pct-client-bridge` ↔ `GET /api/events/stream` connection negotiates a protocol
version at connect time, and the server degrades to the N-1 dialect or refuses
cleanly (flagging the client) when it can't. The bridge (#101) isn't built yet,
so this is the **server side**, exercised end-to-end by simulating a client
`hello` in tests. Adding a mandatory `hello` is safe because no bridge is
deployed.

## Design (fixed by ADR 0007 — no open decisions)

- Two integer version axes, same "additive doesn't bump, breaking does" rule:
  `apiVersion` (existing, `/api/meta`) and a **new** `eventProtocol` (§1).
- Handshake (§2): client→server `hello { agentVersion, eventProtocol,
  capabilities }`; server→client exactly one of `accept { eventProtocol,
  apiVersion }` or `refuse { error: { code: "incompatible_protocol", … } }`
  (reusing the `/api/*` error-envelope vocabulary) then close.
- N-1 window keyed on the integer (§3): accept `P` (full dialect) or `P−1`
  (N-1 dialect); refuse `< P−1` (too old → `update_required`) and `> P`
  (server behind client). Missing/unparseable `hello` → refuse.
- `capabilities` are accepted + recorded but **frame-gating is deferred** (§4):
  there are no `enforce.*`/`lockout.*` producers to gate yet (#99/#108), so
  gating lands with them — tracked as a follow-up.
- `update_required` (§5) is a persisted flag on `Client`, surfaced in the
  existing Clients health view (#81). A flag + signal only; remediation is
  Phase 14.
- `hello.agentVersion` refreshes `agent_version` + `versions_reported_at` on
  every connect — the #165/#101 heartbeat (§ Consequences).

## Phases

1. **Pure protocol module + schemas + `/api/meta`.** `events/protocol.ts`:
   `EVENT_PROTOCOL` constant + total `negotiate(hello) → accept | refuse`
   (zero-I/O, window logic). zod `hello`/`accept`/`refuse` frame schemas with
   inferred types (shared with the future bridge). `/api/meta` gains
   `eventProtocol`. Unit tests for every window branch + the meta field.
2. **Handshake wiring into the stream + version heartbeat.** Rewrite
   `events/stream.ts` so the first frame is the `hello`: validate → `negotiate`
   → on accept, send the `accept` frame, register in the hub, refresh
   `agent_version`/`versions_reported_at`, start the heartbeat; on refuse, send
   the typed `refuse` frame, flag the client, close. Add a hello timeout so a
   silent client can't hold a socket. New repo helper
   `recordClientAgentVersion`. Update the existing stream tests to perform the
   handshake; add refuse-path tests.
3. **`update_required` persistence + health surface.** drizzle migration adding
   `update_required` to `clients` (default false); repo setter; surface
   `updateRequired` on the Clients health DTO. Tests.

## Deferred (tracked → new follow-up issue)

- **Capability-based frame gating** (§4) — withholding `enforce.*` frames a
  client didn't advertise support for; lands with the frame producers (#99/#108)
  and the Windows-client primitives.

## License boundary

Unchanged — pure TypeScript + zod over the existing Fastify / `@fastify/websocket`
(MIT) stream and Drizzle. No GPL linkage, no subprocess/REST boundary, no image
change. `CLAUDE.md` → "License boundaries".
