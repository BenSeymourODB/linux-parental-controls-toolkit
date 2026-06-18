# Issue #54 — Stub transport push (log-only) on policy change

Roadmap: `docs/roadmap.md` → Phase 2 ("no transport integration yet; all
'push' actions are stubbed to log").

## Goal

Add a thin policy-change hook in the policy/API layer that, on any mutating
policy write (the #51 CRUD routes for `User`, `Client`, `UserOnClient`),
computes the *intended* per-client effect and **logs** it — no SSH / Ansible.
This makes the seam where Phase 4 (SSH + `timekpra`) and Phase 6 (Ansible)
plug in explicit and testable.

## Acceptance criteria (from the issue)

- [x] Policy mutations emit a structured "would push" log line per affected
      client.
- [x] A unit test asserts the stub fires with the expected payload on a
      representative mutation.
- [x] Documented (code comment + `docs/`) as the Phase-4 / Phase-6
      integration seam.

## Design

- New module `server/src/transport/stub.ts`:
  - `PUSH_STUB_COMPONENT = "transport/stub"` — the pino `component` tag.
  - `PolicyPushReason` union (`user.created|updated|deleted`,
    `client.*`, `link.upserted|deleted`).
  - `PolicyPushCommand { clientId; userId: number | null; reason; detail }`
    — shaped like the future per-client transport command so the Phase-4
    swap from "log" to "invoke `timekpra`" is drop-in.
  - Pure builders `userPushCommands` / `clientPushCommands` /
    `linkPushCommands` → `PolicyPushCommand[]` (fully unit-testable, no I/O).
  - `createPolicyPushStub(log)` → `{ push(commands) }`, which binds the
    `component` child logger once and emits **one `info` line per command**
    (no-op on an empty list).
- `server/src/policy/repository.ts`: add `listUserClientIds(db, userId)` so a
  user-level change can resolve its affected clients (captured *before* a
  delete, since links cascade).
- `server/src/api/policy/routes.ts`: create the stub once via
  `createPolicyPushStub(scope.log)`, and after each successful mutation call
  the relevant builder + `stub.push(...)`. Handlers stay thin.
- Re-export the stub from `server/src/transport/index.ts`.
- `docs/architecture.md` → Outbound flow: note the Phase-2 stub seam.

## Affected-client mapping

- `user.created` → no links yet → empty (no line).
- `user.updated` / `user.deleted` → every client the user is linked to.
- `client.*` → that one client, `userId: null`.
- `link.upserted` / `link.deleted` → that one (user, client) pair.

## Tests

- `server/tests/transport/stub.test.ts` — pure builders (fan-out over
  client ids, `userId: null` for client-level, empty list) + `push`
  fan-out / no-op via a captured pino stream.
- `server/tests/api/policy-push-stub.test.ts` — drive real mutations through
  `app.inject()` with a capturing `loggerStream`; assert the `transport/stub`
  "would push" line and payload for a representative mutation of each entity.

## License boundary

N/A — plain TypeScript + pino (ships in Fastify). No GPL linkage, no
subprocess, no image change. This PR *establishes* the subprocess/REST seam
that Phase 4/6 fill in; it does not collapse any boundary.
