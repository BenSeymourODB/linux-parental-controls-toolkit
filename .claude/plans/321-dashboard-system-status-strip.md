# Plan — #321 Admin UI: system-service status strip on the Dashboard view

Roadmap: no explicit phase label; admin-observability polish supporting the
Alpha-1 "is everything still healthy?" ambient signal. Frontend-only.

## Goal

A compact status row near the top of `DashboardView` showing the health of the
two server-side services the dashboard orchestrates — the **Ansible venv** and
**managed AdGuard Home** — each as a colour-coded pill that surfaces its
`detail` on hover/click.

Both backend APIs already exist and are `requireAdmin`-gated:

- `GET /api/system/ansible` → `AnsibleVenvStatusResponse`
  (`state: idle|bootstrapping|ready|unavailable`, `checkedAt`, `detail`).
- `GET /api/system/adguard-managed` → `AdGuardManagedStatusResponse`
  (`enabled`, `state: idle|fetching|starting|running|stopped|failed | null`,
  `version`, `restarts`, `checkedAt`, `detail`).

So this is **frontend-only** — no server changes.

## State → colour mapping

Ansible venv:
- `ready` → green
- `bootstrapping`, `idle` → amber (in-progress)
- `unavailable` → red

AdGuard Home (only when `enabled: true`; `enabled: false` → pill hidden, not grey):
- `running` → green
- `fetching`, `starting`, `idle` → amber (in-progress)
- `stopped`, `failed` → red
- `state === null` (defensive) → amber "unknown"

A failed fetch of either endpoint → red pill for that service with the error as
its detail (so a broken API is visible, not silently blank).

## Phases

### Phase 1 — API plumbing + component + tests
- `lib/api/system.ts`: add `fetchAdGuardManagedStatus()` alongside
  `fetchAnsibleStatus()`.
- `lib/api/contract.ts`: re-export `AdGuardManagedStatusResponse` (type-only,
  same pattern as `AnsibleVenvStatusResponse`).
- New `lib/components/SystemStatusStrip.svelte`: self-contained (loads both
  statuses on mount, no polling), renders pills with the mapping above.
  - Green pills are static; non-green pills are `<button>`s that (a) carry a
    `title` for hover and (b) toggle an inline `.detail` paragraph on click.
  - AdGuard `restarts` appended to detail when non-zero.
  - AdGuard pill omitted entirely when `!enabled`.
  - Skeleton row while first load is in flight (no flicker / no broken empty
    row); if both services resolve to hidden/no-data, render nothing.
- `tests/components/system-status-strip.test.ts` mirroring the
  `tests/components/*` pattern (mock `$lib/api/system`), covering: green/amber/
  red Ansible; AdGuard running(green)/failed(red, detail+restarts); AdGuard
  hidden when disabled; detail expand on click; fetch-failure → red.

### Phase 2 — wire into DashboardView + finalise
- Render `<SystemStatusStrip />` as the first child of the Dashboard section.
- Full quality gate (frontend `svelte-check` + `test`, production build) green;
  server gate untouched (no server changes).

## Out of scope
- Background polling / auto-refresh (issue: "no background polling required").
- A system-settings page or per-service drill-down beyond the `detail` surface.
- Any new backend endpoint (#322's queue-summary is a separate issue).
