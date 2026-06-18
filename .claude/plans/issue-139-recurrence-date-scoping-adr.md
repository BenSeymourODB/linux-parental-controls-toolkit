# Plan — #139: ADR for recurrence + date-scoping model

Phase 2 gating decision. Deliverable is an ADR (plus a pointer from
`docs/architecture.md`), **not** schema/code — the schema reservation is the
separate, blocked-on-this issue #146, and the resolver/UI are Phase 4 (#143/#140)
and Phase 13 (#141/#142).

## Constraints / grounding

- ADR slot `0004` is already taken (`0004-schedule-precedence.md`, #63), so this
  lands as **ADR 0005**. The roadmap's `0004-recurrence-and-date-scoping.md`
  reference is stale and must be fixed.
- Must align with: ADR 0001 (UTC-everywhere storage; effective-TZ window
  boundaries), ADR 0003 (pin in-flight window to TZ when it opened), ADR 0004
  (first-match-wins precedence; the "is this rule active at instant T?" predicate
  is injected and the grammar was explicitly deferred — this ADR defines it).
- Must align with the landed schema (`server/src/policy/schema.ts`,
  `policy/enums.ts`): `schedules.cron_or_window` (free-text, no grammar),
  `exceptions.expires_at` (UTC, NOT NULL), polymorphic `target_id`, CHECK-based
  coherence idioms.

## Decisions to record (from #139's five questions)

1. **Recurrence grammar** — purpose-built day-of-week + intra-day window struct,
   stored as discrete CHECK-constrainable columns (ISO weekday bitmask +
   start/end minutes-of-day), **not** cron or RRULE. NULL ⇒ always-on.
2. **Date anchoring** — nullable `effective_from`/`effective_to` (UTC instants,
   matching ADR 0001) on `schedules`; on `exceptions` add `effective_from` and
   reuse the existing `expires_at` as the effective end (no redundant column).
3. **Resolve vs materialize** — rule-based on-the-fly resolution; materialization
   reserved as an optional cache only.
4. **Retention interaction** — rule-based ⇒ retention (#135) purges only *dated*
   rows, never the recurrence rules.
5. **Timezone** — recurrence weekday/time and date gates resolved in the user's
   effective TZ (ADR 0001/0003).

Also define how recurrence + date-anchor compose with ADR 0004 precedence (this
ADR supplies the previously-deferred "active at instant T" predicate).

## Steps

1. Write `docs/adr/0005-recurrence-and-date-scoping.md` (Status: Accepted).
2. Add a short "Recurrence and date-scoping" note to `docs/architecture.md` →
   Policy model, and annotate the `Schedule`/`Exception` sketch.
3. Fix the stale `0004-recurrence-and-date-scoping.md` reference in
   `docs/roadmap.md` → `0005-recurrence-and-date-scoping.md`.
4. Quality gate: docs-only, so no server code changes; confirm `npm test` still
   green (no code touched) is unaffected — the change is Markdown only.

## Out of scope (deferred, already tracked)

- Schema column reservation + migration + zod DTOs → #146.
- Resolution engine + preview API → #143; recurring DoW windows enforcement →
  #140. Weekday-varying budgets → #141; date-specific overrides → #142.
