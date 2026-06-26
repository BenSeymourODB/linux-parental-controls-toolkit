# Issue #253 — Clear/unmanage a user's `timekpra` limits on link removal

Roadmap: `docs/roadmap.md` → Phase 4 (SSH + `timekpra` transport). Split out of
#201 (the live CRUD→SSH push), which scoped to push-on-mutation and left
clearing-on-unlink as a follow-up.

## Problem

When a `UserOnClient` link is deleted, the route already emits
`linkPushCommands("link.deleted", userId, clientId, {})`, but the live executor
(`transport/policy-push/executor.ts`) **no-ops**: the link row is gone, so it
can't resolve the `linux_username` and there's nothing to recompute. Result: an
*unlinked* supervised account keeps whatever `timekpra` daily/weekly/monthly
limits and allowed-hours were last pushed — stale enforcement the dashboard no
longer manages.

## Decision — target state on unlink

Push a **fully-unrestricted** `timekpra` config (an explicit "unmanage"), not a
session-kill:

- per-weekday daily limit = `86400` (whole day) × 7,
- rolling weekly limit = `604800` (`86400 × 7`),
- rolling monthly limit = `2678400` (`86400 × 31`, the longest month so it never
  under-limits),
- allowed access = every weekday, all 24 hours (`{ start: 0, end: 1440 }` per
  ISO weekday → collapses to one `--setallowedhours USER ALL …`).

Rationale: Timekpr-nExT always tracks every user; there is no CLI "untrack". The
maximal-allowance config is the faithful representation of "the dashboard no
longer restricts this account". **Full lockout is a Phase-8c concern**
(zero daily limit / session-kill), explicitly *not* what unlink does.

This reuses the exact setter sequence the normal push already drives, so the
unmanage path is the same audited, idempotent, offline-queued code as every
other push — no new transport, no new boundary.

## Phases

### Phase 1 — capture the username before the link cascades away
- `policy/repository.ts`: `deleteLink` returns the removed `UserOnClientRow`
  (`| undefined`) instead of a bare boolean — it already uses `.returning()`, so
  this surfaces `linuxUsername`/`linuxUid` without a second query. Removal vs.
  not is still expressible (defined vs. undefined).
- `api/policy/routes.ts`: the DELETE link route captures the removed row, keeps
  its precise 404, and carries `{ linuxUsername, linuxUid }` in the
  `link.deleted` push detail (parity with the `link.upserted` detail).
- Update `tests/policy/repository.test.ts` for the richer return (still asserts
  removed-vs-not, plus the returned row content — a strengthening, not a
  weakening).

### Phase 2 — executor unmanage push
- `transport/policy-push/resolve.ts`: add `unrestrictedPolicyPush()` returning
  the maximal `ResolvedPolicyPush` described above (pure, no I/O).
- `transport/policy-push/executor.ts`: extract the 4-call push sequence (with the
  full-lockout allowed-hours skip) into a shared `applyResolvedPush(...)`. When
  the link is missing **and** the action is an explicit unlink
  (`reason === "link.deleted"` with a valid `linuxUsername` in `detail`), build
  the `timekpra` client with that captured username and `applyResolvedPush` the
  unrestricted config. Any *other* missing-link case (e.g. a user-scoped push
  for a user since unlinked) stays a no-op.
- Validate the carried username with a small zod schema before it crosses into
  the typed push (per `CLAUDE.md` — persisted queue rows are external-at-rest).

### Tests
- Executor: `link.deleted` with a username → pushes the unrestricted limits +
  all-hours-every-day grid (assert the exact setter calls/values); other
  missing-link reasons still no-op; missing/blank username → no-op; missing
  client → no-op.
- Route: DELETE link emits a `link.deleted` command carrying the username;
  unchanged 404 on a non-existent link.
- `resolve`: `unrestrictedPolicyPush()` shape (maximal limits, full week).

## License boundary

Unchanged — still exec-over-SSH of `timekpra` (GPL) as a subprocess via the
existing facade; no in-process linkage, no GPL binary added to the image,
no new dependency. `docs/architecture.md` → "Outbound — policy push" gains a
sentence on the unlink/unmanage behaviour.
