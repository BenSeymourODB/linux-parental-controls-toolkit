# Plan — #281 future-dated save-and-push preview (`?date=` / `now`)

Roadmap: `docs/roadmap.md` → Phase 4 (save-and-push preview; the last non-Ansible
bullet of the #281 umbrella). Builds on #64 (preview backend), and now-landed
#141 (weekday-varying budgets, PR #408) + #142 (date-specific overrides, PR #398).

## Goal

Let an admin preview the save-and-push diff **as it resolves on a chosen future
date**, not only "now". The endpoint already accepts an optional `now` reference
instant; this slice adds a timezone-correct calendar-date selector on top and
surfaces it in `/admin`.

## Why it is now meaningful

`transport/policy-push/resolve.ts` (`resolvePolicyPush`) uses the reference
instant only to pick the **reference week** for the recurring allowed-hours grid
(`resolveWeeklyAllowedWindows` → `effectivePolicy`, whose `appliesOnDay` applies
the `effective_from`/`effective_to` **date gate** on schedule rules). So a
**date-scoped schedule rule** that is dormant today but active in a future week
changes the future-dated preview. `perWeekdaySeconds` is weekday-based
(date-invariant), which is correct — there is no date-specific *budget* override
(an additive time amount is a `Grant`, not a schedule rule; Exceptions carry no
seconds).

**Faithful to the push.** `resolvePolicyPush` deliberately does *not* compose
one-off Exceptions (#142) into the pushed allowed-hours grid — pushing an
exception override to the client is its own path (#399, PR #420). The preview
mirrors the recurring push, so it too excludes Exceptions and reflects only the
recurring layer's date gate. Composing Exceptions into the preview but not the
push would make the preview lie about what the recurring push sends.

## Design

### Backend (`server/src/api/policy/`)

- `preview-dtos.ts`: add an optional `date` (`z.iso.date()`, `YYYY-MM-DD`) to
  `policyPreviewRequestSchema`. Document precedence: `date` > `now` > current
  time. `date` is the admin-facing calendar selection; `now` stays the
  instant-precise seam for tests.
- `preview-routes.ts`: replace the inline `now` parse with a
  `referenceInstant(body, tz)` helper. When `date` is set, resolve it to a
  reference instant at **local noon** of that date in the user's *effective*
  timezone — `localDayBounds(y, m, d, tz).start + 12h` — so the reference week is
  selected correctly at week boundaries regardless of the caller's clock (noon is
  ~12h from either local-midnight edge, DST-safe). Endpoint stays side-effect-free.

The date→instant conversion lives on the **server**, which owns tz resolution
(`resolveEffectiveTz(user.tz, settings.defaultTz)`); the client only sends the
picked calendar date.

### Frontend (`server/frontend/src/lib/views/PolicyPreviewView.svelte`)

- A "Preview as of" `<input type="date">`. Empty ⇒ omit `date` (today). Set ⇒
  pass `date` in the preview request and show an "as of <date>" context note near
  the change header. Clearing returns to today.
- Reuses the existing debounced `runPreview` path; the date is part of the
  proposed request, so a date change re-previews like any other edit.

## Tests

- `server/tests/api/policy-preview.test.ts`:
  - a date-scoped schedule rule (`effectiveFrom`/`effectiveTo` bounding a future
    week) yields **no** allowed-hours diff for "today" but **does** for a `date`
    inside its window;
  - `date` is timezone-correct (a non-UTC user's week boundary picks the right
    week);
  - `date` takes precedence over `now`;
  - a malformed `date` (`2026-13-40`, or a datetime) is a 400.
- `server/frontend/tests/components/policy-preview-view.test.ts`: selecting a
  date re-requests with `date` in the proposed payload; clearing drops it.

## Deferred (remains on the #281 umbrella)

- **Ansible-side filter diff** (e2guardian / iptables) — Phase 6 (#90); nothing
  to diff against on `main` yet.

## Quality gate

`cd server`: `npm run format` · `npm run lint:fix` · `npm run typecheck` ·
`npm test`; then `cd server/frontend && npm ci && npm run build` +
`npm run test` (component). No new dependency; no transport/packaging/Docker
change → license-guard unaffected.
