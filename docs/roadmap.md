# Roadmap

Phased delivery plan for the toolkit. Each phase below maps to a milestone
on the [roadmap project](https://github.com/users/BenSeymourODB/projects/2);
the bullets are the kind of issues that should be filed against that
milestone. This file is a living document — update it as scope changes.

## Phase 0 — Foundations (this PR)

Goal: design captured in the repo so future work can proceed against a
shared understanding.

- [x] Capture proposed tech stack (`docs/proposed-tech-stack.md`)
- [x] Capture licensing analysis (`docs/licensing-analysis.md`)
- [x] Write `README.md`
- [x] Write `CLAUDE.md`
- [x] Write `docs/architecture.md`
- [x] Write `docs/server-deployment.md`
- [x] Write `docs/client-install.md`
- [x] Write this roadmap

## Phase 1 — Project scaffolding

Goal: a runnable, empty-but-correct dashboard skeleton and a CI baseline.

- [x] Pin the dashboard implementation language — **TypeScript end-to-end**
  (Node.js 22 + Fastify backend, SvelteKit frontend). Decision rationale and
  the Python→TypeScript mapping table live in
  [`proposed-tech-stack.md`](proposed-tech-stack.md)
  ("Stack decision — TypeScript end-to-end").
- Create `server/` package layout (`package.json`, `tsconfig.json`,
  `src/`, `tests/`, `Dockerfile`, `.dockerignore`).
- [x] Pin the dashboard license — **proprietary source-available** (Option C,
  decided in issue #4). `LICENSE` is at the repo root;
  [`licensing-analysis.md`](licensing-analysis.md) has the decision rationale.
- Add `pre-commit` config: Prettier, ESLint, `tsc --noEmit`.
- Add a minimal Fastify app that serves a "hello, no policy yet" page.
- Add a GitHub Actions workflow that lints, type-checks, runs tests, and
  builds the Docker image.
- Add a basic `docker-compose.yml` example for local development.

## Phase 2 — Policy store, JSON API, and admin UI shell

Goal: an admin can log in, define users, define clients (as records), and
define a policy — but nothing is enforced yet. The JSON API is designed
as a first-class surface from day one (it has to carry both the admin UI
and, later, the PWA and external integrators).

- Implement the SQLite schema for `User`, `Client`, `UserOnClient`,
  `Activity`, `ActivityGroup`, `Budget`, `Schedule`, `Exception`,
  `Grant`, `IntegrationToken`. `User` carries a nullable `tz` column
  (timezone strategy decided in
  [`docs/adr/0001-budget-timezone.md`](adr/0001-budget-timezone.md);
  UTC internally, server-default TZ with per-user overrides).
- drizzle-kit migrations.
- Single-admin local password auth (Argon2) for the admin UI.
- **`/api/*` JSON endpoints** for the full policy model (the admin UI
  calls these; the PWA and integrators will too). Request/response
  shapes are zod schemas shared with the frontend.
- SvelteKit admin UI on `/admin/*`: users, clients, activities,
  budgets, schedules. Talks only to `/api/*` — the same contract the
  PWA and integrators use (no privileged in-process shortcuts).
- No transport integration yet; all "push" actions are stubbed to log.
- **Recurrence + date-scoping decision (foundational).** Settle *how*
  time-varying policy is represented before the schedule/budget CRUD and
  editors are built against the uniform-only model — captured as
  `docs/adr/0005-recurrence-and-date-scoping.md`
  ([#139](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/139)).
  Then **reserve the schema columns** it implies (recurrence representation
  on `Schedule`; `effective_from`/`effective_to` on `Exception`), with
  "no recurrence = always-on" as the degenerate default so there is no
  later migration
  ([#146](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/146)).
  Only the *decision* and column reservation live here; the *implementation*
  of recurring/date-specific behaviour is Phase 4 and Phase 13. (Pulled
  forward from Phase 13 because it shapes the most central tables.)

## Phase 3 — Client install script (Linux Mint)

Goal: enrolling a fresh Mint client is one command.

- Implement `client/install-client.sh` per `docs/client-install.md`.
- Enrolment-token endpoint on the dashboard.
- `pct-agent` user provisioning + scoped sudoers.
- ActivityWatch + Timekpr-nExT + e2guardian install and baseline config.
- Self-test that runs at the end of the script.
- Report the installed `pct-client` agent version and managed-tool
  versions in the enrol payload, and reserve the version columns on
  `Client`, so the fleet-update work has a version inventory to diff
  against from day one (pulled forward from Phase 14;
  [#164](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/164)).

## Phase 4 — SSH + `timekpra` transport

Goal: dashboard pushes overall session limits to clients.

- ssh2-based transport facade.
- `timekpra` invocations for: set daily/weekly/monthly limits, set
  allowed hours, set PlayTime configuration.
- [x] Offline-queue: changes for offline clients persisted and replayed on
  next reachable probe
  ([#84](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/84)).
  The durable store + coalescing + drain/replay loop + croner scheduler land
  here against injected SSH executor/probe seams; the live wiring activates
  with the `timekpra` push (#83) and the entrypoint's SSH-key bootstrap (#39).
- Audit log of every command issued.
- Recurring day-of-week time-windows on `Schedule` (allow/deny/extend on
  chosen weekdays between start/end times), pushed as Timekpr-nExT
  allowed-hours (and e2guardian window swaps in Phase 6)
  ([#140](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/140)).
- Effective-policy resolution engine + `GET /api/.../effective?date=…`
  preview — the single "what applies for user U on day D" computation that
  enforcement, the burndown views, and the save-and-push diff all read;
  built here so time-window enforcement isn't coded against an interim
  contract, and extended later by weekday budgets and date overrides
  ([#143](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/143)).
  (Both pulled forward from Phase 13; they depend only on the Phase 2
  decision + column reservation.)

## Phase 5 — ActivityWatch telemetry pull

Goal: dashboard shows actual usage per user per activity.

- Scheduled job (croner) that opens SSH port-forwards and pulls AW events.
- Normalisation into `UsageSample` rows; aggregation views.
- Per-user "burndown" chart for overall and per-activity budgets.

## Phase 6 — Ansible config push

Goal: e2guardian rules, iptables rules, AppArmor profiles and AW
deployment are all server-managed.

- Ansible runner inside the dashboard (subprocess).
- Playbooks for e2guardian filter groups, iptables OUTPUT redirect,
  ActivityWatch systemd-user units, AppArmor profile drops.
- Periodic re-apply (tamper reversion) as a systemd timer on the server
  triggering a playbook.

## Phase 7 — DNS filtering (optional)

Goal: per-user / per-client DNS-level rules driven by the dashboard,
in whichever AdGuard Home topology the admin already has.

The dashboard supports three modes (`PCT_ADGUARD_MODE`):

- **`disabled`** — default; do nothing DNS-related.
- **`external`** — point at an AdGuard Home the homelab admin already
  runs (the common case for the target user). Confine the dashboard's
  writes to a dedicated AdGuard user account and a `pct:`-prefixed
  set of AdGuard clients so household-wide AdGuard config stays
  untouched.
- **`managed`** — first-run fetch of AdGuard Home from upstream
  releases into the data volume; dashboard supervises it as a child
  process (or sibling container — implementation decision).

Deliverables:

- AdGuard REST client in the dashboard (used by both `managed` and
  `external` modes; same code path).
- Configuration plumbing for the three modes; preflight check on
  startup for `external` mode that the configured URL/credentials
  reach a healthy AdGuard instance.
- Managed-mode supervisor (only used when `PCT_ADGUARD_MODE=managed`).
- UI: per-client domain blocklists with schedule support; surfaces
  the active mode so the admin understands where their DNS rules
  end up.

## Phase 8 — Per-activity time enforcement (uses the agent from Phase 8b)

Goal: when the dashboard sees a per-activity quota exhausted, the activity
is stopped on the client — and the user gets the warning cadence and
grace period from Phase 8b before that happens.

- Decision logic in the dashboard based on `UsageSample` rollups.
- Server emits `enforce.force_close` over the event stream once the
  grace period has elapsed. The per-user agent does the kill so we
  avoid an SSH round-trip and don't need a privileged client-side
  helper.
- Cool-down to avoid thrash; respect the policy's `grace_seconds`.
- Falls back to an SSH ad-hoc `pkill` if the agent isn't reachable.

## Phase 8b — Client notifications and end-of-budget UX

Goal: deliver the supervised-user-facing experience described in
[`docs/client-notifications.md`](client-notifications.md) —
toast/sound notifications for server events, escalating
time-remaining warnings, grace period, force-close on per-app
expiry, lock + grant-unlock on overall-screen-time expiry.

- The server's `events` module exposing `GET /api/events/stream`
  (WebSocket), with per-client bearer-token auth and reconnect
  semantics.
- `pct-client-bridge` system-level service (TypeScript) on the client:
  WebSocket client, reconnects with backoff, dispatches events to
  per-user agents over `AF_UNIX` sockets, and holds a narrow
  `sudoers` rule for the few privileged actions it needs (notably
  `timekpra --kill-session` and clearing/setting lockouts).
- `pct-client-agent` per-user service (TypeScript, `systemd --user`):
  notification + sound rendering via the desktop's own tools
  (`notify-send` / `gdbus`, `canberra-gtk-play`), locally computed
  warning cadence (15/5/1 minute rules), grace-period countdown,
  per-app force-close.
- `NotificationPolicy` persisted in the policy store and pushed to
  the client with the rest of policy.
- Admin UI under `/admin/notifications` to set the per-user sound
  profile, master enable/disable, and grace-period override.
- Bake a **version handshake + N-1 compatibility window** into the bridge
  ↔ `/api/events/stream` handshake (aligned with `/api/meta`'s
  `apiVersion`), so a later upgraded server can keep talking to clients
  that haven't updated yet. Cheap in the handshake now, impossible to
  retrofit onto already-deployed clients (pulled forward from Phase 14;
  [#165](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/165)).
  The contract — two integer version axes (`apiVersion` + a new
  `eventProtocol`), the N-1 window, the `hello`/`accept`/`refuse`
  handshake, capability advertisement, and `update_required` semantics —
  is decided in
  [`docs/adr/0007-event-stream-version-compatibility.md`](adr/0007-event-stream-version-compatibility.md);
  this phase implements it.

## Phase 8c — Lockout / grant-unlock flow

Goal: when the overall screen-time budget hits zero, the user is
locked out cleanly; when a grant arrives (from the admin or an
external integrator like the calendar app), the lockout clears
without manual intervention.

- Bridge subscribes to `lockout.cleared` events.
- When Timekpr's session-kill fires, the bridge records a local
  "user locked out" marker and surfaces it in the admin UI.
- On `grant.applied` against the overall budget, the server pushes
  the new effective budget via SSH+`timekpra`; Timekpr unlocks the
  user; bridge sends `lockout.cleared` to surface a toast on any
  device the user happens to be logged into.

## Phase 9 — Mobile / PWA experience (`/app`)

Goal: parents and supervised users have a mobile-first, home-screen-
installable view of the system.

- `/app` route group of the SvelteKit project (`server/frontend/`),
  built statically (`adapter-static`) and served by Fastify at `/app`.
- PWA basics: manifest, service worker, offline-friendly app shell.
- Per-user status screen: how much time is left today, what's been used,
  upcoming schedule transitions.
- Parent-facing limit-adjustment screens (touch-friendly time pickers,
  swipeable day/week/month views).
- Auth: shared session with the admin UI for the admin role; an
  additional lightweight per-user PIN/passcode model for child users
  who should only see their own data.
- Web Push for "5 minutes left" / "time's up" notifications.
- Built in the image's builder stage alongside the backend; the runtime
  image serves the static output.

## Phase 10 — External integrations: family-calendar rewards

Goal: API-compatibility with
[next-digital-wall-calendar](https://github.com/BenSeymourODB/next-digital-wall-calendar)
so chore/calendar completions can grant screen-time rewards.

- `/api/integrations/*` endpoints, including `POST /grants` per
  `docs/architecture.md`.
- `IntegrationToken` issuance / scoping / revocation in the admin UI.
- Idempotency-by-`source_ref` enforcement; rate limiting per token.
- Grant ledger UI in `/admin`: view, filter, revoke.
- Recompute pipeline: when a grant lands, recompute the affected user's
  effective budget for the day and push to the client(s) via the
  existing SSH + `timekpra` transport.
- Coordinate with the calendar repo on the exact request/response shape
  before locking it in; treat the first version as `v1` and version the
  endpoint path accordingly.
- Stretch: outbound webhook from dashboard → calendar (e.g. "Alice has
  10 min left") to enable richer cross-app behaviour.

## Phase 11 — Hardening and polish

- Reverse-proxy + TLS instructions for non-LAN deployments
  ([`reverse-proxy-tls.md`](reverse-proxy-tls.md);
  [#119](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/119)).
- Multi-admin / OIDC option. This is the first step beyond the
  single-admin Argon2 model of Phase 2; evaluate a managed TypeScript
  auth library (e.g. [Better-auth](https://www.better-auth.com/),
  Fastify-compatible, Drizzle adapter) here rather than extending the
  hand-rolled single-admin login. See `docs/server-deployment.md` →
  "Authentication" and stretch epic #24 → #26.
- Backup/restore utility script. Extend it with an **automatic
  pre-migration DB snapshot** taken on boot whenever migrations are
  pending, so a regretted server upgrade is recoverable — the safety net
  the current `docker pull` + restart path lacks (supports Phase 14;
  [#166](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/166)).
- Documentation pass: per-feature how-tos.
- Optional: tamper-resistance review and AppArmor hardening pass.

## Phase 12 — Supervised-user "My Time" client dashboard

Goal: a read-only desktop surface the supervised user can open any time to
see how much time they have left (overall + per app/category), what they
did today, what's coming up, and what rewards they've earned — the
complement to the toast/interrupt channel in
[`client-notifications.md`](client-notifications.md).

Depends on Phase 5 (usage data), Phase 8b (`pct-client-agent` + cached
budget), and Phase 9 (reuses the `/app` child-status Svelte view); it can
land alongside Phase 10/11 rather than strictly last. Tracked in
[#61](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/61);
data model and rendering-shell decisions are fixed in
[`docs/adr/0002-client-dashboard-shell.md`](adr/0002-client-dashboard-shell.md).

- Agent exposes a localhost-only, uid-scoped, **read-only** data endpoint
  (cached budget + `localhost:5600` usage), so the view ticks live and
  works offline; `/api/*` supplies week/month/rewards history when online.
- Auth from the Linux session (`linux-uid → User`), not the Phase 9 PIN.
- Rendering shell: installed-browser app mode for the MVP, with Tauri v2
  as the upgrade path (per ADR 0002).
- Read-only — all adjustment controls stay on `/admin` and `/app`; no new
  enforcement, no new license surface. Designed in
  [`design/client/dashboard.html`](../design/client/dashboard.html).

## Phase 13 — Calendar-based scheduling/budgeting extensions

Goal: round out the time-variation model with the remaining calendar-style
capabilities, on top of the foundation decided in Phase 2 and built in
Phase 4.

> **Sequencing note.** This area began life as a single late "Phase 13",
> but its *foundational* parts were pulled earlier because the
> schedule/budget schema, the editors, and the enforcement push all depend
> on them:
>
> - The **recurrence + date-scoping decision** (ADR 0005) and the
>   **schema column reservation** moved to **Phase 2**
>   ([#139](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/139),
>   [#146](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/146)) —
>   a decision is cheap now and a migration is expensive later.
> - **Recurring day-of-week windows** and the **effective-policy
>   resolution engine** moved to **Phase 4**
>   ([#140](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/140),
>   [#143](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/143)),
>   alongside the transport that enforces them, so enforcement isn't coded
>   against an interim contract.
>
> What remains in Phase 13 is additive capability that *extends* that
> foundation without reshaping it.

- Day-of-week-varying budgets (e.g. weekday vs. weekend quotas), composing
  with group-level budgets; plugs into the resolution engine as a layer
  ([#141](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/141)).
- Date-specific / future-dated overrides (`effective_from` /
  `effective_to`) for specific days or ranges; extends the resolution
  engine and surfaces in the "coming up" views
  ([#142](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/142)).

Both build on the Phase 2 column reservation
([#146](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/146))
and the Phase 4 resolver
([#143](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/143)) —
they add composition layers, not new tables — and compose with grants
(Phase 10) and the user-group / group-budget work. The Phase 4
recurring-windows capability
([#140](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/140))
is also the foundation the calendar-driven-schedules stretch goal
([#125](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/125))
builds on.

The resolve-vs-materialize choice in ADR 0005 also bounds how much the
data-retention work in
[#135](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/135)
has to purge: rule-based resolution means retention targets only *dated*
data — usage samples, grants, audit, and date-specific overrides — not the
recurrence rules themselves.

## Phase 14 — Fleet updates & lifecycle management

Goal: update a *running* deployment in place — both the server and the
fleet of enrolled clients — safely, observably, and (for clients)
server-orchestrated. Tracked by the epic
[#163](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/163).

> **Where we start from.** The server already has a happy-path upgrade
> story (`docs/server-deployment.md` → "Upgrade path": `docker pull` a
> newer tag, restart, migrations apply in-process on boot, Ansible venv
> reconciles per release), and `client/install-client.sh` is idempotent.
> What's missing is the *unhappy* path and the *fleet* path: a migration
> safety net and rollback for the server, a server↔client version
> compatibility contract, an inventory of what each client runs, and any
> way for the server to **push** a client update rather than the admin
> re-running the install script by hand.

> **Two channels, one division of labour.** The server cannot push a
> client update today, but two existing channels make it tractable:
> the **Ansible runner (SSH, Phase 6)** does the *privileged install/
> reconcile* step (`apt`/`dpkg`, service restart) — matching the license
> boundary and the periodic-reapply model — while the **event stream /
> `pct-client-bridge` (Phase 8b)** only *notifies and coordinates* (an
> `update.*` event), never performing privileged installs beyond its
> narrow sudoers scope.

Foundational pieces are pulled earlier (cheap now, expensive to retrofit
once clients are deployed):

- Client version reporting at enrolment + heartbeat → **Phase 3**
  ([#164](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/164)).
- Version handshake + N-1 compatibility window on the event stream →
  **Phase 8b**
  ([#165](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/165)).
- Automatic pre-migration DB backup, on the backup utility → **Phase 11**
  ([#166](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/166)).

Phase 14 itself:

- ADR: client update distribution channel — dashboard-hosted apt repo vs
  GitHub Release fetch vs dashboard-proxied; license-boundary note (our
  agent `.deb` is ours to host; GPL tools stay upstream)
  ([#167](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/167)).
- Publish the `pct-client` agent `.deb` from `release.yml` over the chosen
  channel, version-stamped to the release tag
  ([#168](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/168)).
- `client-update` Ansible playbook: install/pin the target version,
  reconcile config, restart services gracefully
  ([#169](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/169)).
- Server-driven update orchestration API + `/admin` UI: per-client / fleet,
  staged (canary) rollout, offline-queue + replay, audit log — reusing the
  Phase 4 transport patterns
  ([#170](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/170)).
- Session-aware update scheduling: never interrupt an active supervised
  session, a grace countdown, or an in-flight force-close; maintenance
  window + override
  ([#171](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/171)).
- `update.*` event types + a low-key user-facing "updating" notification,
  reusing the client-notifications channel
  ([#172](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/172)).
- Server self-update runbook: health-gated boot, documented rollback, and
  the per-release fleet compatibility matrix
  ([#173](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/173)).
- Fleet version dashboard: per-client version drift, "N behind",
  `update_required`, one-click update
  ([#174](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/174)).

Constraints carried from elsewhere in the project: the license boundary is
unchanged (our agent `.deb` is permissive and ours to distribute; GPL
client tools keep coming from the distro/PPA/upstream — `CLAUDE.md`,
`docs/licensing-analysis.md`), and the tamper-resistance ceiling is
unchanged (these are *operations* features, not hardening —
`docs/client-install.md`).

## Alpha rollout — testing gates

The phases above are the *build* plan; this section is the *release* plan —
the points at which the toolkit is put in front of real users, and what must
be true before each. Tracked operationally by the Alpha-1 readiness epic
([#185](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/185)).

### Alpha-1 — "screen-time dogfood" (maintainer + technical, forgiving households)

The first real install: install on a Linux Mint box, enrol it, set per-child
daily/weekly limits and allowed-hours, have Timekpr-nExT enforce them. **Time
limits only** — no content filtering, no usage charts, no graceful
notifications (the device-side Timekpr tray is the user-facing warning).
Enforcement authority is Timekpr-nExT, not an agent (there is none yet).

The core **set-limits → enforce → observe** loop is **code-complete**:
install/enrol (#76/#77), live CRUD→SSH push (#201), audit log (#85), offline
queue (#161), resolver (#176), version reporting (#164), first-run SSH keypair
(#205), client health + Clients page + enrol flow (#196/#194), and the full
`/admin` policy-editor UI — login + Users/Clients/Activities/Groups/Budgets/
links/Schedules/Exceptions (#53 via #189/#244/#246) — have all landed.

**Gate — remaining before first install:**

- Live `timekpra`-over-SSH round-trip test (#157) — *the key confidence gate*:
  the enforcement code is complete and unit-tested, but this confirms the CLI
  grammar against the real binary before trusting it on a child's machine.
- `/admin` smoke/e2e coverage — the one open quality slice of #53 (all editors
  and login are functionally complete; `svelte-check` and the build are green).
- "Add time today" same-day unlock lever
  ([#257](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/257)).

**Fast-follow (not blocking the first install):**

- Save-and-push preview diff (#64) — policy already pushes on save, and client
  health (#196/#194) + the audit log (#85) already let the admin confirm a
  limit took effect, so the diff is a trust/UX nicety rather than a blocker.
- Clear/unmanage a user's limits when a user↔client link is removed (#253).

Assumes each child already has their own Linux account (the toolkit does not
create OS accounts); per-child enforcement requires per-child accounts, since
Timekpr/AW/e2guardian all key on the OS account.

### Alpha-1.5 — add usage visibility (same trusted testers)

**Gate: Phase 5 burndown.** AW event normalisation into `UsageSample`
(#88) + the per-user burndown view (#62), on top of the telemetry transport
that already landed (#86/#162). This is also the correctness check that makes
alpha feedback trustworthy — until the admin can see "Alice used 1h52 of 2h,"
there's no way to confirm enforcement matches reality.

### Alpha-2 — "friends & family" (non-technical households)

**Gate: Phase 8b + Phase 6 (+ Phase 8c).** Do not widen past technical testers
until:

- **Phase 8b** — the `pct-client` agent: warning cadence, grace period,
  graceful per-app close. The raw Timekpr session-kill UX is the main reason
  Alpha-1 is unfit for a non-technical household.
- **Phase 6** — server-pushed e2guardian web filtering + tamper reversion;
  "parental controls" without content filtering reads as incomplete.
- **Phase 8c** — clean lockout / grant-unlock so "out of time → granted more →
  back in" is seamless.

## Out of scope (for now)

- Non-Linux **enforcement** clients (macOS, Windows, Chromebook). The
  mobile/PWA experience in Phase 9 is a *control surface*, not an
  enforcement target — it lets phones view and adjust policy; the
  enforced devices are still Linux desktops.
  - **Windows is the most-requested of these** (parents who keep a
    Windows gaming PC for Easy Anti-Cheat / BattlEye titles but want the
    same time-budget/schedule controls without Microsoft's cloud Family
    Safety). A forward-looking design for a Windows enforcement client —
    sequenced *after* Phase 14, with the cheap "keep these seams clean
    now" tweaks called out — lives in
    [`windows-client-support.md`](windows-client-support.md). It is still
    out of scope for the numbered phases above; the doc exists so we don't
    bake in Linux-only assumptions that are expensive to unwind later.
- Native mobile apps (Android, iOS). The Phase 9 PWA is the mobile
  story.
- Cloud-hosted SaaS multi-tenant model. The deployment target is the
  household / single-admin scenario.

## How to file issues against this roadmap

- One issue per discrete deliverable (a single PR's worth of work).
- Label each with the phase milestone above.
- Link the issue to the roadmap project so it shows up in the board.
- Cross-link to the relevant section of `docs/architecture.md` or another
  design doc.
