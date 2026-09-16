# Plan — #110 App (PWA): per-child status screen

**Roadmap:** Phase 9 (PWA / `/app`). **Depends on:** #112 per-user PIN auth
(merged — `api/app/*`, `auth/pin-session.ts`, `requirePinSession`,
`GET /api/app/me`). **Reused by:** Phase 12 "My Time" client dashboard (#61) —
keep the payload and the render component reusable.

## Goal

The PIN-scoped `/app` status screen a supervised user sees after logging in:
how much overall time is left today, what's been used, their per-activity
limits, and the next schedule transition — all in their effective timezone,
non-punitive framing (`design/app/child-status.html`, `design/README.md`).

## Deliberately deferred (tracked)

- **Recent grants / rewards strip** (the "🎁 +30 min for cleaning your room"
  card and the "earn more time" CTA). The immutable `Grant` ledger is Phase 10
  (#113 endpoint, #116 ledger UI, #117 recompute). The `grants` **table**
  exists (the resolver reads it) but there is no creation path or display
  contract yet. The status payload is shaped so a `rewards` field can be added
  additively later without a breaking change. Out of this slice.
- **"No limit" activity rows** (design shows `School ∞`). This slice's
  "My limits today" list is exactly the *budgeted* set (the resolver's
  `perActivitySeconds`), which is the honest, enforceable list. Surfacing
  unbudgeted-but-used activities is a follow-up.
- **Schedule / Rewards tabs** — shell tabs stay inert (#109); only "My time"
  lands here.

## Design decisions

- **One scoped read, deny-by-default.** New `GET /api/app/status`, gated by
  `scope.requirePinSession`, scoped strictly to `request.pinUser.userId` —
  never a caller-supplied id, exactly like `GET /api/app/me`. No admin route
  is touched; the PIN session reaches only this allowlisted read.
- **Thin route over pure resolvers.** The handler composes what already exists
  (mirrors `api/usage/routes.ts` and `api/policy/effective.ts`):
  - effective tz via `resolveEffectiveTz(user.tz, settings.defaultTz)` (ADR 0001);
  - today's effective policy via `effectivePolicy({ date, tz, schedules,
    budgets, grants, exceptions })` using the `gatherUser*` loaders +
    `grants` rows — giving grant-adjusted, weekday-varying `overallSeconds`
    and `perActivitySeconds`, plus `allowedWindows`;
  - today's consumption via `usageByActivityInWindow` (overall = Σ) and
    `groupSecondsInWindow` for group targets — same one-pass rollup the admin
    burndown uses.
- **Time left = effective quota − consumed**, clamped at 0; `null` remaining
  when the quota is `null` (no limit — unlimited base makes a grant moot).
- **Next transition is wall-clock.** A schedule boundary ("bedtime at 21:00")
  is inherently a local wall-clock concept, so it is transmitted as
  `{ kind, localDate, atMinuteOfDay }` (the client formats `21:00`), not a UTC
  instant — the client renders wall-clock in tz, faithful to ADR 0001's
  intent. Computed by a **pure, unit-tested** helper
  `policy/next-transition.ts` over the resolver's `allowedWindows`:
  - inside an allowed window that is not the whole day → `access_ends` at that
    window's `end`;
  - in a gap before a later window today → `access_resumes` at that window's
    `start`;
  - no boundary left today → resolve *tomorrow's* effective policy and report
    `access_resumes` at tomorrow's first window `start` (matches the mockup's
    "turns back on tomorrow at 11:00"); if tomorrow is unrestricted or fully
    denied with no window, `null`.

## Payload (`AppStatusResponse`)

```
user: { id, displayName }
tz: string
now: string (ISO)            // server clock, for the client's "resets at midnight"
date: string (YYYY-MM-DD)    // today, local
overall: {
  allowedSeconds: number | null
  consumedSeconds: number
  remainingSeconds: number | null
}
activities: Array<{
  scope: "activity" | "group"
  targetId: number
  label: string              // group name, or activity matcher
  activityKind: string | null  // activity kind (app/domain/…); null for group
  allowedSeconds: number
  consumedSeconds: number
  remainingSeconds: number
}>
access: {
  allowedNow: boolean
  nextTransition: {
    kind: "access_ends" | "access_resumes"
    localDate: string        // YYYY-MM-DD
    atMinuteOfDay: number     // 0..1440
  } | null
}
```

## Phases

1. **Server.** `policy/next-transition.ts` (pure) + unit tests;
   `AppStatusResponse` zod DTO in `api/app/dtos.ts` + re-export from `api/index.ts`;
   `GET /api/app/status` in `api/app/routes.ts`; API tests (scoping, empty
   policy, budgets+usage, next-transition today/tomorrow). Full server gate.
2. **Frontend.** `$lib/api/app-status.ts` client; contract re-export;
   `StatusView.svelte` (time-left ring + "My limits today" + next-transition
   banner, non-punitive copy) rendered into the signed-in branch of
   `routes/app/+page.svelte`; component test; `svelte-check` + build.

## License boundary

None touched — plain TypeScript + zod + Drizzle on the server, Svelte over the
same-origin JSON API on the client. No subprocess/REST/GPL boundary involved.
