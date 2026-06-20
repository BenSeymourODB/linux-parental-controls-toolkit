# Issue #85 — Audit log of every transport command issued + admin audit view

Roadmap: `docs/roadmap.md` → Phase 4 ("Audit log of every command issued").

## Goal

Record an immutable, append-only audit entry for **every command the dashboard
issues to a client** over the SSH transport (timekpra now; Ansible/enforcement
later), and expose it on the `/api/*` contract for the admin view to read.

Architecture constraints honoured:

- Audit timestamps are **UTC** (`docs/architecture.md` → "Timezones and budget
  rollover": "audit entries" stored in UTC).
- Append-only — never UPDATEd in place (mirrors the Grant ledger's immutability
  posture, but this records *commands issued to clients*, not grants).
- License boundary unchanged: the audit layer is pure TypeScript over the
  existing SSH **subprocess** boundary; it links no GPL code and adds no GPL
  binary.

## Design — automatic, not per-call boilerplate

Auditing hooks the **SSH transport facade** via a decorator that implements the
same structural surface (`exec` / `execChecked` / `execAndParse`) the
`TimekprClient` already consumes (`TimekprTransport`). Wrapping the shared
`SshTransport` at bootstrap turns auditing on for every command with no change
to call sites — the same composable, un-wired-until-bootstrap pattern the other
Phase-4 transport pieces shipped with (#83/#84/#86).

`clientId` / `userId` / `actor` / `reason` are supplied as **context**:
`AuditingTransport.withContext({...})` returns a context-bound view sharing the
inner transport + sink, so a per-client/per-user `TimekprClient` records who/what
it acted on. Un-attributed internal commands default `actor = "system"`.

## Phases

### Phase A — storage + recorder (data half)

- `policy/enums.ts`: add `auditOutcomeValues` (`ok | failed | unreachable |
  timeout | parse_error`) + zod enum (single source of truth, like the others).
- `policy/schema.ts`: `audit_log` table — `at` (UTC, default now), target
  host/port/user recorded verbatim (entry stands alone after client deletion),
  nullable `client_id`/`user_id` FKs (`ON DELETE SET NULL` to preserve history),
  `actor` (default `system`), `reason`, `command` (JSON string[] — redacted
  argv), `outcome` (CHECK from the enum), `exit_code`, `signal`, `duration_ms`
  (CHECK `>= 0`), `error_message`. Indexes on `(at)` and `(client_id, at)`.
- `npm run db:generate` → committed timestamp-prefixed migration + snapshot.
- `transport/audit/recorder.ts`: `AuditContext`, `AuditEntry`, `AuditSink`
  (contract: `record` MUST NOT throw), `redactArgv` (defensive secret masking).
- `transport/audit/sink.ts`: `DrizzleAuditSink` — synchronous insert, swallows +
  logs any DB error so auditing can never break a command.
- `transport/audit/repository.ts`: `listAuditEntries` — newest-first
  (id-descending), filter by `clientId`/`outcome`, `before` id cursor, `limit`.

### Phase B — auditing transport decorator

- `transport/audit/transport.ts`: `AuditingTransport implements
  AuditableTransport` wrapping an inner transport; times each call, classifies
  the outcome from the SSH error taxonomy, records, and returns/re-throws
  unchanged. `withContext` for attribution.

### Phase C — read API

- `api/audit/dtos.ts`: query DTO (coerced `clientId`/`before`/`limit`≤200,
  `outcome` enum), response DTO (ISO `at`), `toAuditResponse`.
- `api/audit/routes.ts`: `GET /api/audit` behind `requireAdmin`, returns
  `{ entries, nextCursor }`.
- Wire into `api/plugin.ts`; re-export DTO types from `api/index.ts`.

## Tests (Vitest, `server/tests/` mirroring source)

- `transport/audit/recorder.test.ts` — redaction forms; `DrizzleAuditSink`
  round-trip + defaults + error-swallow.
- `transport/audit/transport.test.ts` — ok/failed/unreachable/timeout/parse_error
  classification, exit-code/signal capture, exec-unchecked code branch,
  re-throw, `withContext` merge, port-default, argv redaction, duration ≥ 0.
- `transport/audit/repository.test.ts` — ordering, filters, cursor, limit.
- `api/audit.test.ts` — 401 guard, happy path, filters, limit+nextCursor, 400s.

## Deferred (tracked follow-up)

The read-only **`/admin` audit view** depends on the `/admin/*` shell (#53, in
flight via #51/PR #160). The API contract it consumes lands here; the Svelte UI
is a separate issue (filed + linked from the PR). Tamper-reversion (#93) and
enforcement force-close (#99) entries land with their own phases against this
same table/sink.
