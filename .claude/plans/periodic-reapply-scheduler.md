# Plan — #93 Periodic re-apply (tamper reversion) scheduler

Roadmap: `docs/roadmap.md` → Phase 6 ("Periodic re-apply (tamper reversion)").
CLAUDE.md: "Scheduling: croner for in-process periodic jobs (telemetry pull,
**Ansible re-apply**)." So this is an in-process croner job, not a systemd timer.

## Goal

A server-side croner job that periodically re-runs the Phase-6 Ansible
playbook(s) against enrolled clients so local config drift is reverted to the
policy-derived desired state. Each re-apply is recorded in the audit log;
offline clients are skipped (the offline-queue / next probe handles them); a
client whose re-apply fails is backed off so it doesn't thrash.

This is config **reconciliation**, not an anti-tamper arms race — squarely
within the bounded posture (`docs/client-install.md`, `CLAUDE.md` → "Tamper
resistance is deliberately bounded"). No kernel modules, eBPF, obfuscation, or
`/etc` lockdown.

## License boundary

Ansible (GPL-3.0) is only ever **exec'd** as a subprocess via the merged
`createAnsibleRunner` (`transport/ansible`), which runs `ansible-playbook` out
of the first-run venv and parses its exit code. Nothing links/imports/embeds
Ansible. This module adds plain TypeScript + croner (MIT) on top of that
existing subprocess boundary — no new GPL surface, no GPL binary in the image.

## Foundations already in `main` (reused, not rebuilt)

- `transport/ansible` — `createAnsibleRunner` / `AnsibleRunner.runPlaybook`,
  the typed error taxonomy, `AnsibleHost`/`buildInventory`.
- `transport/audit` — `AuditSink` / `DrizzleAuditSink` / `redactArgv` /
  `listAuditEntries`, and the `audit_log` table.
- `transport/queue/scheduler` — the croner + injected-seam + `tick()`/`stop()`
  pattern this mirrors exactly.
- `policy/repository` — `listClients(db): ClientRow[]` (id/hostname/sshUser).
- `config.ts` — the `telemetry` block is the template for an unwired,
  validated config block (it too is not yet consumed by `buildApp`).

## Design

New module `server/src/transport/reapply/`:

### `types.ts`
- `ReapplyTarget { id; hostname; sshUser }` — a `ClientRow` slice that is also
  structurally an `AnsibleHost`.
- `ClientLoader = () => readonly ReapplyTarget[]` — injected (prod: wraps
  `listClients`), so the scheduler is DB-agnostic and unit-testable.
- `ReachabilityProbe = (clientId) => Promise<boolean>` — same shape as the
  queue's probe; defined locally to keep the module self-contained.

### `scheduler.ts`
- Constants: `DEFAULT_REAPPLY_PATTERN = "0 * * * *"` (hourly — drift reversion
  isn't latency-critical), `REAPPLY_LOG_COMPONENT = "transport/reapply"`,
  `REAPPLY_AUDIT_REASON = "periodic-reapply"`, backoff defaults.
- `startPeriodicReapply(options): PeriodicReapplyHandle` with injected seams:
  `loadClients`, `probe`, `runner`, `playbooks: string[]`, `audit: AuditSink`,
  `log`, optional `pattern`, `backoff`, `now()` clock seam.
- `tick()`:
  - if `playbooks` is empty → no-op (don't even probe).
  - for each client:
    - in backoff window (`now < nextEligibleAt`)? skip (debug log).
    - `probe` false? skip (offline; do not touch backoff).
    - run each playbook against `[host]` via `runner.runPlaybook`, timing it,
      recording one audit entry per (client, playbook):
      - success → `ok`/exit 0; `AnsibleUnreachableError` → `unreachable`;
        `AnsiblePlaybookFailedError` → `failed` (+exit code);
        `AnsibleUnavailable`/other → `failed`.
      - on unreachable mid-run: stop this client's pass, leave backoff
        unchanged (transient — treated like offline).
      - on any non-unreachable failure: continue remaining playbooks, mark
        failure.
    - after the pass: unreachable → no backoff change; any failure → bump
      per-client exponential backoff; full success → clear backoff.
  - per-client try/catch isolation: one client's unexpected error never aborts
    the others (mirrors the queue drainer).
- `stop()` stops the cron; `tick()` is exported for direct driving in tests
  and manual kicks (matches the queue handle).
- **Not wired into `buildApp`** — like `startOfflineQueueDrainer`, the live
  start awaits the first-run venv (#39) and the actual playbooks (#90/#91/#92).
  Documented in the module header. Deferred wiring tracked below.

### `index.ts`
Barrel re-exporting the public surface (mirrors `queue/index.ts`).

### `config.ts`
Add a `reapply` block (mirrors `telemetry`): `cron` (validated cron pattern,
default hourly) + `playbooks` (comma-separated `PCT_REAPPLY_PLAYBOOKS`,
validated bare names, default `[]`). Wired into `loadSettings`. Consumed by the
future activation PR, same as `telemetry`.

## Tests (`tests/transport/reapply/scheduler.test.ts`)

Drive `tick()` directly (cron not fired), real pino logger via `buildApp` to
assert the component tag, injected fake `runner`, and a capturing `AuditSink`
(plus one case using the real `DrizzleAuditSink` + `listAuditEntries` over
`testDb` to prove persistence). Cases:

1. Reapplies a reachable client across all playbooks → audit `ok` rows, log.
2. Skips an offline client (probe false) — no run, no audit, backoff untouched.
3. No-op when `playbooks` is empty (no probe, no audit).
4. A playbook failure records `failed` and backs the client off; the client is
   skipped on the next tick until the backoff elapses (clock seam), then retried.
5. A successful re-apply after a failure clears the backoff.
6. `unreachable` mid-run records `unreachable` and does **not** back off.
7. Per-client error isolation: one client's probe throw doesn't stop others.
8. `AnsibleUnavailableError` (no venv) records `failed` and backs off.
9. Persistence: `DrizzleAuditSink` writes a readable `audit_log` row with the
   right host/user/clientId/reason/outcome.
10. Config: `loadSettings` parses `PCT_REAPPLY_CRON`/`PCT_REAPPLY_PLAYBOOKS`,
    rejects a bad cron and a bad playbook name.
11. `stop()` lifecycle + default cadence constant.

## Deferred (out of scope, tracked)

- Live wiring of `startPeriodicReapply` into `buildApp`/`main` — needs the venv
  (#39) and at least one real playbook (#90/#91/#92). Same deferral as the
  queue drainer. Will file/Link a follow-up issue in the PR if none exists.
</content>
</invoke>
