# Plan — #322 Admin UI: fleet-wide transport queue summary on the Dashboard

Issue: https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/322

## Goal

Give the admin an at-a-glance, fleet-wide view of the offline transport queue on
the Dashboard, so a stuck or dead-lettered policy push (a child's limit change
that never reached their machine) is visible without opening each client row.

## Approach

Follow the issue's **preferred** implementation: a dedicated cheap aggregation
endpoint rather than client-side summing of full per-client health.

### Phase 1 — Backend (`GET /api/system/queue-summary`)

- `transport/queue/repository.ts`: add `QueueSummary { pending; failed;
  oldestPendingAt: Date | null }` + `queueSummary(db)`:
  - one grouped `COUNT(*) GROUP BY status` read (uses the existing
    `transport_queue_client_status_id_idx`), mapped to `pending` / `failed`;
  - oldest pending via a typed `enqueuedAt` select ordered ascending, `limit 1`
    (Drizzle returns a `Date`, so no raw epoch handling). `null` when none.
- Export both from `transport/queue/index.ts`.
- `api/system/dtos.ts`: `queueSummaryResponseSchema` (`pending`, `failed`
  non-negative ints; `oldestPendingAt` ISO string | null) + inferred
  `QueueSummaryResponse` + `toQueueSummaryResponse(summary)` mapper (Date →
  ISO). Single conversion point, mirroring the existing DTO mappers.
- `api/system/routes.ts`: `GET /system/queue-summary`, `requireAdmin`, reads
  `scope.db`.
- Tests:
  - `tests/transport/queue/repository.test.ts`: empty -> `{0,0,null}`; mixed
    pending/failed counts; `oldestPendingAt` is the earliest **pending** row's
    `enqueuedAt` (a later-enqueued failed row does not win); across clients.
  - `tests/api/system-queue-summary.test.ts`: 401 anonymous; empty summary for
    admin; seeded pending+failed -> correct counts + ISO oldest.

### Phase 2 — Frontend (`QueueSummaryWidget` on `DashboardView`)

- `contract.ts`: re-export `QueueSummaryResponse` (type-only).
- `lib/api/system.ts`: `fetchQueueSummary()` -> `GET /system/queue-summary`.
- `lib/components/QueueSummaryWidget.svelte`: loads once on mount (no polling);
  renders pending + failed counts and oldest-pending age; calm green
  "All actions delivered" when both zero; **red** failed count whenever
  `failed > 0` (never suppressed); oldest-age line only when `pending > 0`;
  a "View clients ->" button calling `onnavigate("clients")`; a shimmer skeleton
  while loading and a red error pill if the fetch fails.
- `lib/views/DashboardView.svelte`: render the widget, forwarding `onnavigate`.
- Tests:
  - `tests/api/system.test.ts`: `fetchQueueSummary` GETs `/api/system/queue-summary`.
  - `tests/components/queue-summary-widget.test.ts`: calm zero state; failed>0
    red; oldest-age shown when pending>0; "View clients" navigates; fetch-error
    surfaces.

## License boundary

N/A — plain TypeScript + zod + Drizzle read + Svelte over the existing `/api`
JSON contract. No GPL import, no subprocess/REST boundary touched, no image
change, no new dependency.

## Out of scope / deferred

- Background polling / live refresh (issue: "counts fresh on load; no polling").
- Per-client drill-down detail (already exists in the Clients view).
