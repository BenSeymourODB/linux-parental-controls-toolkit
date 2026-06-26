# Plan: Smoke/e2e coverage for the logic-heavy admin editors (#266)

Roadmap: `docs/roadmap.md` → Phase 2. Follow-up to #53 / #265.

## Goal

Add headless component smoke tests for the admin editors whose **client-side
logic goes beyond the CRUD skeleton** (`UsersView`/`ClientsView`/`ActivitiesView`
are already covered by #265). Each suite mocks the relevant `$lib/api/*`
wrapper(s), renders the real `.svelte` view in `jsdom`, drives the flow, and
asserts on rendered output + the API calls made. No live backend, no new
dependency, no Playwright.

## Scope (this run)

Per the claim comment on #266, cover the editors **stable on `main`**:

- [ ] **BudgetsView** — minutes↔seconds conversion/parse, `Xh Ym` allowance
  formatting, conditional scope→target picker (activity vs group vs overall,
  clears stale target on scope change), `createDisabled` multi-field gating,
  inline edit (window + allowance only).
- [ ] **ExceptionsView** — `datetime-local` ↔ ISO conversion, `datesInvalid`
  (expiry-after-start) warning + create gating, conditional target picker,
  inline edit of action/reason/expiry.
- [ ] **ActivityGroupsView** — lazy membership load on expand (`toggleMembers`),
  add/remove member, `candidates` filtering (excludes existing members),
  collapse on re-toggle.
- [ ] **ClientHealthView** — enrol-token mint form: add/remove supervised-user
  rows, `enrolReady` validation (every row complete + distinct usernames),
  install-command generation from the minted token + origin, clipboard copy,
  collapsible per-client queue, reachability/component rendering.
- [ ] **AuditLogView** — cursor pagination (`load older` appends, `hasMore`
  from `nextCursor`), client-id filter parse (blank/invalid → omitted), outcome
  filter, empty state.
- [ ] **LinksView** — two-level user→links state (select user loads links),
  `osUserRef` charset validation, `candidateClients` filtering out
  already-linked clients, upsert replace-vs-append, delete.

## Deferred (stays on #266)

- **SchedulesView** — actively reworked in #63 / PR #269 (drag/keyboard reorder,
  "in effect now" badge, shadow warnings). Writing tests against the current DOM
  would collide with that rework; its smoke coverage should land alongside the
  #63 editor change. Box left unchecked.

## Conventions

Mirror `tests/components/users-view-crud.test.ts`:
`vi.mock("$lib/api/<module>")`, dynamic `await import` of the view after the
mock, typed `vi.fn`, fixture factories, `beforeEach` reset + `afterEach`
`restoreAllMocks`. Assert via Testing-Library queries (roles, labels) and on the
mocked call arguments.

## Validation

From `server/frontend/`: `npm test` (svelte-kit sync + vitest, both projects),
then `npm run check` and the root `server` lint/format gate as applicable.
