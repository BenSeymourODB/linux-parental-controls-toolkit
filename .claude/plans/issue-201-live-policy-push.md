# Issue #201 — Wire live CRUD→SSH policy push (replace the Phase-2 stub)

Roadmap: `docs/roadmap.md` → Phase 4 (SSH + `timekpra` transport). Closes #201.

## Goal

Replace the Phase-2 logging stub (`transport/stub.ts` `PolicyPushStub.push`) with a
real outbound dispatch that pushes a user's effective overall-session policy to each
linked client over the SSH + `timekpra` transport, routing unreachable clients through
the offline queue (#84) and recording every command in the audit log (#85). The route
call sites and the computed `PolicyPushCommand` shape stay **unchanged** (drop-in, per
the stub docstring).

## What already exists (the seams this wires together)

- **Resolver (#143)** `policy/resolve.ts` → `effectivePolicy(...)`: per-day
  `allowedWindows` + `overallSeconds`.
- **Weekly bridge (#140)** `policy/weekly-windows.ts` → `resolveWeeklyAllowedWindows`,
  and `transport/timekpr/allowed-hours.ts` → `buildWeeklyAllowedHoursCommands`.
- **`TimekprClient` (#83)** `transport/timekpr/client.ts`: `setTimeLimits` (per-weekday
  7-element seconds list, Mon→Sun), `setTimeLimitWeek`, `setTimeLimitMonth`,
  `setWeeklyAllowedHours`. Runs over a structural `TimekprTransport`.
- **Offline queue (#84)** `transport/queue/`: `pushOrEnqueue(db, action, executor)`
  (try now, enqueue on retriable/unreachable), `drainClient`, `startOfflineQueueDrainer`,
  `queuedActionFromPolicyPush`, `POLICY_PUSH_KIND`, `ActionExecutor`/`ReachabilityProbe`.
- **Audit (#85)** `transport/audit/`: `AuditingTransport` (decorates the SSH facade,
  implements `TimekprTransport` structurally; `.withContext({clientId,userId,actor,reason})`
  attributes each command), `DrizzleAuditSink`.
- **SSH facade** `transport/ssh/facade.ts`: `SshTransport`, `targetFromClient(row, creds)`,
  `SshCredentials` (privateKey + optional port/passphrase).
- **Key material**: `settings.sshPrivateKeyPath` (generated on boot by #39, now on main);
  `loadServerSshPublicKey` mirrors the "absent ⇒ null, don't crash" pattern.
- **Repository**: `getClient`, `listUserLinks`/`listUserClientIds`, `getUser` (tz),
  `listUserBudgets`, `listUserSchedules`.

## Mapping a `PolicyPushCommand` → `timekpra`

A command carries `{ clientId, userId, reason, detail }`. The executor receives the
queued form (`{ clientId, coalesceKey, kind:"policy.push", payload:{userId,reason,detail} }`).

- **userId === null** (client-scoped `client.*`): no per-user enforcement to push → no-op.
- **client row missing** (deleted): no-op.
- **no `(userId, clientId)` link** (e.g. `link.deleted`, link gone): no-op — the
  `linux_username` can't be resolved and there's nothing to enforce. (Clearing limits on
  unlink is deferred; see below.)
- **otherwise** recompute the user's effective overall policy for that client and push:
  - `setTimeLimits(perWeekdaySeconds)` — `overallSeconds` resolved per ISO weekday
    (Mon..Sun) via `effectivePolicy`, only when a daily overall budget exists.
  - `setTimeLimitWeek` / `setTimeLimitMonth` — from overall budgets with `window`
    `weekly`/`monthly` (summed). The resolver only models daily; weekly/monthly are read
    straight from budgets (no grant overlay — weekly/monthly grants aren't modelled).
  - `setWeeklyAllowedHours(resolveWeeklyAllowedWindows({schedules, tz, reference: now}))`.
  - tz = `user.tz ?? settings.defaultTz`. Grants resolved as `[]` (the grant-driven
    recompute push is #117).

Errors propagate the SSH taxonomy unchanged: `SshUnreachableError`/timeout (retriable) →
`pushOrEnqueue` enqueues; `SshCommandError`/`TimekprArgumentError` (non-retriable) → the
caller's `.catch` logs it / the drainer dead-letters. Auditing is automatic via the
`AuditingTransport` view.

## Phases

### Phase 1 — the executor + pure resolution helper (fully unit-tested)
`transport/policy-push/`:
- `payload.ts` — zod schema for the queued `policy.push` payload (`userId: number|null`,
  `reason`, `detail` passthrough) so the replayed payload is validated before use
  (`CLAUDE.md` → validate subprocess/queue input).
- `resolve.ts` — pure `resolvePolicyPush({ tz, schedules, budgets, now })` →
  `{ perWeekdaySeconds: number[] | null, weeklySeconds: number|null,
  monthlySeconds: number|null, weekly: WeeklyAllowedWindows }`. No I/O. Unit-tested
  across: no budgets/schedules (null limits, all-day allow), daily-only, weekly+monthly,
  schedule windows → allowed-hours.
- `executor.ts` — `createPolicyPushExecutor({ db, buildClient, credentials, defaultTz,
  now? }): ActionExecutor`. Loads rows, calls `resolvePolicyPush`, builds the client via
  the injected `buildClient(target, username, ctx)` factory, issues the setters. `buildClient`
  is the test seam (a fake `TimekprPushClient` recording calls); prod builds a real
  `TimekprClient` over the `AuditingTransport.withContext(...)`. No-op branches return early.

### Phase 2 — the dispatcher + route wiring
- `dispatcher.ts` — `createPolicyPushDispatcher({ db, executor, log }): PolicyPushStub`:
  `push(commands)` fires `pushOrEnqueue` per command, fire-and-forget (preserving the
  sync-void call-site contract), logging each `pushed`/`queued` outcome and catching
  errors (never throws into the route). Plus `createLoggingPolicyPushDispatcher(log)` =
  today's stub behaviour, the fallback when SSH key material is absent.
- Thread the dispatcher through `apiPlugin` opts → `registerPolicyRoutes(scope, push)`,
  defaulting to the logging dispatcher so existing tests/dev keep working.

### Phase 3 — bootstrap wiring + drainer + docs
- `bootstrap.ts` — `createTransport(settings, db, log)`: read the private key (absent ⇒
  `null` ⇒ logging fallback, like the prober pre-#39), build `SshTransport` +
  `DrizzleAuditSink` + `AuditingTransport`, the executor, the dispatcher, a minimal
  SSH `ReachabilityProbe`, and start `startOfflineQueueDrainer` (the replay half). Return
  a `{ dispatcher, dispose() }` handle.
- `buildApp` constructs it, passes the dispatcher into `registerApi`, and disposes the
  SSH pool + stops the drainer on `app.close()`.
- Update `docs/architecture.md` → "Outbound (server → client) — policy push": the push is
  now live (was stubbed), with the offline-queue + audit behaviour and the async
  fire-and-forget note.

## Deferred (note in PR; file/relink issues)
- **PlayTime / per-activity (app-group) limit push** → Phase 8 enforcement (#99).
- **Ansible / e2guardian config push side** → Phase 6 (#90).
- **Clearing limits on `link.deleted` / unmanage** → file a follow-up issue.
- **Grant-driven recompute push** (effective budget incl. active grants) → #117.
- **Full-lockout (deny-all week)** maps to a non-representable allowed-hours push today →
  Phase 8c (session-kill / zero daily limit).
- **Live timekpra-over-SSH round-trip** integration test → #157 / #207 (needs a real
  daemon container; not stand-up-able in the scheduled-run sandbox).

## License boundary
`timekpra` stays a subprocess over SSH (`ssh2`); no GPL linkage, no GPL binary added to
the image. Pure TypeScript orchestration over the existing SSH facade + Drizzle. No new
dependency. (`CLAUDE.md` → "License boundaries"; `docs/licensing-analysis.md`.)
