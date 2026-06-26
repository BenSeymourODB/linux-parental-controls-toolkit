# Issue #105 — Admin UI: `/admin/notifications`

Roadmap: `docs/roadmap.md` → Phase 8b ("Admin UI under `/admin/notifications`").

## Goal

The `/admin` surface for editing each user's `NotificationPolicy`: master
enable/disable, sound profile (`off`/`subtle`/`prominent`), and grace-period
override (0–60s). The backend already ships the full contract — this PR is the
consuming UI only.

## What already exists (no backend work needed)

- API routes (`src/api/policy/routes.ts`, #104):
  - `GET    /api/users/:userId/notification-policy` → always returns a
    `NotificationPolicyResponse` (persisted row, or the documented defaults when
    none is stored — every user always *has* an effective policy).
  - `PUT    /api/users/:userId/notification-policy` → upsert; partial body, at
    least one field; fans out `notification.upserted` push.
  - `DELETE /api/users/:userId/notification-policy` → revert to defaults (204);
    404 when already at defaults.
- DTOs (`src/api/policy/dtos.ts`): `notificationPolicyResponseSchema`,
  `upsertNotificationPolicySchema`, `NotificationPolicyResponse`,
  `UpsertNotificationPolicyRequest`.
- Bounds/enums single-sourced in `src/policy/notification.ts` +
  `src/policy/enums.ts` (`soundProfileValues`, `GRACE_SECONDS_MIN/MAX`,
  defaults).

## Deliverables

1. `frontend/src/lib/api/notifications.ts` — typed wrappers over the three
   endpoints (`getNotificationPolicy`, `upsertNotificationPolicy`,
   `deleteNotificationPolicy`), same shape as `$lib/api/budgets`.
2. `frontend/src/lib/api/contract.ts` — re-export `NotificationPolicyResponse` +
   `UpsertNotificationPolicyRequest` (from `api/policy/dtos`) and the
   `SoundProfile` enum type (from `policy/enums`, alongside `Scope`/`ScheduleAction`).
3. `frontend/src/lib/views/NotificationsView.svelte` — pick a user, load their
   effective policy, edit `enabled` / `soundProfile` / `graceSeconds`, **Save**
   (PUT), and **Reset to defaults** (DELETE). Surfaces whether the user has
   custom per-budget cadence overrides and offers "clear" (PUT
   `cadenceOverrides: null`); a structured per-budget cadence editor is out of
   scope (see Deferred).
4. Wire into `routes/admin/+page.svelte`: nav item `notifications` + the
   `{#if activeView === "notifications"}` branch.
5. Tests:
   - `frontend/tests/api/notifications.test.ts` — URL/method/body of each wrapper
     (mirrors `tests/api/budgets.test.ts`).
   - `frontend/tests/components/notifications-view.test.ts` — load/edit/save/reset
     flow, grace-bound gating, empty-state when no users (mirrors
     `tests/components/budgets-view.test.ts`).

## Cadence overrides — scoped to "view + clear"

`cadenceOverrides` is a deliberately loose `Record<string, unknown>` (`null` =
the built-in 15/5/1-minute cadence). Its per-budget structure is not pinned by
any schema, so a structured editor would need its own design. This PR therefore
**surfaces** whether overrides exist and lets the admin clear them, and defers a
structured per-budget cadence editor to a follow-up issue linked from the PR.

## Validation / boundaries

- Local gate from `server/`: format / lint / typecheck / unit+coverage.
- Frontend build the CI way: `cd server/frontend && npm ci && npm run build`.
- License boundary: untouched — type-only consumption of the existing JSON `/api`
  (`CLAUDE.md` → "License boundaries"). No transport/packaging/Docker changes.
