# Plan — #304: a UI-facing "push saved policy now" action

**Issue:** #304 (Phase 4). Follow-up to #281/PR #299, which shipped the
side-effect-free save-and-push **preview** bar (`PolicyPreviewView`). Two
pieces were deferred: (a) inline placement in a combined per-user editor, and
(b) a "Save & push now" action wired through the Phase-4 transport + offline
queue.

Per the #124 audit comment's merge order, (a) is **subsumed by #343** (the
combined Policy view). This run delivers (b): the on-demand push lever.

## The gap this fills

There is **no UI-facing push endpoint today**. Policy pushes happen only as a
fire-and-forget CRUD side effect (`registerPolicyRoutes` -> `pushStub.push` ->
`createPolicyPushDispatcher` -> `pushOrEnqueue`) or via the scheduled
offline-queue drainer. An admin cannot deliberately re-push a user's current
policy and see what happened per client (e.g. force a re-sync to a client that
was offline when the last edit landed, or confirm delivery).

## Scope decision (non-destructive)

The what-if sandbox in `PolicyPreviewView` stays **preview-only**. The button
pushes the user's **currently saved** effective policy - it does **not** persist
the sandbox's what-if edits. Persist-then-push from a real editor (mapping edits
-> CRUD then push) belongs to #343's combined editor, where authoring/persisting
actually lives; persisting from a read-only what-if surface would be surprising
and destructive. Documented in the PR and linked to #343.

Because a standing policy push sends **idempotent absolute** limits (unlike the
additive `--settimeleft` of the time-today lever), it is safe to route an
unreachable client's re-push through the offline queue for replay - so a
per-client result of `queued` is meaningful here, not just `unreachable`.

## Pattern to mirror

`POST /api/users/:userId/time-today` (`api/policy/time-today.ts` +
`transport/time-today/adjust.ts`) is the established awaitable transport-lever:
`requireAdmin`; `404` unknown user; `409` user with no links; `503` when no
transport is injected (dev/CI/pre-#39-keygen); per-client result array. We
mirror its shape and its bootstrap/plugin/app.ts injection wiring.

## Phase 1 - backend

1. `server/src/transport/policy-push/push-now.ts` - new module:
   `pushUserPolicyNow(db, executor, { userId, clientId? })` resolves the user's
   links (or the one requested `clientId`), builds a `PolicyPushCommand`
   (`reason: "user.updated"`, `detail: { trigger: "manual.push-now" }`) per
   client, maps via `queuedActionFromPolicyPush`, and runs
   `pushOrEnqueue(db, action, executor)`. Collects a per-client result
   (`pushed | queued | failed`, `error?`). Targeting errors (unknown `clientId`,
   no links) throw `PushNowTargetError`; a per-client push failure never throws.
2. `server/src/api/policy/dtos.ts` - `pushPolicyRequestSchema` (optional
   `clientId`), `clientPushResultSchema`, `pushPolicyResponseSchema` + types.
3. `server/src/api/policy/push-now.ts` - `registerPushNowRoutes(scope,
   pushPolicyNow?)`: `POST /users/:userId/policy-push`, 404/503/409 mapping.
4. Wiring: `PolicyPushTransport.pushPolicyNow?` built in the live branch of
   `createPolicyPushTransport`; threaded through `web/app.ts` -> `registerApi`
   -> `apiPlugin` opts -> `registerPushNowRoutes`.
5. Tests: `tests/transport/policy-push/push-now.test.ts` and
   `tests/api/policy-push-now.test.ts`.

## Phase 2 - frontend

1. `lib/api/policy-preview.ts` - add `pushPolicyNow(userId, clientId?)`.
2. `lib/api/contract.ts` - re-export `PushPolicyResponse`, `ClientPushResultDto`.
3. `lib/views/PolicyPreviewView.svelte` - a "Push saved policy now" button +
   per-client `pushed/queued/failed` rendering; disabled while pushing / no
   linked clients / no transport (503 surfaced).
4. Tests in `tests/components/policy-preview-view.test.ts`.

## License boundary

None touched - plain TypeScript + zod over the existing executor, which execs
`timekpra` over the SSH subprocess facade. No GPL import, no boundary collapsed,
no image change, no new dependency. Audit log + offline queue come for free.

## Deferred (tracked)

- Inline placement in the combined per-user editor + persist-then-push -> #343.
