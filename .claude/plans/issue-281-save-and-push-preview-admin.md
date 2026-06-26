# Plan — #281 Save-and-push preview: `/admin` rendering

Roadmap: `docs/roadmap.md` → Phase 4 (SSH + `timekpra` transport).
Issue: #281 (follow-up to #64, which landed the preview **backend**).

## What exists on `main` (don't rebuild)

- `POST /api/users/:userId/policy-preview` — side-effect-free. Body is the
  **proposed** policy (`{ budgets: BudgetResponse[], schedules: ScheduleResponse[], now? }`,
  the same DTOs the editor already holds). Response:
  `{ userId, hasChanges, changes: PolicyPushChange[], affectedClients: PreviewAffectedClient[] }`
  (`server/src/api/policy/preview-{dtos,routes}.ts`).
- The diff engine (`transport/policy-push/{resolve,diff}.ts`) covers
  daily-overall / weekly / monthly overall limits + the recurring allowed-hours
  grid. Per-activity budgets and group schedules are deliberately **not** pushed
  yet, so they don't appear in the diff.
- Frontend admin SPA: single prerendered page (`routes/admin/+page.svelte`) that
  switches `*View.svelte` components by `activeView`. Typed `$lib/api/*`
  wrappers over `apiFetch`; DTO types re-exported from `$lib/api/contract.ts`.

## Scope of THIS slice (the only deliverable)

The visible **save-and-push preview** surface that consumes the preview
contract — a new `PolicyPreviewView`:

1. Admin selects a user.
2. View loads the user's persisted overall budgets + schedules into editable
   **proposed** state (a "what-if" sandbox — it never persists).
3. Editable knobs that actually move the diff:
   - overall daily / weekly / monthly budget **durations** (minutes), the
     common edit;
   - per-schedule **include toggle** ("preview removing this rule") so the
     allowed-hours diff path is reachable from the UI.
   (Full budget/schedule **authoring** stays in the existing CRUD views and
   #63/#140 — out of scope here.)
4. Calls `previewPolicyPush(userId, { budgets, schedules })` (debounced on
   change) and renders the **push bar** from `design/admin/policy-editor.html`:
   - change rows: kind badge (added/removed/changed), `before → after`,
     weekday chip, summary;
   - a "no pending changes" state when `hasChanges` is false;
   - affected clients: hostname, last-seen (relative), pending-queue depth;
   - the fidelity note ("session limits push via SSH + timekpra; filter/group
     changes via Ansible — Phase 6").

**Preview only — no "Save & push now" button.** Preview is side-effect-free and
there is no UI-facing push endpoint yet; saving/pushing stays in the existing
CRUD views. The bar is labelled as a preview. (Noted as deferred in the PR.)

## Deferred (tracked, linked from the PR)

- **Live-reachability probe** (online/offline marker) → file a focused
  follow-up issue, link it.
- **Future-dated preview (`?date=`)** → meaningful only once #142 / #141 land in
  the resolver; tracked there. The endpoint already accepts `now`.
- **Ansible-side diff** (e2guardian / iptables) → Phase 6 (#90, PR #217).
- **Wiring the bar into the live per-user budget/schedule editors** (so an
  in-progress edit previews inline) → composes with #63/#189; this slice ships
  the standalone preview surface + the reusable bar.

## Phases

### Phase 1 — API client + contract types (+ tests)
- `server/frontend/src/lib/api/contract.ts`: re-export `PolicyPreviewRequest`,
  `PolicyPreviewResponse`, `PreviewAffectedClient` from
  `src/api/policy/preview-dtos.ts` (type-only, like every other DTO).
- `server/frontend/src/lib/api/policy-preview.ts`: `previewPolicyPush(userId, body)`
  → `apiFetch<PolicyPreviewResponse>("/users/:id/policy-preview", POST)`.
- `server/frontend/tests/api/policy-preview.test.ts`: URL/method/body + 404.

### Phase 2 — `PolicyPreviewView` + nav wiring (+ tests)
- `server/frontend/src/lib/views/PolicyPreviewView.svelte`.
- Register in `routes/admin/+page.svelte` nav (`{ id: "policy-preview",
  label: "Policy preview" }`) + the view switch.
- `server/frontend/tests/components/policy-preview-view.test.ts`: user select →
  load → render change rows + affected clients; no-user / no-changes / error
  states; toggling a schedule re-previews; minutes edit re-previews.

### Phase 3 — finalize
- `cd server/frontend && npm run check && npm test && npm run build`.
- Server gate from `server/` (format:check, lint, typecheck, test) — no server
  code changed, so it stays green; run it to be sure.
- Draft PR (Part of #281), screenshots of the preview surface, mark ready,
  subagent review, address comments.

## Guardrails
- License boundary: **N/A** — frontend only, JSON-API-only, type-only DTO
  re-exports (erased at build). No GPL surface, no transport/packaging change.
- No new deps. Mirror the proven `*-view` + `tests/{api,components}` patterns.
