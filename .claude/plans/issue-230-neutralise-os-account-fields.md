# Issue #230 — Neutralise the user↔OS-account mapping field names

**Decision (recorded by maintainer, 2026-06-21): Option 1** — full rename
`linux_username`/`linux_uid` → `os_username` + `os_user_ref`, with
`os_user_ref` becoming **TEXT/string** (a uid on Linux, a SID on Windows),
across schema, DTOs, the install-script enrol payload, and the frontend.

Source: `docs/windows-client-support.md` → "Modularity tweaks to make
cheaply now" (item 2). Cheap now (all consumers first-party, no fleet/enrol
data exists); a breaking-contract change once the PWA / calendar integrator
bind to the `/api/*` field names.

## Why `os_user_ref` is TEXT (not INTEGER)

A Windows account ref is a **SID string** (`S-1-5-21-…`), not a uid. For the
published `/api/*` field to be stable across Linux and Windows it must be a
string. On Linux it carries the numeric uid as a decimal string ("1001").
The current `UNIQUE(client_id, linux_uid)` index is recast to
`UNIQUE(client_id, os_user_ref)`.

Transport safety: the only transport consumers of the link
(`transport/timekpr/client.ts`, `transport/policy-push/executor.ts`) use the
**username** for `timekpra --username`; nothing on `main` consumes the uid as
a number, so the INTEGER→TEXT change is low-risk. (e2guardian/AppArmor
iptables `--uid-owner` consumers live only in open PRs #217/#241, not on
`main`; they will parse `os_user_ref` to an int on the Linux path when they
land.)

## Footprint (verified on `main`)

Server:
- `policy/schema.ts` — `usersOnClients.{linuxUsername→osUsername, linuxUid→osUserRef}`
  (TEXT), index rename, `enrolmentTokens.supervisedUsers` JSON `$type`.
- new timestamp-prefixed migration (table-recreate; hand-fix the
  `INSERT … SELECT` to copy `linux_username→os_username`, `linux_uid→os_user_ref`).
- `policy/repository.ts` — `LinkUpsert`, `upsertLink`.
- `policy/enrolment.ts` — `SupervisedUserMapping`, `EnrolLink`, joins.
- `api/clients/dtos.ts` — `osUsernameSchema`/`osUserRefSchema`, mint + enrol DTOs.
- `api/clients/service.ts` — `EnrolServiceResult`, join logic, error text.
- `api/policy/dtos.ts` — `upsertLinkSchema`, `linkResponseSchema`, `toLinkResponse`.
- `api/policy/routes.ts` — link PUT body usage + conflict message + push detail.
- `transport/stub.ts` / `transport/timekpr` / `executor` — comments + push detail keys.

Tests (server): `policy/schema.test.ts`, `policy/repository.test.ts`,
`policy/db.test.ts`, `policy/enrolment.test.ts`, `api/policy.test.ts`,
`api/clients-enrolment.test.ts`, `api/policy-push-stub.test.ts`,
`api/clients/versions.test.ts`, `transport/stub.test.ts`,
`transport/policy-push/{executor,bootstrap}.test.ts`, migrations test.

Client + frontend + docs:
- `client/install-client.sh` enrol-body builder (emit `osUserRef` as a quoted
  string) + comments; `client/tests/install-client.bats` expectations.
- `frontend/src/lib/api/links.ts`, `views/LinksView.svelte` (uid input →
  text bound to `osUserRef` string), `views/ClientHealthView.svelte` (mint
  rows use `osUsername`); `frontend/tests/api/{clients,links}.test.ts`.
- `docs/architecture.md`, `docs/windows-client-support.md`.

## New validation

- `osUsernameSchema = z.string().trim().min(1).max(32)` (unchanged from the
  Linux username bound).
- `osUserRefSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9:_.-]+$/)`
  — covers a Linux uid and a Windows SID, and (like `versionStringSchema`)
  forbids `"`/`\`/control chars so the install script's hand-rolled JSON
  encoder stays safe.

## Phases

1. **Server rename** (schema + migration + repo + enrolment + api + stub +
   all server tests). The whole server tree compiles/tests as one unit.
   Gate: `format`/`lint`/`typecheck`/`test` + `db:check`.
2. **Install script + bats** — enrol payload + comments + bats expectations;
   `shellcheck`.
3. **Frontend + docs** — links API/views + frontend tests + `npm run build`;
   architecture/windows docs.

## License boundary

N/A — plain TypeScript + zod + Drizzle + a bash payload string. No GPL
linkage, no transport/REST boundary collapsed, no Docker-image change,
no new dependency. Tamper-resistance ceiling untouched.
