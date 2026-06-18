# Issue #146 — Reserve recurrence + date-scoping columns (Phase 2)

**Roadmap:** Phase 2 (schema reservation that precedes policy CRUD #51/#148,
the editors #53/#63, and the Phase-4 transport).
**Decision source (authoritative):** `docs/adr/0005-recurrence-and-date-scoping.md`
→ "Reserved schema shape (implemented by #146)". Blocker #139 is closed.

## Goal

Make the `schedules` and `exceptions` tables forward-compatible with the
recurrence + date-scoping model **now**, without implementing any
recurrence/date behaviour. A row with no recurrence and no effective window
must behave exactly like today's uniform rule ("degenerate default =
always-on"), so this reservation is non-breaking for the Phase-2 CRUD and the
existing precedence resolver.

Explicitly **out of scope** (lands later, must not change behaviour here):
the "active at instant *T*" resolution engine (#143, Phase 4) and any
editor/UI (#53/#63).

## Reserved shape (from ADR 0005 §"Reserved schema shape")

```
schedules  + recurrence_days          INTEGER NULL  -- 7-bit ISO-weekday mask, 1..127; NULL = no weekday restriction
           + recurrence_start_minute  INTEGER NULL  -- 0..1439 local minutes; NULL with end NULL = no intra-day restriction
           + recurrence_end_minute    INTEGER NULL  -- 1..1440 local minutes, > start
           + effective_from           INTEGER NULL  -- UTC epoch seconds, inclusive; NULL = open start
           + effective_to             INTEGER NULL  -- UTC epoch seconds, exclusive; NULL = open end
           (cron_or_window REMOVED — it had no grammar or consumer)

exceptions + effective_from           INTEGER NULL  -- UTC epoch seconds, inclusive; NULL = active from created_at
           (expires_at retained as the effective end)
```

### CHECK constraints (ADR §"Coherence constraints #146 should encode")

- `recurrence_start_minute` and `recurrence_end_minute` are **both** NULL or
  **both** set; when set, `0 <= start < end <= 1440`.
- `recurrence_days`, when set, is in `[1, 127]` (at least one weekday).
- `effective_from < effective_to` when both set (strict `<`, so a vacuous
  never-active window is rejected, not stored).
- exceptions: `effective_from < expires_at` when `effective_from` set.

## Phases

1. **Schema + constants + migration.**
   - `server/src/policy/recurrence.ts` (new): single-source numeric bounds
     (`WEEKDAY_MASK_MIN/MAX`, `MINUTE_OF_DAY_MIN/MAX`), shared by the schema
     CHECKs and the zod validators (mirrors the `enums.ts` single-source idiom).
   - `server/src/policy/schema.ts`: edit `schedules` (drop `cronOrWindow`, add
     the 5 columns + CHECKs) and `exceptions` (add `effectiveFrom` + CHECK).
     `effective_*` use `integer({ mode: "timestamp" })` like every other
     instant column.
   - `npm run db:generate` → timestamp-prefixed migration + snapshot committed
     under `server/drizzle/`.
2. **zod validators.** `server/src/api/policy/recurrence.ts` (new): reusable
   `scheduleRecurrenceSchema` (the 5 fields + internal coherence refinements)
   for #51/#148 to compose into the schedule create/update DTOs, plus the
   minute/weekday field schemas. (The exception `effective_from < expires_at`
   cross-check needs `expires_at`, owned by #148's exception DTO; the DB CHECK
   is the safety net here.)
3. **Precedence retarget (behaviour-preserving).**
   `server/src/policy/schedule-precedence.ts`: the structural `ScheduleRule`
   loses `cronOrWindow` and gains the 5 reserved fields; `findShadowedRules`'s
   "identical window" heuristic compares the structured fields instead of the
   single string. Same conservative semantics, expressed over the new columns
   (the old column it compared is being removed).
4. **Tests + docs.** Extend `tests/policy/schema.test.ts` (boundary inserts
   prove each CHECK), add `tests/policy/recurrence.test.ts` (zod valid/invalid
   matrix) and `tests/api/policy/recurrence.test.ts` if the zod lives in api,
   update `tests/policy/schedule-precedence.test.ts` to the new fields.
   `docs/architecture.md` already describes this shape — no doc change needed.

## License boundary

N/A — pure TypeScript + Drizzle (Apache-2.0) + zod + better-sqlite3 (MIT). No
transport, no packaging, no GPL surface.
