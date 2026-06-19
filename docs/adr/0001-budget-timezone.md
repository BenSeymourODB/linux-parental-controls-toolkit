# ADR 0001 — Timezone strategy for daily budget rollover

- **Status:** Accepted (2026-06-16)
- **Issue:** [#17](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/17)
- **Phase:** 1 (decision); affects Phase 2 (`User` schema and every budget query)

## Context

"How much time does Alice have left **today**?" only has a precise answer
once we pick a timezone. Daily, weekly, and monthly budget windows all
roll over at a wall-clock boundary, so the answer to "when does *today*
end" is load-bearing for every budget rollup, burndown view, and
enforcement decision. The decision touches the `User` schema, so it has
to land before the Phase 2 schema work ([#48](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/48)).

Three options were on the table (issue #17):

- **A. Single server TZ via env var** (e.g. `PCT_TZ=America/New_York`).
  Simplest; sufficient for a single-household, single-timezone
  deployment, but cannot express a child or parent in a different zone.
- **B. Per-user TZ column** on `User`. Flexible (kids in different
  timezones, a travelling parent) but every budget rollup has to honour
  it.
- **C. UTC everywhere internally, surface in a configured display TZ.**
  Cleanly separates storage from presentation, but does not by itself
  answer "when does *today* end" — that is a policy question layered on
  top of storage.

These options are not mutually exclusive: A and B are about *which*
timezone defines a user's day; C is about *how timestamps are stored*.

## Decision

Adopt **C as the storage rule and B as the budget-window rule, with A as
the default source for B**:

1. **UTC everywhere internally.** Every timestamp the server persists,
   computes with, logs, or puts on the wire (`UsageSample.started_at` /
   `ended_at`, `Grant.granted_at` / `expires_at`, audit-log entries,
   `last_seen`, event-stream payloads, the JSON API) is UTC. Storage and
   computation never depend on a local-time interpretation.

2. **A server-default timezone, with per-user overrides.** The server
   carries a default IANA timezone (`PCT_DEFAULT_TZ`, e.g.
   `America/New_York`). Each `User` gets a nullable `tz` column; when it
   is `NULL` the user inherits the server default. The user's *effective*
   timezone is `User.tz ?? PCT_DEFAULT_TZ`.

3. **The effective timezone defines budget windows.** "Today", "this
   week", and "this month" — i.e. when a daily/weekly/monthly budget
   rolls over — are computed by converting the relevant UTC instants into
   the user's effective timezone and taking the local calendar boundary.
   The budget window is the only place local time enters the computation;
   everything underneath stays UTC.

4. **TZ is a presentation/windowing concern, never a storage format.**
   Frontends and integrators receive UTC instants (ISO 8601 with a `Z`
   offset) plus the user's effective timezone, and render local time
   client-side. The server does not store local-time strings.

### Mid-window timezone change

> **Resolved by [ADR 0003](0003-mid-window-timezone-change.md)
> (2026-06-16).** This clause originally deferred the case below; the
> decision recorded here for history.

A user **changing timezone mid-window** — e.g. moving house or going on
vacation partway through a day of usage — was out of scope for *this*
decision. Changing `User.tz` (or `PCT_DEFAULT_TZ`) takes effect from the
next window boundary; the behaviour of the in-flight day was left
unspecified. [ADR 0003](0003-mid-window-timezone-change.md) makes that rule
explicit (**pin the in-flight window to the timezone in effect when it
opened**) and implements it in the shared budget-window helper. Tracked in
[#56](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/56).

## Consequences

- **Schema:** `User` gains a nullable `tz` column (IANA name, e.g.
  `America/New_York`). The Phase 2 schema issue ([#48](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/48))
  defines it; the policy-model sketch in
  [`architecture.md`](../architecture.md) is updated to match.
- **Config:** a new `PCT_DEFAULT_TZ` server setting (IANA name) supplies
  the default for users without an override. It must validate as a real
  IANA zone at startup.
- **Budget queries:** every daily/weekly/monthly rollup resolves the
  user's effective timezone and computes the window boundary in it. This
  is the one local-time-aware step; it should live in a single shared
  helper so the rule is applied consistently (burndown views,
  enforcement checks, grant expiry).
- **Grants:** `Grant.expires_at` stays UTC. A grant that "expires at end
  of day" is computed by the issuer (or the dashboard) as the UTC instant
  of the user's local end-of-day; storage stays UTC.
- **Validation:** timezone inputs (`PCT_DEFAULT_TZ`, `User.tz`) are
  validated against the IANA database (available via
  `Intl.supportedValuesOf('timeZone')` on Node 22) before they cross into
  typed code, per the zod-at-the-boundary convention in `CLAUDE.md`.
- **Clock skew** (see [`architecture.md`](../architecture.md) → "Failure
  modes"): unchanged in substance — clients NTP-sync and the server
  reconciles against client-reported `UsageSample` end-times — but the
  reconciliation is now unambiguous because both sides agree on UTC.

## Alternatives not chosen

- **A alone** was rejected because it cannot represent a child or parent
  in a different timezone, and retrofitting per-user zones later would
  touch the same `User` schema and every budget query we are designing
  now — cheaper to add the nullable column up front.
- **B alone** (no UTC storage rule) was rejected because mixing
  local-time storage with per-user zones makes reconciliation against
  client telemetry and audit reasoning error-prone. C is what makes B
  safe.
- **Full mid-window TZ migration support** was rejected as scope for now;
  see "Explicitly deferred".
