# Plan — #214: Admin UI retention windows editor

Roadmap: `docs/roadmap.md` → Phase 11 (epic #135). Follow-up to #136 (retention
backend: config model, `isExpired`, and the `/api/retention` CRUD — already on
`main`).

## Goal

A `/admin` surface for viewing and adjusting data-retention windows, consuming
the `/api/retention` contract shipped in #136. Frontend-only; no server or
transport change, no license/tamper surface (type-only `/api` consumption).

## Backend contract (already on `main`)

`server/src/api/retention/` — DTOs re-exported from the `api/` barrel:

- `GET /api/retention` → `RetentionConfigResponse`
  `{ defaultDays: number, categories: RetentionEntryResponse[] }`.
- `PUT /api/retention/:category` (body `SetRetentionOverrideRequest`, a
  discriminated union on `keepForever`: `{ keepForever: true }` or
  `{ keepForever: false, days: 1..MAX_RETENTION_DAYS }`) → the resulting
  `override` entry.
- `DELETE /api/retention/:category` → the resulting default-inherited entry
  (idempotent — clearing a non-overridden category is a no-op).

`RetentionEntryResponse = { category, source: "default"|"override",
keepForever, days: number|null, updatedAt: string|null }`.

Categories (`retentionCategoryValues`, declaration order): `usage_samples`,
`grant_ledger`, `audit_log`, `date_overrides`.

The global default comes from the environment (`PCT_RETENTION_DEFAULT_DAYS`);
only per-category overrides are persisted → the default is **read-only** in the
UI, with a "restart to change" note.

## Deliverables

1. `contract.ts` — add the retention DTO type re-exports (from
   `../../../../src/api/retention/dtos.js`) and the `RetentionCategory` enum
   type (from `policy/enums.js`). Type-only, per the contract module's rule.
2. `$lib/api/retention.ts` — thin typed wrappers over `apiFetch`
   (`fetchRetention`, `setRetentionOverride`, `clearRetentionOverride`),
   mirroring `$lib/api/integration-tokens.ts`.
3. `RetentionView.svelte` — mirrors the `IntegrationTokensView` shape:
   - Loads config on mount (browser-guarded), inline `role="alert"` error,
     loading + empty states.
   - Read-only global-default banner (env-configured note).
   - One row per category: human label + description, effective window
     ("Kept forever" | "N days"), a source badge (inherited default vs
     override).
   - Per-row edit controls: mode select (Custom window | Keep forever), a
     bounded day input (enabled only for Custom), a **Save override** (PUT)
     button, and a **Clear override** (DELETE) button enabled only when the
     row is currently an override. Per-row in-flight state so only the acting
     row shows progress; success replaces just that row's entry from the
     response.
4. Nav + view wiring in `routes/admin/+page.svelte` (`{ id: "retention",
   label: "Data retention" }` + an `{:else if activeView === "retention"}`
   branch).

## Tests (mirroring existing conventions)

- `tests/api/retention.test.ts` — URL/method/body assertions over a mocked
  `fetch` (GET, PUT custom, PUT keep-forever, DELETE), like
  `tests/api/integration-tokens.test.ts`.
- `tests/components/retention-view.test.ts` — render the real component against
  a mocked `$lib/api/retention`: renders categories, marks
  override-vs-inherited, saves a custom override, saves keep-forever, clears an
  override, and surfaces an `ApiError` inline; like
  `tests/components/integration-tokens-view-crud.test.ts`.

## Gates

- `cd server/frontend && npm run check` (svelte-check 0/0), `npm test` (vitest),
  `npm run build` (vite build OK).
- Server gate unchanged (no server src touched) — but run
  `format:check`/`lint`/`typecheck`/`test` from `server/` to confirm green.

## Out of scope / deferred

- Editing the global default in the UI (it is environment-configured — shown
  read-only). No new issue needed; documented behaviour from #136.
- Wiring a live "next purge run" indicator (the scheduled purge job #137 is a
  separate roadmap item); this editor only manages the windows.
