# Plan — #400 Admin Clients view: surface per-client supported capabilities

Roadmap: Phase 8b. Follow-up to **#288** (which landed the live per-connection
capability gate in the `EventHub`). ADR:
`docs/adr/0007-event-stream-version-compatibility.md` §4;
`docs/windows-client-support.md` → "Modularity tweaks".

## Problem

The event-stream handshake (#165) negotiates each client's advertised
`capabilities`, and #288 wired the `EventHub` to withhold a gated frame from a
connection that didn't advertise the matching capability. But the negotiated
set lives only for the life of the socket — `stream.ts` records
`recordClientAgentVersion` on `accept` and **discards** `hello.capabilities`.
Nothing persists them, nothing exposes them, and the admin has no way to see
which enforcement primitives a given client supports.

`docs/windows-client-support.md` frames this as the modularity seam: a Linux
client and a future Windows client speak the same `eventProtocol` and differ
only in advertised `capabilities`. Surfacing the per-client set — and greying
out controls a client can't honour — is what lets the admin UI stay honest
across heterogeneous clients without per-platform branching.

## Scope (this PR — the full persist → expose → surface vertical)

1. **Capability catalogue** — `server/src/events/capabilities.ts`:
   `CLIENT_CAPABILITY_CATALOG`, an ordered readonly list of
   `{ capability, label, description }` over the known `CLIENT_CAPABILITIES`
   vocabulary. The server owns the UI-facing labels (same "server classifies,
   frontend renders" pattern as `version-status.ts`), so the vocabulary is
   single-sourced and a future Windows client's greyed controls come straight
   from the catalogue. A unit test pins the catalogue to cover every
   `CLIENT_CAPABILITIES` value.

2. **Persist** — a nullable `capabilities` JSON column on `clients`
   (`schema.ts`), written at handshake `accept` alongside the existing
   `recordClientAgentVersion` call. `null` = the client has never completed an
   event-stream handshake; `[]` = handshaked advertising nothing (an older
   client). Migration via `npm run db:generate` (timestamp-prefixed, #133).
   `repository.ts` gains `recordClientCapabilities(db, id, capabilities)` —
   system-observed, written directly like `recordClientAgentVersion` /
   `setClientUpdateRequired`, de-duplicating the advertised set.

3. **Expose** — the Clients/health DTO (`api/clients/health-dtos.ts`) gains:
   - `capabilitiesReported: boolean` — has the client ever advertised a set
     (i.e. completed a handshake)?
   - `capabilities: ClientCapabilityDto[]` — the full known catalogue, each
     entry `{ capability, label, supported }`, `supported` = the client
     advertised it.

   `health-service.ts` `assemble` builds the matrix from `client.capabilities`
   against the catalogue. Re-export the catalogue + DTO type from
   `api/index.ts` (part of the `/api` contract).

4. **Surface** — `ClientsView.svelte` gains a "Capabilities" section per card
   (mirroring "Components"): each catalogue entry rendered as a chip labelled
   from the DTO, **greyed / `aria-disabled` when unsupported**. A client that
   hasn't handshaked (`!capabilitiesReported`) shows a muted "not reported yet"
   empty state rather than a wall of greyed chips. This is the Windows-seam
   surface: the chips are the per-client controls, and an unsupported one is
   visibly inert.

## Out of scope (no such controls exist yet)

The admin Clients view has no actionable per-client enforcement controls today
(force-close / session-lock are client-side agent actions). "Grey out
unsupported controls" is delivered as the capability matrix above — the seam
that future actionable controls hang off. When such a control lands, it reads
`h.capabilities` to decide enabled/greyed. No new control is invented here.

## Tests

- `tests/events/capabilities.test.ts` — catalogue covers every
  `CLIENT_CAPABILITIES` value; labels/descriptions non-empty; order stable.
- `tests/policy/repository.test.ts` (client area) — `recordClientCapabilities`
  writes + de-dups; default `null`; no-op on unknown id.
- `tests/events/stream.test.ts` — on `accept`, the advertised capabilities are
  persisted on the client row (end-to-end through the route).
- `tests/api/clients/health-dtos.test.ts` — schema round-trips the new fields.
- `tests/api/clients/health-service.test.ts` — matrix: advertised → supported,
  absent → unsupported; never-handshaked → `capabilitiesReported: false` and
  all `supported: false`.
- `frontend/tests/components/clients-view-capabilities.test.ts` — supported
  chip enabled, unsupported chip greyed, "not reported" empty state.

## License boundary

None touched — pure TypeScript (Drizzle over the policy store, zod DTO, Fastify,
Svelte). No GPL linkage, no subprocess/REST boundary, no image change.

## No new dependencies

Uses `drizzle-orm`, `zod`, Svelte, and Node built-ins already in the tree.

## Phasing

- **Phase 1 — persistence:** catalogue + schema column + migration + repository
  + stream wiring + backend persistence tests. First push → draft PR.
- **Phase 2 — API surface:** health DTO + service matrix + `api/index` re-export
  + API tests.
- **Phase 3 — admin surface:** contract re-export + `ClientsView` capabilities
  section + frontend test + frontend build. Then finalize (ready-for-review).
