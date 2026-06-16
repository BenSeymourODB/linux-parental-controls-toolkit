# Design mock-ups

Static, plain-HTML design studies for the three consumer surfaces of the
Parental Controls Toolkit. They exist to settle **UX direction** before the
SvelteKit (`/admin`, `/app`) and TypeScript desktop-app (client) work lands,
and to give the roadmap and issue tracker something concrete to point at.

> These are **mock-ups, not the product.** No build step, no framework, no
> external assets, no real data — every file opens straight from `file://`.
> Shared styling lives in [`assets/styles.css`](assets/styles.css); the real
> surfaces are SvelteKit and a packaged TS app per
> [`docs/proposed-tech-stack.md`](../docs/proposed-tech-stack.md). Where a
> mock-up shows a chart it is hand-drawn SVG/CSS standing in for the eventual
> live component, not a finished design spec.

Open [`index.html`](index.html) for the gallery.

## What's here

| Surface | File | What it explores | Maps to |
|---|---|---|---|
| **Admin** `/admin` | [`admin/dashboard.html`](admin/dashboard.html) | All supervised users at a glance, live burndown rings, client/agent health, activity feed | Roadmap Phase 2 · [#53] |
| | [`admin/user-detail.html`](admin/user-detail.html) | Per-user overall **burndown chart**, **ActivityWatch usage timeline**, per-activity budgets, today's schedule, grants affecting today | Phase 5 (telemetry views) |
| | [`admin/policy-editor.html`](admin/policy-editor.html) | Budgets, activity groups, **drag-to-order** schedule/exception rules, notification + filter policy, save-and-push bar | Phase 2 · [#53] |
| | [`admin/grants-ledger.html`](admin/grants-ledger.html) | Immutable grant ledger (admin + calendar sources, `source_ref`, expiry, revoke) + grant panel | Phase 10 · architecture "External integrations" |
| | [`admin/clients.html`](admin/clients.html) | Enrolled machines, component health (Timekpr/AW/e2guardian/bridge/agent), offline + queued-change state, enrol-a-client flow | Phase 3 · architecture "Failure modes" |
| | [`admin/integrations.html`](admin/integrations.html) | Calendar API tokens (scopes/rate), AdGuard mode selector, notification defaults | Phases 7 & 10 |
| **App (PWA)** `/app` | [`app/parent-home.html`](app/parent-home.html) | All kids on one phone screen, quick-grant buttons, low-time alert | Phase 9 |
| | [`app/grant.html`](app/grant.html) | Touch-first grant flow: who / what scope / how much / reason | Phase 9 + 10 |
| | [`app/child-status.html`](app/child-status.html) | PIN-scoped per-child view: time left, limits, next transition, rewards | Phase 9 |
| **Client** (supervised desktop) | [`client/dashboard.html`](client/dashboard.html) | **NEW** — the "My Time" desktop dashboard (see below) | *not yet on the roadmap — proposed here* |
| | [`client/notifications.html`](client/notifications.html) | Every toast / grace-countdown / lock / grant / offline state | Phase 8b · [`docs/client-notifications.md`](../docs/client-notifications.md) |

[#53]: https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/53

## Design principles carried through every surface

- **No surprises.** The supervised user can always see the rules in force and
  what's coming next. This is the same philosophy as the warning cadence in
  `docs/client-notifications.md`, extended to a persistent surface.
- **Not punitive.** Framing is "time left", "earn more", "coming up" — never
  "blocked / denied / violation". Consistent with the household framing in
  `README.md` and `docs/client-install.md` ("Tamper resistance is deliberately
  bounded").
- **Orchestration, not enforcement, shows through.** The UI labels which
  upstream tool does the work (Timekpr-nExT locks the session, e2guardian
  filters, ActivityWatch supplies usage). We render **our own** views from
  ActivityWatch's REST data rather than embedding AW's GPL UI in-process —
  respecting the license boundaries in `docs/licensing-analysis.md`. The
  client dashboard links out to AW's own UI for the deep dive.
- **One API.** Every surface reads and writes the same `/api/*` contract; the
  PWA and external integrators are first-class consumers, not afterthoughts
  (`docs/architecture.md`).
- **UTC inside, local at the edge.** Every "today / resets at midnight" string
  is the user's *effective* timezone resolving a UTC instant, per
  [ADR 0001](../docs/adr/0001-budget-timezone.md).

## The new piece: a supervised-user client dashboard

So far the client-side UX in the docs is **only** toast notifications
(`docs/client-notifications.md`). That's the *interrupt* channel. These
mock-ups propose a complementary *pull* channel: a small desktop app the child
can open any time to answer "how am I doing?" without waiting to be
interrupted — and without having to ask a parent.

`client/dashboard.html` sketches **"My Time"**, presenting:

1. **Time left right now** — a hero ring for overall screen time, plus a
   plain-language "what's happening now" card (free time / school hours /
   wind-down) and the next scheduled change.
2. **Time left per app & category** — Games / YouTube / Social / School with
   their own remaining time, colour-coded, so the child can self-budget ("I'll
   stop Minecraft and save YouTube for later") instead of being surprised.
3. **What you did today** — an ActivityWatch-style timeline rendered from the
   same `UsageSample` data the admin sees, framed neutrally as *your own*
   activity on *your own* device (transparency, not surveillance theatre).
4. **This week** — a small bar chart against the daily limit to encourage
   self-regulation over time.
5. **Coming up today** — upcoming schedule transitions (Social unlocks,
   wind-down, bedtime lock) so nothing arrives as a shock.
6. **Rewards** — grants received and a nudge toward the family-calendar chores
   that earn more time (the Phase 10 integrator, surfaced as a *positive*).
7. **Status / "what's filtered" / "ask a parent"** — honest agent-connection
   state, a gentle note that web filtering is on, and a low-friction path to
   start a conversation rather than a workaround.

### Why this is worth building

- **Reduces conflict.** Most "you cut me off!" friction comes from opacity.
  A glanceable dashboard turns the limit into a shared, visible fact.
- **Teaches self-regulation.** Per-category budgets + a weekly trend let a
  child plan their own time — the explicit goal of a *household* tool rather
  than a lockdown tool.
- **Cheap to build on what exists.** It reuses data already flowing for Phase
  5 (ActivityWatch → `UsageSample`), the locally cached budget the Phase 8b
  agent already holds, and the same `/api/*` contract. No new enforcement, no
  new license surface.
- **Fits the "no arms race" stance.** It deliberately shows *only the user's
  own* data and offers *no* controls — viewing, never editing. Adjustments
  stay with the parent on `/admin` or `/app`.

### Open questions for the maintainer

- **Delivery vehicle.** Three plausible options, in rough order of effort:
  (a) reuse the Phase 9 `/app` PWA child-status view, opened in a kiosk
  browser on the client — *cheapest, no new artifact*; (b) a thin wrapper
  window in the existing `pct-client-agent` that loads that same web view
  locally; (c) a fully native dashboard in the agent. The mock-up is drawn as
  a desktop window but the content is identical to `app/child-status.html` on
  purpose, so (a)/(b) stay open.
- **Always-available vs. summoned.** Tray icon + "open My Time", a panel
  applet, or only-on-demand?
- **How much history** to show a child (today only, this week, this month)?

## Suggested roadmap / issue follow-ups

These mock-ups surface work that isn't yet an issue. Candidates to file
against the [roadmap project](https://github.com/users/BenSeymourODB/projects/2):

- **New — Phase 8d (proposed): supervised-user "My Time" dashboard.** Decide
  the delivery vehicle (PWA-reuse vs. agent-hosted), then build the read-only
  status view. Depends on Phase 5 (usage data) and Phase 8b (cached budget).
- **Admin burndown & usage-timeline components** (Phase 5): the chart pieces in
  `admin/user-detail.html` are their own deliverable once `UsageSample`
  aggregation lands.
- **Drag-to-order rule editor** (Phase 2, refines [#53]): the schedule/exception
  list in `admin/policy-editor.html` needs ordering semantics ("first match
  wins") nailed down in the policy model.
- **Save-and-push diff preview** (Phase 4): the "preview diff" affordance in the
  policy editor maps to the offline-queue / per-client diff in
  `docs/architecture.md`.
- **Parent low-time push notifications** (Phase 9): the alert banner in
  `app/parent-home.html` is the UI for the Web Push item already in the roadmap.

## Conventions used in these files

- One shared stylesheet, design tokens as CSS custom properties.
- Charts are inline SVG or CSS — no JS, no chart library, no network.
- Sample names (Alice/Bob/Chloe, `mint-livingroom`) and figures are
  illustrative and consistent across files.
- Each file has a top "MOCK-UP" bar linking back to the gallery.
