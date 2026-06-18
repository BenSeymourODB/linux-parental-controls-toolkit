# Issue #77 — Enrolment-token endpoint + client registration

Phase 3 (server side). Adds the dashboard half of client enrolment: an
admin-minted, single-use, short-TTL enrolment token, and the endpoint the
install script (#76) calls to register a `Client` + its `UserOnClient`
mappings and receive what it needs (server SSH public key, per-client bearer
token).

Authoritative spec: `docs/architecture.md` → "Policy model"/transport table,
`docs/client-install.md` → step 7–8. Builds on #50 (DTO/envelope), #49 (`app.db`),
#52 (`requireAdmin`), #48/#51 (`clients`, `users_on_clients`).

## Endpoints

1. **`POST /api/clients/enrolment-tokens`** — **admin-guarded** (`requireAdmin`).
   Mints a single-use token bound to the supervised-user mapping the admin is
   provisioning.
   - Body: `{ supervisedUsers: [{ userId, linuxUsername }], ttlSeconds?, hostname? }`.
   - Validates every `userId` exists → `404` if any missing.
   - Mints a 256-bit token (`crypto.randomBytes(32).base64url`), stores only its
     SHA-256 hash + the mapping payload (JSON) + `expiresAt`; returns the
     plaintext **once** (`201`).

2. **`POST /api/clients/enrol`** — **token-authenticated** (NOT admin; the client
   has no session). `Authorization: Bearer <enrolment-token>`.
   - Body: `{ hostname, sshUser, supervisedUsers: [{ linuxUsername, linuxUid }] }`.
   - Validates the bearer token: hash lookup → missing/expired/consumed all →
     `401` with distinct codes. The linuxUsername set must equal the minted
     mapping's set → `400 enrolment_user_mismatch` otherwise. Re-checks each
     minted `userId` still exists → `409` if deleted since mint.
   - In **one transaction**: create the `Client`, insert the `UserOnClient`
     rows (joining minted `userId` ↔ request `linuxUid` on `linuxUsername`),
     mint+store a per-client bearer-token hash, mark the enrolment token
     consumed. Duplicate hostname → `409` (already enrolled).
   - Returns `201 { clientId, hostname, sshUser, bearerToken (once),
     sshPublicKey: string | null, supervisedUsers }`. `sshPublicKey` is read
     from `PCT_SSH_PUBLIC_KEY_PATH` if present, else `null` (Phase-4 keygen
     may not have run yet — degrade gracefully).

Spelling: use **`/enrol`** (British), matching `docs/client-install.md` step 8
(authoritative), not the issue body's `/enroll`. Noted in the PR.

## Schema + migration

- New `enrolment_tokens` table: `id`, `token_hash` (unique), `hostname`
  (nullable), `supervised_users` (JSON), `expires_at`, `created_at`,
  `consumed_at` (nullable), `consumed_client_id` (nullable FK → clients,
  `set null`).
- `clients`: add nullable `bearer_token_hash` (only enrolled clients have one;
  CRUD-created clients (#51) legitimately don't).
- Generate via `npm run db:generate` (timestamp-prefixed, #133) — never
  hand-name. Extend `migrations.test.ts`/`schema.test.ts` as needed.

## Module layout (mirrors `api/policy/` + `policy/repository.ts`)

- `server/src/auth/secret-token.ts` — leaf crypto util: `generateToken()`,
  `hashToken()` (SHA-256), `timingSafeEqualHex()`. For high-entropy bearer
  secrets (enrolment + future integration tokens), distinct from Argon2id
  password hashing. Imports only `node:crypto`.
- `server/src/policy/enrolment.ts` — data access over `app.db`: insert/find/
  consume tokens, the enrol transaction (client + links + bearer).
- `server/src/api/clients/{dtos,service,ssh-identity,routes,index}.ts` — zod
  DTOs + response mappers, the mint/enrol orchestration, the SSH-public-key
  reader, thin HTTP handlers, and the registrar. Wired in `api/plugin.ts`
  after `registerPolicyRoutes`.
- `server/src/config.ts` — add `sshPublicKeyPath`
  (`PCT_SSH_PUBLIC_KEY_PATH`, default `/data/secrets/ssh/id_ed25519.pub`).

## Security / license notes

- Enrol is unauthenticated-by-session **by design** — guarded by a 256-bit,
  hashed-at-rest, single-use, short-TTL token. Brute force is infeasible;
  leak risk is bounded by TTL + single-use. Per-IP rate-limiting on enrol is a
  possible follow-up (entropy makes it non-critical) — note, don't build.
- No GPL linkage; no transport calls (SSH keygen itself is Phase 4 — we only
  *read* a public key file if present). `license-guard` unaffected.

## Tests (Vitest, ≥80% gate)

- `auth/secret-token.test.ts` — uniqueness, hash determinism/difference, compare.
- `policy/enrolment.test.ts` — token lifecycle + enrol transaction atomicity
  (duplicate uid rolls back; no half-created client / un-consumed token).
- `api/clients/ssh-identity` — key present → string; absent → null.
- `api/clients-enrolment.test.ts` — full `app.inject()` matrix: mint anon→401,
  mint bad userId→404, mint happy→201; enrol missing/invalid/expired/consumed
  bearer→401, mismatch→400, happy→201 (+links, +bearer, +sshPublicKey null/set),
  reuse→401, duplicate hostname→409.
- Extend `migrations.test.ts` / `schema.test.ts` for the new table/column.

## Docs

- `.env.example` + `docs/server-deployment.md`: `PCT_SSH_PUBLIC_KEY_PATH`.
- `docs/architecture.md`: add `bearer_token_hash` to the Client sketch and the
  `enrolment_tokens` ledger; document the enrol contract.

## Deferred (tracked)

- Wiring into the orchestrator `install-client.sh` → #76.
- SSH keypair generation on the server → Phase 4 (#39 entrypoint step).
- Per-IP rate-limit on enrol → follow-up note.
