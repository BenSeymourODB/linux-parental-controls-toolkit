# Issue #302 — Structured per-budget warning-cadence editor

Roadmap: `docs/roadmap.md` → Phase 8b ("Admin UI under `/admin/notifications`").
Builds on #104 (NotificationPolicy contract) and #105 (the editor shell:
view/clear affordance already ships).

## Goal

Two halves:

1. **Pin the `cadenceOverrides` shape** — today it is a deliberately loose
   `Record<string, unknown>` (`null` => built-in 15/5/1-minute cadence, any
   non-null blob accepted). Give it a real zod schema, single-sourced in
   `server/src/policy/notification.ts` like `notificationGraceSecondsSchema`
   and the sound-profile bounds, so the storage `$type`, the API DTOs, and the
   frontend all read one source and can't drift.
2. **A structured editor** in `NotificationsView` to add / edit / remove
   per-budget warning thresholds, writing through the existing
   `PUT /api/users/:id/notification-policy`.

Semantics authority: `docs/client-notifications.md` -> "Notification cadence"
and "Configuration knobs".

## The pinned shape (decision)

**Key** — identifies the budget the override applies to. Budgets are keyed by
`(scope, target_id)` (`policy/schema.ts`), so the cadence key is:

- `"overall"` — the user's overall screen-time budget (`target_id` NULL).
- `"activity:<id>"` — a per-activity budget.
- `"group:<id>"` — a per-activity-group budget.

Grammar regex is built from `scopeValues` (single source). Keyed by
`(scope, target)`, not window: a cadence preference is naturally per-activity,
not per daily/weekly/monthly rollover — matching the doc's "no sub-5-minute
warnings for the homework activity" example. Per-window granularity, if ever
needed, is a grammar extension (follow-up), not a reshape.

**Value** — one budget's override:

    { warningMinutes: number[] }   // e.g. { warningMinutes: [15, 10, 5] }

`warningMinutes` is the explicit set of "minutes remaining" marks at which to
warn for that budget, replacing the built-in low-threshold set
`{15,10,5,4,3,2,1}`. Normalised to a de-duplicated, descending list. An empty
list means "no pre-expiry warnings for this budget" (only the 0:00 time's-up
toast). Bounds: integer minutes in `[1, 1440]`, <= 32 marks per budget, <= 64
overridden budgets per policy. Object (not bare array) so a later per-budget
knob (e.g. sound) can be added without a reshape.

Validation is format only — an override for a budget that does not (yet) exist
is inert (the agent applies overrides only for budgets it tracks), consistent
with the loose-map history and the DTO layer's no-cross-entity-refs posture.

## No migration

`cadence_overrides_json` is already a JSON text column; pinning the shape only
tightens the `$type` and the zod validators, so there is no drizzle migration
and no migration-collision surface. Pre-alpha: no real persisted override data.

## Phase 1 — Backend (pin the shape) — fully unit-verifiable here

- `server/src/policy/notification.ts`: constants
  (`WARNING_MINUTE_MIN/MAX`, `WARNING_MINUTES_MAX_COUNT`,
  `CADENCE_OVERRIDE_KEYS_MAX`, `DEFAULT_WARNING_MINUTES`); schemas
  (`warningMinuteSchema`, `budgetCadenceOverrideSchema` strict + dedup/desc
  transform, `budgetCadenceKeySchema` regex from `scopeValues`,
  `cadenceOverridesSchema` record + key-count refine); `CadenceOverrides` type
  + `budgetCadenceKey(scope, targetId)` helper; retype
  `NotificationPolicyValues.cadenceOverrides`.
- `server/src/policy/schema.ts`: `cadenceOverridesJson.$type<CadenceOverrides>`.
- `server/src/policy/repository.ts`: retype
  `NotificationPolicyUpsert.cadenceOverrides`.
- `server/src/api/policy/dtos.ts`: import `cadenceOverridesSchema` from
  `policy/notification.ts` (drop the local loose record); refresh the comment.
- Tests: new `server/tests/policy/notification.test.ts` (schema units); update
  `server/tests/api/policy-notification.test.ts` (pinned shape + 400-on-bad +
  normalisation round-trip). Legitimate contract change, not a weakening.

## Phase 2 — Frontend (structured editor) — build + component tests here

- `frontend/src/lib/api/contract.ts`: re-export `BudgetCadenceOverride` type.
- `frontend/src/lib/views/NotificationsView.svelte`: replace the read-only
  cadence section with an editor — editable rows (scope select; target-id input
  for activity/group; comma-separated warn-at-minutes), Add / Remove, a
  "Save cadence" action (own dirty+valid gate), and "Clear all"
  (`cadenceOverrides: null`). Client-side validation mirrors server bounds.
  Self-contained (no budgets/activities API call); a friendly budget-sourced
  picker is a follow-up (fits #343's combined editor).
- Update `frontend/tests/components/notifications-view.test.ts`.

## Phase 3 — Docs + finalise

- `docs/client-notifications.md`: short "Cadence override grammar" note.
- Full gate; frontend build + tests; draft PR; review subagent; mark ready.

## License boundary

Unchanged — plain TypeScript + zod + Fastify + type-only frontend consumption
of the JSON `/api`. No transport, no packaging, no Docker, no GPL surface.
