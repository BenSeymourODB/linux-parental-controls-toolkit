# ADR 0004 — Schedule/Exception precedence: first match wins

- **Status:** Accepted (2026-06-16)
- **Issue:** [#63](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/63)
- **Phase:** 2

## Context

A user's `Schedule` rules (`docs/architecture.md` → "Policy model") each
carry an `action` (`allow` / `deny` / `extend`) and a `cron_or_window`
expression saying when the rule is in force. Real households produce
overlapping rules: "homework time (weekdays 16:00–18:00) denies Discord" and
"weekend mornings allow YouTube" can both be live for the same activity at
the same instant. Without a defined precedence, "what is allowed right now?"
is ambiguous — and that question is asked in three places that must all agree:
the admin editor, enforcement, and the read-only `/app` child-status view.

So the precedence model has to be settled **before** the drag-reorder editor
ships, because the editor's whole purpose is to let a parent *control* that
precedence, and the other surfaces replay the same answer.

## Decision

**Rules are evaluated top-to-bottom by ascending `ordinal`; the first rule
whose window is active wins.** Order is **stored**, not implied by insertion
order: `schedules` gains an explicit `ordinal` column (`integer NOT NULL
DEFAULT 0`), indexed `(user_id, ordinal)`.

- A user's applicable rules for a target are sorted by `ordinal` (ties broken
  by `id` for determinism). The first one active at the evaluated instant
  decides the action; if none is active, the surface applies its own baseline
  (typically allow).
- "Applicable to a target" follows the existing scope vocabulary: an
  `overall` rule applies to everything, an `activity`/`group` rule to its
  target. Resolving group membership (does this activity belong to that
  group?) is the caller's job, not the precedence rule's.
- The precedence lives in one pure module,
  `server/src/policy/schedule-precedence.ts`, mirroring
  `budget-window.ts`: every surface routes "which rule is in effect?" through
  it so the answer is identical everywhere. Whether a given rule's
  `cron_or_window` is active at an instant is injected as a predicate — the
  expression grammar is a separate, not-yet-defined concern and is kept out of
  the precedence module.

### Action vocabulary

The committed action set stays **`allow` / `deny` / `extend`**, matching
`docs/architecture.md` and `policy/enums.ts`. The PR #60 mock-up listed a
fourth value, `lock`; this ADR deliberately does **not** add it. "Locked
out" is the overall-budget-exhaustion state (Phase 8c, ADR-to-come), reached
when time runs out — not something a schedule rule asserts. Adding it to the
schedule/exception action enum would be a separate model decision.

## Consequences

- **Determinism and parent intuition.** First-match-wins makes the stored
  order the single, visible lever: drag a rule up and it beats the rules
  below it. A parent reasons about it as a priority list.
- **Reuse.** The admin editor persists the order (dense `0..n-1` ordinals via
  the module's `reorder`), and the `/app`/enforcement surfaces read the same
  order back and call the same resolver — no surface re-implements precedence.
- **Shadow warnings, conservatively.** The module also detects rules that can
  never fire because an earlier rule always pre-empts them. It only flags the
  provable case — an earlier rule covering the same-or-broader target with an
  **identical** `cron_or_window` string. Catching subtler shadowing (a
  broader window subsuming a narrower one, group membership) needs the
  `cron_or_window` grammar and is deferred with it; the conservative detector
  never produces a false "this rule is dead" warning.
- **Scope.** This ADR settles the *model*. The drag-reorder editor UI
  (drag handle, keyboard a11y, live "in effect now" indicator, surfacing the
  shadow warnings) is part of the admin editors (#53) and lands with them.

## Alternatives not chosen

- **Most-specific-wins** (overall < group < activity, narrowest target
  beats broader). Rejected: it makes the editor's ordering cosmetic — a
  parent who drags an `overall deny` above an `activity allow` would still
  see the activity rule win, which is surprising and removes the one control
  the editor exists to provide. Specificity is also only a partial order
  (two unrelated activity rules aren't comparable), so it still needs a
  tiebreak — at which point stored order is simpler and predictable.
- **Adding a `lock` action now.** Deferred (see "Action vocabulary"); it is a
  distinct model decision, not part of settling precedence.
