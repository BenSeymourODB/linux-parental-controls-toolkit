# Plan — #354 Post-enrol connectivity verification

Server-side SSH self-test, triggered by the installer, that proves the
**dashboard can reach the client over SSH** (the direction every push, probe,
and telemetry pull actually uses) — the gap that let three clients in the
v0.1.0-alpha.5 incident "enrol successfully" for days while the server→client
SSH path had never once worked.

Roadmap: alpha-1 readiness (Phase 4 adjacent — enrolment/transport hardening).
Issue: #354. Builds on the SSH facade (#82), its failure classification (#353),
the enrolment surface (#77), and the per-client bearer token (#77/#100).

## Design

The verification ladder — resolve → TCP connect → SSH auth + trivial `exec true`
— is already implemented by the SSH facade: a single `exec(target, ["true"])`
rejects with `SshUnreachableError` whose `reason` (#353) already discriminates
`dns` / `connection_refused` / `timeout` / `auth` / `handshake` / `unknown`.
So verification is a thin, classified wrapper over one `true` exec — the same
primitive `sshReachabilityProbe` (the offline-queue's dead-host skip) already
uses, but returning the classified outcome instead of a bare boolean.

Authentication: the endpoint is authenticated by the client's **own** per-client
bearer token (issued at enrol), not an admin session — the installer has no admin
session. The `:id` in the path must match the authenticated client, so a client
can only ever ask the server to probe **its own** recorded address (the
"can't hammer arbitrary hosts" guarantee in the issue). Mirrors the event-stream
bearer auth (`events/auth.ts`).

Degrades gracefully pre-#39: when no SSH key is wired the verifier is absent and
the endpoint returns `503 verification_unavailable`, exactly as the time-today
(#257) / push-now (#304) levers do.

## Phases

### Phase 1 — Server core (this is the bulk; fully unit-tested)

- **Schema** (`policy/schema.ts`): add to `clients` —
  `last_verified_at` (timestamp, null = never), `last_verify_reachable`
  (boolean, nullable), `last_verify_reason` (text, nullable; the
  `SshUnreachableReason` when not reachable). Plain `text` for the reason so the
  `policy/` layer keeps no dependency on `transport/`. `npm run db:generate` for
  the timestamp-prefixed migration.
- **Repository** (`policy/repository.ts`): `recordClientVerification(db, id,
  { reachable, reason, at })` — writes the three columns and, when reachable,
  also bumps `last_seen` (a real server→client round-trip). Same
  system-observed-column discipline as `recordClientLastSeen`.
- **Verifier seam** (`transport/health/verifier.ts`): `ClientConnectionVerifier`
  interface + `SshClientConnectionVerifier` over an injected `{ exec }` transport
  slice + credentials. Runs `exec(target, ["true"])`; success →
  `{ reachable: true, reason: null, detail, at }`; `SshUnreachableError` →
  reason `err.reason`; `SshExecTimeoutError` → `timeout`; other `SshError` →
  `unknown`; non-`SshError` rethrows (a real bug, never masqueraded as offline).
- **DTO** (`api/clients/verify-dtos.ts`): `verifyConnectionResponseSchema`
  `{ reachable, failureClass?, detail, verifiedAt }`, `failureClass` derived from
  `sshUnreachableReasonValues` (same "DTO enum from the transport source-of-truth"
  discipline `health-dtos` already uses).
- **Route** (`api/clients/verify-routes.ts`): `POST /clients/:id/verify-connection`
  — bearer-authenticated (not `requireAdmin`), `:id` must equal the authenticated
  client (else `403`), per-client fixed-window rate limit, `503` when the verifier
  is absent. On success persists via `recordClientVerification` and returns the DTO.
- **Wiring**: `PolicyPushTransport.verifier?` built in `createPolicyPushTransport`
  (`new SshClientConnectionVerifier(ssh, credentials, { log })`, the *un-audited*
  surface — a liveness `true` is data, not an admin command); threaded through
  `ApiPluginOptions` → `registerApi` → `plugin.ts` → the new registrar, exactly
  like `prober`.

### Phase 2 — Surface the outcome

- Add `lastVerifiedAt` / `lastVerifyReachable` / `lastVerifyReason` to
  `clientHealthSchema` + `assemble()` so the Clients card distinguishes
  "enrolled but never verified" from "verified reachable" from "verification
  failed (<class>)". Read-only badge on `ClientsView.svelte` (the admin can't
  *trigger* it — that's the client's bearer token — only see the last outcome).

### Phase 3 — Installer + docs

- `install-client.sh` / `self-test.sh`: call the endpoint as a late step (after
  `pct_orch_authorize_key`), print a class-specific remediation hint, warn loudly
  on failure but **do not roll back** the enrolment (the queue already handles
  offline clients). Covered by bats.
- `docs/server-deployment.md`: a short "Name resolution from the container"
  section the `dns` hint links to.

## License boundary

Pure exec-over-SSH via the existing `ssh2` facade — no in-process/GPL linkage,
no GPL binary added to the image (`CLAUDE.md` → "License boundaries").

## Deferred (filed + linked from the PR if not completed here)

- The admin-triggered re-verify button is intentionally **out of scope**: the
  endpoint is the client's own bearer credential by design. Any admin-initiated
  reachability check is the existing live health prober (#81), not this endpoint.
