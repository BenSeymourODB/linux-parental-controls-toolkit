# ADR 0006 — Activity matcher grammar

- **Status:** Accepted (2026-06-19)
- **Issue:** [#178](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/178)
- **Phase:** 5 (usage normalisation). Implements the matcher contract the
  Activity editor ([#53](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/53)/[#63](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/63))
  will write against; builds on the #88 normaliser.

## Context

`Activity` carries a `kind` (`app` | `app_group` | `domain` | `domain_group`)
and a free-text `matcher`. The #88 ActivityWatch normaliser
(`transport/activitywatch/normalise.ts`) resolves a window event's foreground
`app` to an activity by **case-insensitive exact equality**, and only for
`app`-kind activities — a deliberate, documented v1 floor. `docs/architecture.md`
left "matcher" unspecified.

That floor is too blunt for real telemetry. ActivityWatch reports OS-level app
identifiers — `google-chrome`, `org.gnome.Nautilus`, `firefox-esr` — that an
admin should be able to capture without knowing the exact string: "anything
Chrome", "any JetBrains IDE". This ADR fixes **how a `matcher` is interpreted**
and **which activity wins when several match one event**, so the grammar is a
stable contract for the editor, the resolver, and the burndown views rather
than something each surface reinvents.

## Decision

### 1. An explicit `match_type` discriminator

Add `match_type` to `Activity`, rather than encoding the match mode in magic
matcher prefixes (`re:`, `glob:`). An explicit column is what the editor renders
as a dropdown, keeps the `matcher` free of reserved characters, and makes the
SQLite `CHECK` constraint the single source of truth (same pattern as every
other enum in `enums.ts`).

| `match_type` | Meaning (all **case-insensitive**) |
|--------------|------------------------------------|
| `exact`      | `matcher` equals the app string. **Default; == today's v1 behaviour.** |
| `substring`  | `matcher` occurs anywhere in the app string. |
| `glob`       | `matcher` matches the **whole** app string, with `*` (any run) and `?` (any one char) the only metacharacters. |
| `regex`      | `matcher` is a JS regular expression, matched (unanchored) against the app string. |

`match_type` is `NOT NULL DEFAULT 'exact'`. Every existing row keeps its exact
behaviour with **no data migration** — the degenerate default, mirroring #146's
"no recurrence = always-on".

### 2. Both window-resolvable kinds use the grammar; `domain*` are deferred

`app` **and** `app_group` resolve from window events through this grammar. An
`app_group` is simply "an activity whose matcher matches several apps" (e.g.
`glob:jetbrains*` or `regex:(chrome|chromium)`); it produces samples against
that one activity id, which is exactly the client-expanded-bundle behaviour the
PlayTime model wants. This is **distinct** from the `activities_to_groups` M2M,
which groups whole activities for *rollups* — `app_group` groups apps at the
*matching* step.

`domain` and `domain_group` match **web requests**, not window events. Their
telemetry source is the web proxy (e2guardian, Phase 6 #90) / AdGuard (Phase 7),
which does not exist yet. This ADR records their intended contract — the same
`match_type` grammar applied to a request host instead of an app string, with
`domain_group` an app-group analogue over hosts — but the window-event
normaliser **continues to ignore them**. Implementation is tracked separately
and lands with that telemetry.

### 3. Precedence when several activities match one event

A window event credits **exactly one** activity (the `usage_samples.activity_id`
FK is single-valued). When more than one activity matches:

1. **`exact` beats any pattern** (`substring`/`glob`/`regex`). An admin who
   typed the literal app name meant that activity.
2. **Within the same tier, the lowest `activity.id` wins** — deterministic and
   identical to v1's case-folded-collision rule, so resolution never depends on
   query order.

This is the *floor*, chosen for determinism without new UI. It is deliberately
simple: there is no "longest match" or "most specific pattern" heuristic, which
would be ambiguous across glob vs regex. When the editor (#63) gains an explicit
ordinal for activities (as schedules already have), that admin-defined order
supersedes the lowest-id tiebreak; until then lowest-id is the predictable
default and is documented in the editor copy.

### 4. `glob` is bounded; `regex` posture

`glob` supports only `*` and `?`, anchored to the whole string, and is compiled
to a bounded regular expression with every other character escaped — it adds no
alternation or backtracking surface.

`regex` is admin-supplied and **validated to compile at write time** (the API
DTO rejects an uncompilable pattern with a 400). It is matched against short OS
app identifiers (tens of characters), so catastrophic-backtracking exposure is
negligible, and the threat model is a **single trusted household admin**, not
adversarial input — consistent with `CLAUDE.md` → "Tamper resistance is
deliberately bounded": we do not build a regex sandbox or timeout harness for a
self-inflicted-only risk. The pure normaliser additionally treats an
uncompilable stored pattern as a **no-match** (never throwing) so a row that
somehow bypassed validation can never wedge a telemetry pull.

## Consequences

- One additive migration on `activities` (`match_type`, `NOT NULL DEFAULT
  'exact'` + CHECK). No backfill; v1 rows are unchanged.
- `enums.ts` gains `matchTypeValues` / `matchTypeSchema`, consumed by the schema
  CHECK and the `/api/*` DTOs (one source of truth).
- The normaliser's matcher index becomes a compiled predicate set ordered by the
  precedence above; the rest of its pipeline is untouched.
- `app_group` window resolution starts producing samples (it produced none in
  v1); `domain*` still produce none until web-proxy telemetry lands.

## Alternatives not chosen

- **Prefix-encoded match mode in `matcher`** (`re:…`, `glob:…`): no migration,
  but leaks grammar into data, needs escaping for a literal leading `re:`, and
  is worse for the editor. Rejected for the explicit column.
- **Longest-match / specificity ranking** across pattern types: more "intuitive"
  but ill-defined between glob and regex and order-sensitive at the edges.
  Rejected for the deterministic exact-then-lowest-id rule.
- **Implementing `domain*` now** by reusing the app string: would mismatch the
  semantics (a window app is not a request host) and pre-commit the contract
  before the telemetry that feeds it exists. Deferred.
