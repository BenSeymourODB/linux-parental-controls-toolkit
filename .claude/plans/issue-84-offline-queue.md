# Issue #84 — Offline-queue: persist policy pushes for unreachable clients + replay on reconnect

Roadmap: `docs/roadmap.md` → Phase 4 ("Offline-queue: changes for offline
clients persisted and replayed on next reachable probe").
Design: `docs/architecture.md` → "Client offline at policy-change time —
queue the change; replay on next successful SSH probe" and "Pending policy
changes: queued for clients that are currently offline".

## Problem

When a policy change can't be pushed because the client is offline, the
intended change must be persisted and replayed on the next successful probe.
Conservative semantics: a missed push is queued, never silently dropped.

## Constraints / boundaries

- License boundary: pure TypeScript over Drizzle (Apache-2.0) + better-sqlite3
  (MIT) + croner (MIT). No GPL surface, no Docker-image change. The actual
  remote command still execs over the SSH facade (`transport/ssh`), preserving
  the subprocess boundary; this module only *persists and replays* the
  intent.
- The live SSH executor (timekpra-over-SSH, #83/PR#155) and SSH credential
  plumbing (#39, Phase-4 step) are **not** dependencies of this work: the
  queue is built against injected `ActionExecutor` / `ReachabilityProbe`
  seams (the same dependency-injection idiom as the stub transport), so it is
  fully unit-tested now and wired to the real push when that lands. This keeps
  #84 independent of the in-flight PRs.
- Migrations are timestamp-prefixed (`npm run db:generate`, never hand-named —
  #133), so a new table migration can't collide with the concurrent #146/PR#156
  schedule/exception migration.

## Design

### Storage (`policy/schema.ts` + `policy/enums.ts`)

A `transport_queue` table holding pending per-client transport actions:

- `id` (autoinc — ordering + at-least-once identity)
- `client_id` FK → `clients` (`ON DELETE CASCADE`)
- `coalesce_key` text — the "target" a push is for
- `kind` text — action discriminator (e.g. `policy.push`) so a future executor
  can route the payload
- `payload` JSON — serialized action to replay
- `status` text `pending` | `failed` (dead-letter), CHECK + `enums.ts` tuple
- `attempts` integer (>= 0), `last_error` text nullable
- `enqueued_at`, `updated_at` timestamps
- UNIQUE `(client_id, coalesce_key)` → coalescing is structural: a newer push
  for the same target upserts over the older queued one, so the queue can't
  grow unboundedly while a client stays offline.
- index `(client_id, status, id)` for the ordered per-client drain read.

### Repository (`transport/queue/repository.ts`)

Synchronous Drizzle functions over `PolicyDb`, mirroring `policy/repository.ts`:
`enqueue` (upsert/coalesce → resets to pending, attempts 0), `listPending`,
`listForClient`, `clientsWithPending`, `countPendingByClient`, `markDrained`
(delete), `markFailed`, `recordAttempt`.

### Drainer (`transport/queue/drainer.ts`)

`drainClient(db, clientId, executor, opts)`: walk pending rows ascending by id;
for each, record an attempt and call the executor:
- success → delete the row (drained)
- retriable error (`SshError.retriable === true`, read structurally) → stop
  draining this client, leave it + the rest pending (host went offline)
- non-retriable error, or `attempts >= maxAttempts` backstop → dead-letter the
  row (`failed` + `last_error`) and continue past it so one poison action
  doesn't block the queue head.
Returns `{ drained, failed, deferred }`.

### Facade + scheduler (`transport/queue/facade.ts`, `scheduler.ts`)

- `pushOrEnqueue(action, executor)` — the call-site API a Phase-4 push uses:
  try now; on a retriable failure, enqueue for later; a non-retriable failure
  propagates (the command itself is wrong — replaying won't help).
- `startOfflineQueueDrainer({ db, probe, executor, log, pattern })` — a croner
  job that, on each tick, finds clients with pending work, probes each, and
  drains the reachable ones. Returns a handle with `.stop()`. Probe/executor
  injected; not started in `buildApp` until the real push transport is wired.

### Policy-push adapter (`transport/queue/policy-push.ts`)

`queuedActionFromPolicyPush(command)` maps the existing `PolicyPushCommand`
(`transport/stub.ts`) → a `NewQueuedAction` (`kind: "policy.push"`, coalesce
key `user:<id>` / `client`), tying the queue to the established command shape.

### Idempotency contract

At-least-once delivery (a crash after the executor succeeds but before the row
delete replays the action), so the executor must be idempotent — which the
timekpra desired-state setters are. Documented on the drainer.

## Phases

1. enums + schema + migration + repository (+ tests).
2. types + drainer + facade `pushOrEnqueue` + policy-push adapter (+ tests).
3. scheduler (croner) + barrel + roadmap/doc note (+ tests).

## Deferred (tracked)

- Live wiring of the real SSH `ActionExecutor` / `ReachabilityProbe` → lands
  with the timekpra push call sites (#83) + SSH credential plumbing (#39).
- Surfacing pending/dead-lettered state in the admin Clients page → #81; in the
  save-and-push "preview diff" → #64. This PR exposes the query functions they
  consume; it adds no HTTP routes (kept out to avoid stepping on #81).
