# ADR 0014 — External integration grant contract (v1)

- **Status:** Accepted (2026-08-23) — dashboard-side v1; pending confirmation
  with next-digital-wall-calendar (NDWC).
- **Issue:** [#118](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/118)
  (the contract spike), gating
  [#113](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/113)
  (the endpoint). Composes with the integration-token work
  ([#114](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/114))
  and the immutable grant ledger.
- **Phase:** 10

## Context

`docs/architecture.md` → "External integrations" specifies the inbound
grant endpoint an external integrator calls to award screen-time rewards, with
this worked example:

```http
POST /api/integrations/grants
Authorization: Bearer <integration-token>
Content-Type: application/json

{
  "user_ref": "alice",
  "scope": "overall",
  "seconds": 1800,
  "expires_at": "2026-06-05T23:59:59-04:00",
  "source_ref": "calendar:chore-completion:42a9...",
  "reason": "Cleaned room (chore reward)"
}
```

Most of the contract is already fixed by decisions on `main`:

- The `grants` table (`policy/schema.ts`) is an immutable, additive ledger with
  a `UNIQUE(source_ref)` index (idempotency), a `seconds_granted > 0` CHECK, a
  `source` CHECK (`'admin'` or `'integration:%'`), and a scope/target coherence
  CHECK (`overall` ⇒ null target; `activity`/`group` ⇒ non-null target).
- Grant scopes mirror policy scopes: `["overall", "activity", "group"]`
  (`policy/enums.ts`).
- The token vocabulary fixes `grants:write` as the scope this endpoint requires
  (`integrations/scopes.ts`), enforced by `integrations/guard.ts`.

What #118 must still **pin** before #113 can exist is everything the schema
does *not* determine — chiefly how an integrator names a user, since `User` has
only `id` + `display_name` today (no stable human slug), and the request/reply
casing, target grammar, and idempotent-replay/error semantics.

## Decision

### 1. `user_ref` → `User.id` (decimal string) for v1

`user_ref` is the dashboard `User.id` in **decimal-string** form (e.g.
`"7"`). The parent configures the mapping once in NDWC (which dashboard user is
"Alice"); the dashboard resolves `user_ref` to a `User` and returns `404` if
none exists.

The field is typed on the wire as a JSON **`string`**, not a number, even
though v1 only accepts a decimal id. This is deliberate forward-compatibility: a
later release can also accept a human-assigned alias (`"alice"`, as the
architecture example imagines) as an *additional* accepted form **without a
`v2`** — widening the set of accepted strings is backward-compatible, whereas
changing a numeric field to a string would not be. The architecture example's
`"alice"` is therefore honoured as the *shape* (a string) now, with the *alias
resolution* deferred to a future additive change.

`User` gains no new column in this ADR — introducing a stable external alias is
a separate, additive decision (a migration + admin UI) and is out of scope for
the record-and-dedupe endpoint.

### 2. snake_case wire contract

The request and response bodies use **snake_case** (`user_ref`, `source_ref`,
`expires_at`, `granted_at`, …), matching the architecture example verbatim.
This is the deliberate convention for the external machine-to-machine
`/api/integrations/*` surface and is intentionally distinct from the internal
camelCase `/api/*` DTOs the built-in frontends consume. The route maps
snake_case wire fields to the camelCase repository input at the boundary, so the
storage layer keeps the house convention.

(The client-enrolment endpoints use camelCase despite being external, because
they are called by *our own* install script. The grant endpoint is a contract
with a *third-party* repo, where matching the documented shape reduces
integration friction and avoids contradicting the authoritative design doc.)

### 3. `scope` / `target` grammar

`scope` completes the architecture example (which showed only `overall`):

| `scope`    | `target`                          |
| ---------- | --------------------------------- |
| `overall`  | omitted / `null` (forbidden)      |
| `activity` | required — an `activities.id`     |
| `group`    | required — an `activity_groups.id`|

`target` must resolve to an existing row (`404` otherwise). This mirrors the
table's coherence CHECK and the resolver's `"scope:targetId"` keying
(`policy/resolve.ts`), where `group` means an **activity group** (ADR 0008),
not a user group. A grant on a target with no daily budget is a no-op in the
resolver (an unlimited base stays unlimited) — accepted and recorded, but it
adjusts nothing; the ledger stays the audit record either way.

### 4. `seconds`, `expires_at`, `source_ref`, `reason`

- `seconds` — integer > 0 (matches the table CHECK).
- `expires_at` — an ISO-8601 datetime string, required, and **must be in the
  future** at request time (a grant that has already expired is a client error,
  `400`, not a silently-dead row). Grants always carry an expiry to prevent
  unbounded accumulation (architecture doc).
- `source_ref` — a required, non-empty string; the integrator-owned idempotency
  key. (Admin-issued grants, which carry no `source_ref`, are a separate path
  and unaffected by the `UNIQUE` index — SQLite treats NULLs as distinct.)
- `reason` — optional free text for the audit trail / ledger UI (#116).

### 5. Idempotency & replay

`source_ref` is the idempotency key. The **first** request for a given
`source_ref` creates the grant and returns `201 Created` with the new row. A
**replay** (same `source_ref`) returns `200 OK` with the **already-recorded**
grant and creates no second row — a retried webhook never double-grants. The
replay reply is the stored grant as-is (the endpoint does not compare the replay
body against the original; the `source_ref` is the integrator's promise that the
request is the same). A race between two concurrent first-sightings is resolved
by the `UNIQUE` constraint: the loser catches the unique-violation and returns
the winner's row with `200`.

### 6. `source` stamping

`source` is stamped server-side as `integration:<token-name>` from the
authenticated token (`request.integration.name`), never taken from the body, so
the ledger truthfully records which integration made each grant and the table's
`source` CHECK is always satisfied.

### 7. Errors

| Code | When |
| ---- | ---- |
| `400 validation_error` | malformed body, `seconds <= 0`, non-future `expires_at`, `target` present for `overall` / absent for `activity`\|`group` |
| `401 unauthorized` | missing / malformed / invalid / revoked token |
| `403 insufficient_scope` | valid token lacking `grants:write` |
| `404 not_found` | unknown `user_ref`, or unknown `target` |

### 8. Versioning

The path is `/api/integrations/grants`; these are its **v1** semantics. Because
grants are idempotent and additive, and `user_ref` is a widenable string, the
contract can evolve additively (new optional fields, new accepted `user_ref`
forms) without a breaking `v2`. A genuinely incompatible change would introduce
a parallel `/v2` path rather than mutating this one.

## Scope of the endpoint (record + dedupe only)

This endpoint **records and de-dupes** a grant. It deliberately does **not**:

- emit `grant.applied` or recompute/push the effective budget to the client
  ([#117](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/117));
- rate-limit per token
  ([#115](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/115));
- surface the ledger in the admin UI
  ([#116](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/116)).

Each is a separate Phase-10 issue that builds on the row this endpoint writes.

## Consequences

- #113 is unblocked and implementable against `main` with no schema change.
- The immutable/additive ledger properties are preserved: this endpoint only
  ever inserts (or reads back an existing row); revocation stays a separate
  `revoked_at` write, never an in-place edit.
- **`source_ref` uniqueness is global, not per-integration.** The
  `UNIQUE(source_ref)` index and the replay lookup span the whole ledger, not a
  `(token, source_ref)` pair. With a single integrator and self-namespaced keys
  (the `calendar:…` prefix in the example) this is a non-issue, but if a second
  integrator ever reused a `source_ref` string an earlier one used, its grant
  would be swallowed as a "replay" and it would receive the other integration's
  row. When a second integrator is onboarded, either require namespaced
  `source_ref`s by contract or make the uniqueness `(token_id, source_ref)` — a
  point to settle alongside the NDWC confirmation below.
- **NDWC confirmation is still owed.** This ADR is the dashboard's v1 proposal;
  the reciprocal agreement with next-digital-wall-calendar (especially that it
  will store and send the dashboard `User.id` as `user_ref`, and how it
  constructs `source_ref`) remains #118's cross-repo half. The versioned,
  additive contract keeps that confirmation cheap: if NDWC needs a human alias,
  it is a widening, not a redesign.

## Alternatives considered

- **`user_ref` = `display_name`.** Rejected: not unique, mutable, and would
  break silently when a parent renames a child.
- **`user_ref` = numeric JSON id.** Rejected in favour of a string for the
  forward-compatibility reason in §1.
- **camelCase wire body.** Rejected: it would contradict the authoritative
  architecture example and add friction for the third-party integrator, for no
  benefit the boundary mapping doesn't already provide internally.
- **Overall-only v1.** Rejected: the table and resolver already support
  activity/group grants; validating a `target` is cheap, and completing the
  grammar now avoids a churny follow-up. Reward→scope mapping *policy* (which
  reward grants what) still lives with NDWC / #335 — this ADR only fixes the
  wire primitive.
