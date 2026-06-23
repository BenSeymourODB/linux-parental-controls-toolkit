# Issue #64 — Admin "preview diff" before save-and-push

Roadmap: `docs/roadmap.md` → Phase 4 (SSH + `timekpra` transport).

## Goal

Let the admin see **what will change on each affected client** before a policy
save is pushed. The visible affordance is the save-and-push bar mocked in PR
#60; this issue's data flow is the per-client diff + offline-queue annotation in
`docs/architecture.md` → "Outbound (server → client) — policy push".

## Why a backend slice (deferred work)

The full feature spans a diff engine, a preview API, **and** the `/admin`
SvelteKit rendering of the diff bar. The SvelteKit editor work composes with the
per-user/group schedule editors (#53/#63) that are still in flight, so this PR
lands the **engine + contract** cleanly first and defers the UI rendering and a
couple of refinements to tracked follow-ups (see "Deferred").

## Deliverables

1. **`server/src/transport/policy-push/diff.ts`** — a pure, I/O-free diff engine
   over the existing `ResolvedPolicyPush` (`./resolve.ts`): given a `before` and
   `after` resolved push, produce structured, human-readable `PolicyPushChange`
   rows for
   - the **daily overall** limit (per-weekday; collapses to one whole-week row
     when uniform, which is the only shape the resolver emits today),
   - the **rolling weekly** and **monthly** limits, and
   - the **allowed-hours/days** grid, per weekday.
   Each row carries `field`, `kind` (`added`/`removed`/`changed`), an optional
   `weekday`, human `before`/`after` strings, and a one-line `summary`. Durations
   render as `2h 30m`; windows as `08:00–21:00`.
2. **`server/src/api/policy/preview-dtos.ts`** — zod request/response DTOs:
   - request: a *proposed* policy = `budgets[]` + `schedules[]` reusing the
     **single-source** `budgetResponseSchema` / `scheduleResponseSchema` (what
     the editor already holds after a GET — no parallel wire shape), plus an
     optional reference instant for tests.
   - response: `{ userId, hasChanges, changes[], affectedClients[] }`.
3. **`server/src/api/policy/preview-routes.ts`** —
   `POST /api/users/:userId/policy-preview` (behind `requireAdmin`):
   resolve the user's *current* persisted policy → `before`; resolve the
   request's *proposed* policy → `after`; diff them; and list the user's
   **affected clients** (`listUserLinks` → hostname via `getClient`) annotated
   with each client's current **pending-queue depth** (`listForClient`) and
   `lastSeen`. Wired beside `registerEffectiveRoutes` in `api/plugin.ts`. A new
   route file keeps it out of the 1017-line `routes.ts` (low merge-conflict
   surface).

   **Fidelity (caught by a concurrent session's notes on #64):** current policy
   is read with `listUserSchedules` + `listUserBudgets` — the user's **own**
   rules, exactly what the live executor (`policy-push/executor.ts`) resolves and
   pushes — **not** the group-merged `gatherUserScheduleRules` that `effective.ts`
   uses. Group schedules aren't pushed over `timekpra` yet, so diffing against
   them would show windows the push never sends.
4. Tests: `tests/transport/policy-push/diff.test.ts` (engine) +
   `tests/api/policy/policy-preview.test.ts` (route round-trips, 404, auth,
   affected-client annotation).

## Side-effect-free by design

Preview performs **no** SSH probe and **no** push — it is a read + pure compute.
It reports each affected client's last-known `lastSeen` and current
`pendingQueueDepth` so the UI can convey "this client already has N changes
queued"; the actual push-vs-queue decision still happens at push time against
live reachability (`pushOrEnqueue`). This honesty is deliberate: a preview must
not mutate transport state.

## Scope boundary

- **SSH + `timekpra` session limits only.** That is the transport that exists on
  `main` (`resolve.ts` → `ResolvedPolicyPush`). The **Ansible-side** diff
  (e2guardian / iptables filter changes) is Phase 6 (#90, in PR #217) and is a
  tracked follow-up.
- Diffing is at the **semantic `ResolvedPolicyPush`** level (limits + windows),
  not raw `timekpra` argv — that is what is human-readable and what the executor
  consumes.

## Deferred (tracked with a new follow-up issue, linked from the PR)

- `/admin` save-and-push **UI rendering** of the diff bar (the visible
  affordance) — composes with #53/#63.
- **Future-dated** preview (`?date=`): `resolvePolicyPush` is `now`-based; the
  whole-week recurring picture is already captured at "now", so a future
  reference instant is a refinement, not core.
- **Live-reachability** annotation (probe-on-preview) and the **Ansible-side**
  diff.

## License boundary

Unchanged — pure TypeScript over the policy model + zod + the existing
read-only queue/repository seams. No GPL linkage, no subprocess/REST boundary
crossed, no Docker-image change. `CLAUDE.md` → "License boundaries".
