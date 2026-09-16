# Plan — #406: explicit per-client SSH-target override

Issue: [#406](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/406)
Builds on: [#355](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/355)
(metadata capture — `reported_ips` / `source_ip` / `friendly_name`, already on `main`).
Composes with: post-enrol connectivity verification (#354).

## Problem

The SSH transport always targets a client's self-reported **bare hostname**
(`targetFromClient` in `server/src/transport/ssh/facade.ts`). When the
dashboard's bridge-network container can't resolve a LAN hostname, every push
to that client fails (a candidate cause of the v0.1.0-alpha.5 all-clients-
unreachable incident). #355 captured the addresses that would let an admin
work around this (`reportedIps`, `sourceIp`) but deliberately left the
transport unchanged. This issue lets an admin pin, per client, the host string
the transport connects to.

## Design

A single nullable per-client override column, resolved as
`ssh_target ?? hostname` everywhere the transport builds a target. Default
`null` ⇒ behaviour unchanged (hostname), so this is fully backward-compatible.

The resolution rule lives in **one** place — a `sshHostForClient()` helper in
the SSH facade — reused by `targetFromClient` (what the transport actually
connects to) and by the client DTO's `effectiveSshTarget` (what the admin UI
shows). This keeps display and enforcement in lockstep (the same discipline
#362 established for policy).

## Phases

### Phase 1 — schema + transport + API (server)

1. **Schema + migration.** Add nullable `ssh_target` (`text("ssh_target")`) to
   the `clients` table in `policy/schema.ts` with a doc comment. Generate the
   migration with `npm run db:generate` (timestamp-prefixed, per CLAUDE.md
   #133) — never hand-numbered.
2. **Repository.** Add `sshTarget?: string | null` to `ClientUpdate` so a PATCH
   can set it (a value) or clear it (`null`). Not added to `ClientCreate`: the
   override is a post-enrol admin action, and enrol/mint never set it.
3. **Facade.** Extract `sshHostForClient(client) = client.sshTarget ?? client.hostname`
   and use it in `targetFromClient`. Widen its parameter to
   `Pick<ClientRow, "hostname" | "sshUser"> & { sshTarget?: string | null }`
   (optional, so existing callers that pass a partial row still type-check).
   Update the one explicit-object caller (`enforcement/force-close-deps.ts`) to
   pass `sshTarget`.
4. **DTOs.** In `api/policy/dtos.ts`:
   - Add an `sshTargetSchema` — a trimmed, length-bounded string constrained to
     the hostname **and** IPv4/IPv6-literal charset (`[A-Za-z0-9.:%_-]`), so a
     stored value is safe to echo and is either a hostname or an IP literal
     (advisory-grade validation, matching `reportedIpSchema`'s posture — not a
     full RFC parse).
   - `updateClientSchema` gains `sshTarget: sshTargetSchema.nullable().optional()`
     (present ⇒ set; `null` ⇒ clear; absent ⇒ unchanged).
   - `clientResponseSchema` gains `sshTarget` (the override, nullable) and
     `effectiveSshTarget` (always a string) computed via `sshHostForClient`.
5. **Audit.** The existing PATCH handler already pushes a `client.updated`
   command carrying the request body, so an `ssh_target` change is audited by
   the same path as every other client edit — no new mechanism.

Tests: facade override resolution; PATCH set/clear round-trip + charset
rejection; `effectiveSshTarget` in the response.

### Phase 2 — admin UI (frontend)

An "SSH target" row on each client card in `ClientsView.svelte`:
- Read mode: show `effectiveSshTarget`, with a subtle "override" marker when
  `sshTarget` is set (else "hostname").
- Edit mode: a free-text input bound to the override, one-click candidate
  buttons for each `reportedIps` entry and `sourceIp`, and a "Use hostname"
  clear affordance (sends `sshTarget: null`).

Frontend types flow automatically — `contract.ts` re-exports the inferred DTO
types, so no parallel declaration. Build with `npm ci && npm run build`.

### Phase 3 — docs

Document the override and its default/fallback behaviour in
`docs/server-deployment.md` (the connectivity/troubleshooting area), noting it
as the fix for the unresolvable-LAN-hostname failure class and its interplay
with the post-enrol connectivity check (#354).

## Out of scope (unchanged from the issue)

- Pushing date-specific/exception overrides — unrelated.
- The post-enrol connectivity self-test (#354) itself; this only makes the
  target it should verify against selectable.

## License boundary

None touched. The SSH facade still invokes `timekpra` as a subprocess over SSH;
this only changes which host string it connects to.
