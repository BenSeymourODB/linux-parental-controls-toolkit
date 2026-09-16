# How to issue an integration API token

External systems (the first being a family calendar that grants screen-time
rewards for completed chores) call the dashboard through the
`/api/integrations/*` surface, authenticated with a **per-integration
bearer token**. Tokens are scoped and revocable, and minting/listing/
revoking them are admin actions. The design and the rules that apply to any
integrator are in [`architecture.md`](../architecture.md) → "External
integrations".

You manage tokens from the dashboard's **Integrations** view, or directly
against the API below (all three routes are admin-guarded).

## Step 1 — Mint a token

Choose a human-meaningful name and the scopes the integration needs:

```http
POST /api/integrations/tokens
Content-Type: application/json

{ "name": "calendar", "scopes": ["grants:write"] }
```

The available scopes (the fixed vocabulary in
`server/src/integrations/scopes.ts`) are:

| Scope | Grants the ability to… |
|---|---|
| `grants:write` | create grants via `POST /api/integrations/grants` |
| `policy:read` | read effective policy / status for the integrator's UI |

A token may carry one or more distinct scopes. Grant the **narrowest** set
the integration actually needs.

The response returns the plaintext **secret once** — only its hash is
stored, so copy it into the integrator's config now; it is never shown
again:

```json
{
  "id": 3,
  "name": "calendar",
  "scopes": ["grants:write"],
  "secret": "<plaintext-secret-shown-once>",
  "createdAt": "2026-08-23T18:00:00.000Z"
}
```

The integrator then authenticates every call with it:

```http
Authorization: Bearer <plaintext-secret>
```

## Step 2 — Review issued tokens

```http
GET /api/integrations/tokens
```

Returns a summary per token — `id`, `name`, `scopes`, `createdAt`,
`lastUsedAt` (when it last authenticated a call, or `null`), and
`revokedAt` (`null` while active). Secrets are never returned by this
route.

## Step 3 — Revoke a token

Revoke a token the moment an integration is decommissioned or a secret may
be exposed:

```http
POST /api/integrations/tokens/:id/revoke
```

Revocation takes effect immediately; the token can no longer authenticate a
call. The row remains for the audit trail with `revokedAt` set.

## What the token can be used for today

Token issuance is shipped and independent of the inbound endpoints it
gates. The **grants** consumer endpoint (`POST /api/integrations/grants`,
which the `grants:write` scope authorizes) is still landing
([#113](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/113)),
so a `grants:write` token you mint now is provisioned ahead of the endpoint
that will consume it. When that endpoint ships, its own how-to will cover
the grant request/idempotency contract; the token you issued here is the
credential it will accept.

Every grant an integrator makes is recorded in an immutable ledger, is
idempotent by an integrator-supplied `source_ref`, and is **additive** on
top of the policy baseline — see
[`architecture.md`](../architecture.md) → "Rules that apply to any external
integrator".
