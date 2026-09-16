# Plan — #369 per-(client, user) ActivityWatch health axis

Implementation plan for
[#369](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/369),
grounded in **ADR 0016** (`docs/adr/0016-per-user-activitywatch-server-ports.md`),
which settles the per-supervised-user `aw-server` port convention #369 depends
on. Do not start the health-axis code until ADR 0016 is Accepted (the port
scheme is its hard prerequisite — see the issue's retraction note).

## Why this is staged

#369's health-axis change is one consumer of a **systemic** multi-user gap:
the client install binds every supervised user's `aw-server` to `:5600`, so
there is no distinct port to probe/pull per user (ADR 0016 → Context). The
foundation (per-user ports, provisioned client-side and recorded server-side)
must land first and is shared with the telemetry pull; the health axis and the
telemetry pull then build on it independently. Hence three tracked units:

1. **Foundation — per-user port allocation + client provisioning** (new issue,
   the enabling step for both consumers).
2. **Telemetry pull — per-user** (new issue; a distinct systemic gap #369 does
   not cover).
3. **Health axis — per-user** (#369 itself, this plan's deliverable).

## Phase 1 — Foundation (blocks 2 and 3)

- Drizzle migration: add non-null `aw_server_port` to `usersOnClients`
  (`npm run db:generate`; timestamp-prefixed per #133). Default `5600` for the
  first/only link on a client; back-fill existing rows to `5600`.
- Allocation: on link create (enrol #77 / admin link), allocate the lowest free
  port in `[AW_SERVER_PORT_BASE, BASE + WINDOW)` (base `5600`, window ~32) not
  already taken by another `UserOnClient` on the same client; persist it.
- Enrol-response DTO (zod) gains each supervised user's `aw_server_port`.
- `client/install-baseline-tools.sh`: `pct_baseline_configure_activitywatch`
  binds each user's `config.toml` + `aw-server` unit to that user's allocated
  port instead of the fixed `AW_PORT`. Keep the dry-run plan clean; extend the
  bats coverage (single-user ⇒ 5600 unchanged; two users ⇒ 5600/5601).
- **Coordinate with #432** (restart per-user AW units on upgrade) and the
  clients/enrol PRs in flight (#418/#429/#413) to avoid migration/enrol churn —
  sequence after they settle.

## Phase 2 — Telemetry pull per-user (separate issue)

- `transport/activitywatch/telemetry.ts`: iterate the client's `UserOnClient`
  rows, forwarding to each user's `aw_server_port`; attribute samples per user.
- Update the enforcement telemetry consumer's `:5600` note once resolved.

## Phase 3 — Health axis per-user (#369)

- Extend the component-health shape (`transport/health/components.ts` +
  `api/clients` health DTO) with an **optional** per-(client, user) breakdown
  for the per-user components (`activitywatch` now; `pct-client-agent` #103
  reuses the axis). Keep the top-level per-component verdict as a worst-case
  roll-up so existing single-user consumers are unchanged.
- `SshClientProber`: enumerate the client's `UserOnClient` rows, probe each
  user's `aw-server` at its `aw_server_port` over the loopback forward
  (`GET /api/0/info`), roll up to a worst-case per-client status plus the
  per-user detail.
- Admin Clients view: surface the per-user breakdown under the `activitywatch`
  component.
- Tests: prober per-user enumeration + roll-up; DTO; the Clients-view
  component. Unit-level; the live round-trip stays gated behind the existing
  integration convention.

## Non-goals

- No change to the tamper-resistance posture (ordinary multi-user service
  config only).
- No license-boundary change (REST-over-loopback-tunnel only).
