# Issue #94 — AdGuard Home REST client (`transport/adguard/`)

Roadmap: `docs/roadmap.md` → Phase 7. Design: `docs/server-deployment.md` →
"AdGuard Home deployment modes" / "What the dashboard expects from an external
instance". License: REST-only, `docs/licensing-analysis.md`.

## Goal

A typed, REST-only client for the AdGuard Home `/control/*` API covering the
operations the dashboard needs — **status**, **clients** (list/add/update/
delete), and **filtering user-rules** (get/set) — with zod-validated responses
and a typed error taxonomy. Used identically by both `managed` and `external`
modes (the mode plumbing is #95, the managed supervisor #96, the UI #97).

## Hard constraints

- **License boundary:** pure TypeScript over HTTP. No AdGuard source linked, no
  GPL binary added to any image. (`CLAUDE.md` rule 4.)
- **Confine writes to a `pct:`-prefixed client namespace.** Every client write
  (`addClient`/`updateClient`/`deleteClient`) requires a `pct:`-prefixed name
  and throws `AdGuardScopeError` *before* issuing a request otherwise, so the
  dashboard can never clobber a household's own AdGuard clients. The prefix is
  configurable (default `pct:`). `listManagedClients()` filters to the prefix.
- **Strict TS**, no `any`/unchecked `as`, validate every response with zod.
- **No new dependency** — `undici`'s `fetch`/`MockAgent` and `zod` are already
  in the tree; mirror the ActivityWatch client.

## Auth

The client takes *resolved* credentials (the file reads stay in #95/config):
- `{ kind: "basic", username, password }` → `Authorization: Basic …`
- `{ kind: "bearer", token }` → `Authorization: Bearer …`
- omitted → no auth header (e.g. a freshly-bootstrapped managed instance).

AdGuard Home accepts HTTP Basic Auth on `/control/*`; bearer covers a
reverse-proxied deployment / the `PCT_ADGUARD_API_TOKEN_FILE` path. (If a
future AdGuard version drops Basic for cookie-session login, that is an additive
follow-up — noted in the client doc comment.)

## API surface (AdGuard Home v0.107 `/control`)

| Method | Endpoint | Body | Response |
|---|---|---|---|
| `getStatus()` | `GET /control/status` | — | JSON (version, running, protection_enabled, dns_addresses…) |
| `listClients()` / `listManagedClients()` | `GET /control/clients` | — | JSON `{ clients, auto_clients, supported_tags }` |
| `addClient(c)` | `POST /control/clients/add` | client object | 200, empty body |
| `updateClient(name, data)` | `POST /control/clients/update` | `{ name, data }` | 200, empty body |
| `deleteClient(name)` | `POST /control/clients/delete` | `{ name }` | 200, empty body |
| `getUserRules()` | `GET /control/filtering/status` | — | JSON (`user_rules: string[]`, …) |
| `setUserRules(rules)` | `POST /control/filtering/set_rules` | `{ rules }` | 200, empty body |

- **Responses** are zod-validated. **Request bodies** are sent verbatim (we
  validate inbound, not our own outbound), so a round-tripped client object
  never loses fields AdGuard added across versions.
- POSTs return an empty 200 body → those methods return `void` and only assert
  2xx (never call `.json()` on them).

## Error taxonomy (mirrors `transport/activitywatch/errors.ts`)

- `AdGuardError` — base (`baseUrl`, `path`).
- `AdGuardUnreachableError` — `fetch` threw / abort timeout (`cause`, `timedOut`).
- `AdGuardRequestError` — non-2xx (`statusCode`, `statusText`).
- `AdGuardAuthError extends AdGuardRequestError` — 401/403 (so `instanceof
  AdGuardRequestError` still catches it; `docs/testing.md` → "401 → AuthError").
- `AdGuardParseError` — non-JSON body or zod mismatch (`zodError?`).
- `AdGuardScopeError extends AdGuardError` — a write to a non-`pct:` client name,
  raised before any request.

## Files

- `server/src/transport/adguard/errors.ts`
- `server/src/transport/adguard/schemas.ts` — zod response schemas + request
  body TS interfaces.
- `server/src/transport/adguard/client.ts` — `AdGuardClient`.
- `server/src/transport/adguard/index.ts` — barrel (replaces the stub).
- `server/tests/transport/adguard/client.test.ts` — unit tests (undici
  `MockAgent`), plus `schemas.test.ts` if useful.

## Test plan (unit, ≥80% gate)

- construction: trailing-slash baseUrl normalisation; default vs custom prefix.
- auth header: basic (base64 user:pass), bearer, none.
- `getStatus`: happy parse; non-object body → ParseError; schema mismatch →
  ParseError.
- `listClients`/`listManagedClients`: happy; prefix filter; malformed top-level
  → ParseError.
- `addClient`/`updateClient`/`deleteClient`: correct path+body+method on 200;
  prefix guard throws `AdGuardScopeError` and issues **no** request.
- `getUserRules`/`setUserRules`: happy get; correct set body.
- error mapping: 401/403 → `AdGuardAuthError`; other non-2xx →
  `AdGuardRequestError`; `replyWithError` (conn refused) → `AdGuardUnreachableError`;
  injected abort → `timedOut` true; non-JSON 200 → `AdGuardParseError`.

## Deferred (tracked — not this PR)

- Mode plumbing / preflight (#95), managed supervisor (#96), per-client domain
  blocklist UI + schedule (#97). Per-client *rule* read-modify-write confinement
  (preserving foreign global rules) lands with #97; #94 ships the raw `getUserRules`
  /`setUserRules` building blocks + the client-identity (`pct:`) confinement.
- Optional `adguard.int.test.ts` against the `adguard/adguardhome` container
  (the `docs/testing.md` compose env) — integration tier, not the unit gate.
