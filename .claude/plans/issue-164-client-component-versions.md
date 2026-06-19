# Plan — #164 Record client component versions at enrolment

Phase 3. Builds on `Client` schema (Phase 2) + enrol endpoint (#77).
Heartbeat refresh is **out of scope** (→ Phase 8b, #165/#101).

## Goal

Make the dashboard aware of what version each enrolled client runs, captured
at enrolment time. "Reserve cheaply, migrate never" — nullable columns + an
optional DTO extension so a client that doesn't report versions still enrols.

## Phase A — server contract + persistence

1. **Schema** (`server/src/policy/schema.ts`): add to `clients`:
   - `agentVersion: text("agent_version")` (nullable) — the `pct-client` `.deb` version.
   - `componentVersions: text("component_versions", { mode: "json" }).$type<ComponentVersions>()` (nullable)
     — `{ timekpr?, e2guardian?, activitywatch? }`.
   - `versionsReportedAt: integer("versions_reported_at", { mode: "timestamp" })` (nullable).
2. **Migration**: `npm run db:generate` (timestamp-prefixed, never hand-numbered).
3. **DTO** (`server/src/api/clients/dtos.ts`): a shared `componentVersionsSchema`
   (object of optional version strings, `.strict()`) + a `versionStringSchema`
   (`trim().min(1).max(64).regex(/^[A-Za-z0-9._+~:-]+$/)` — Debian-version charset,
   no `"`/`\`/control chars). Extend `enrolClientSchema` with optional
   `agentVersion` + `componentVersions`. Echo recorded values back in
   `enrolResponseSchema` so the install script can confirm what was stored.
4. **Repository** (`server/src/policy/enrolment.ts`): extend `EnrolWrite` with
   optional `agentVersion` / `componentVersions` / `versionsReportedAt`; persist
   on the `clients` insert.
5. **Service** (`server/src/api/clients/service.ts`): thread the DTO version
   fields into `EnrolWrite`; set `versionsReportedAt = new Date()` iff any
   version was reported (else all three stay null).
6. **Tests**: DTO validation (valid, bad charset, too long, unknown component
   key rejected), repository persistence + null default, service "reports →
   stored + timestamp set / absent → null", route test (enrol-with-versions
   round-trip through `app.inject()`).

## Phase B — client reporting

7. **`client/install-client.sh`**: detect agent version (`dpkg-query` on the
   agent package, overridable `PCT_AGENT_VERSION` / `PCT_DPKG_QUERY`) and tool
   versions (`timekpra`, e2guardian, `aw-server` — each via an overridable
   command, sanitised to the version charset), add `agentVersion` +
   `componentVersions` to the enrol JSON body. Omit any field that couldn't be
   detected (no empty strings). Dry-run prints the augmented body.
8. **bats tests** (`client/tests/install-client.bats`): body includes detected
   versions, omits undetected ones, sanitises odd output.

## License boundary

N/A — `timekpr`/`e2guardian`/`aw-server` are only invoked as subprocesses to
read `--version` (no linkage, no vendoring); ActivityWatch is not touched over
its API here. No GPL binary added to any image. No new dependency.

## Deferred (tracked)

- Heartbeat refresh of `agent_version` / `versions_reported_at` on the Phase-8b
  event stream → #165 / #101 (already filed; note in PR).
- Surfacing version drift / acting on it → Phase 14 (#163, #174).
