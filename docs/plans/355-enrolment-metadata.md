# Plan — #355: enrolment metadata (friendly name + client addressing capture)

Issue: [#355](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/355)
Roadmap: post-enrol client-identity refinement (composes with the closed
Clients-view consolidation #305 and the connectivity-verification work).

## Scope of this run

A reviewable slice that **captures** client identity + addressing and surfaces
it to the admin, without changing how the SSH transport picks its target.

1. **Report addresses at enrol.**
   - `install-client.sh` gathers the machine's primary IPv4/IPv6 address(es)
     and includes them in the enrol body as `reportedIps` (kept inside the
     constrained-token JSON-escaping posture of `pct_orch_build_enrol_body`; an
     IP literal is inherently safe against the hand-rolled encoder).
   - The server records both the **self-reported IPs** and the **observed
     source IP** of the enrol request. Source IP is `request.ip`, which is
     already XFF-aware exactly when `settings.trustProxy` is on (default off →
     the direct socket peer), so the reverse-proxy concern is handled by the
     existing documented posture (#235) rather than a new header parse.
2. **Friendly name end-to-end.**
   - New nullable `clients.friendly_name` (admin-editable) and a nullable
     `friendly_name` on the enrol token.
   - The enrol-token mint form's "Expected hostname (optional)" input is
     reframed as "Friendly name (optional)", bound to the new token
     `friendlyName`; carried through the token → applied to the client row at
     claim time. The API keeps the optional token `hostname` (expected
     hostname, informational) for backward-compatibility.
   - Client cards title on the friendly name, with hostname + last-known IP(s)
     as secondary detail; the admin can edit the friendly name afterwards via
     the existing `PATCH /api/clients/:id`.

## Deferred (tracked, not in this run)

- **Explicit per-client SSH-target override** (acceptance item 3): let the admin
  pin the transport to a recorded/typed IP instead of the hostname. Most
  transport-sensitive sub-piece; stands alone cleanly. A focused follow-up issue
  will be filed and linked from the PR.

## Data model (schema + one timestamp-prefixed migration)

- `clients`:
  - `friendly_name TEXT` (nullable) — admin-chosen label.
  - `reported_ips TEXT` (JSON `string[]`, nullable) — self-reported at enrol.
  - `source_ip TEXT` (nullable) — observed source IP of the enrol request.
- `enrolment_tokens`:
  - `friendly_name TEXT` (nullable) — label set at mint, applied at claim.

Generated with `npm run db:generate` (timestamp prefix, per CLAUDE.md #133).

## Contract changes (`server/src/api`)

- `enrolClientSchema`: `+ reportedIps?: string[]` (bounded array; each a
  strict IP-charset string so it can never carry a `"`/`\`/control char).
- `mintEnrolmentTokenSchema`: `+ friendlyName?: string`.
- `clientHealthSchema` (Clients-page DTO): `+ friendlyName`, `+ reportedIps`,
  `+ sourceIp` (all nullable) so the card renders identity + addressing.
- `clientResponseSchema` (CRUD DTO): `+ friendlyName` (nullable, editable),
  `+ reportedIps`, `+ sourceIp` (read-only).
- `updateClientSchema`: `+ friendlyName?` so the admin can rename post-enrol.

## Phasing

1. **Data model + enrol capture** — schema + migration; `reportedIps` on the
   enrol DTO; `request.ip` capture in the enrol route; service + repo write of
   `friendlyName`/`reportedIps`/`sourceIp`; `friendlyName` on the mint DTO/token.
   Unit tests. → first push opens the draft PR.
2. **Read surfaces** — `clientHealthSchema`/`assemble`; `clientResponseSchema`/
   `updateClientSchema`/`ClientUpdate` (editable `friendlyName`);
   `toClientResponse`. Unit tests.
3. **install-client.sh + bats** — IP gathering + enrol-body field; bats coverage.
4. **Frontend** — `ClientsView` token-form relabel, card identity/addressing
   surfacing, edit friendly name. Frontend build + component tests.

## License boundary

None touched. SSH target selection is unchanged in this slice; `timekpra` and
Ansible remain subprocess-only; no GPL linkage, no image change, no new deps.
