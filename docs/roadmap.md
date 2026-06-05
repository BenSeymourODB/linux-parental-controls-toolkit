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

- Create `server/` Python package layout (`pyproject.toml`, `src/dashboard`,
  `tests/`, `Dockerfile`, `.dockerignore`).
- Pick and pin the dashboard's open-source license file (`LICENSE`) — the
  decision in [`licensing-analysis.md`](licensing-analysis.md) is between
  Option B (MIT/Apache-2.0) and Option C (proprietary). Default
  assumption pending decision: **Apache-2.0**.
- Add `pre-commit` config: `black`, `ruff`, `mypy --strict`.
- Add a minimal FastAPI app that serves a "hello, no policy yet" page.
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
  `Grant`, `IntegrationToken`.
- Alembic migrations.
- Single-admin local password auth (Argon2) for the admin UI.
- **`/api/*` JSON endpoints** for the full policy model (the admin UI
  calls these; the PWA and integrators will too).
- HTMX-driven admin UI on `/admin/*`: users, clients, activities,
  budgets, schedules. Renders Jinja templates that call the same
  service layer the JSON API uses (no privileged in-process shortcuts).
- No transport integration yet; all "push" actions are stubbed to log.

## Phase 3 — Client install script (Linux Mint)

Goal: enrolling a fresh Mint client is one command.

- Implement `client/install-client.sh` per `docs/client-install.md`.
- Enrolment-token endpoint on the dashboard.
- `pct-agent` user provisioning + scoped sudoers.
- ActivityWatch + Timekpr-nExT + e2guardian install and baseline config.
- Self-test that runs at the end of the script.

## Phase 4 — SSH + `timekpra` transport

Goal: dashboard pushes overall session limits to clients.

- AsyncSSH-based transport facade.
- `timekpra` invocations for: set daily/weekly/monthly limits, set
  allowed hours, set PlayTime configuration.
- Offline-queue: changes for offline clients persisted and replayed on
  next reachable probe.
- Audit log of every command issued.

## Phase 5 — ActivityWatch telemetry pull

Goal: dashboard shows actual usage per user per activity.

- APScheduler job that opens SSH port-forwards and pulls AW events.
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

## Phase 8 — Per-activity time enforcement

Goal: when the dashboard sees a per-activity quota exhausted, the activity
is stopped on the client.

- Decision logic in the dashboard based on `UsageSample` rollups.
- Ad-hoc Ansible commands (or a small client-side helper invoked via SSH)
  that kill or AppArmor-deny the relevant process.
- Cool-down + notify-the-user behaviour to avoid thrash.

## Phase 9 — Mobile / PWA experience (`/app`)

Goal: parents and supervised users have a mobile-first, home-screen-
installable view of the system.

- SvelteKit project under `web/app/` that produces a static build
  (`adapter-static`) consumed by FastAPI's `StaticFiles` mount at `/app`.
- PWA basics: manifest, service worker, offline-friendly app shell.
- Per-user status screen: how much time is left today, what's been used,
  upcoming schedule transitions.
- Parent-facing limit-adjustment screens (touch-friendly time pickers,
  swipeable day/week/month views).
- Auth: shared session with the admin UI for the admin role; an
  additional lightweight per-user PIN/passcode model for child users
  who should only see their own data.
- Web Push for "5 minutes left" / "time's up" notifications.
- CI gains a Node build step (no Node runtime in the image).

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

- Reverse-proxy + TLS instructions for non-LAN deployments.
- Multi-admin / OIDC option.
- Backup/restore utility script.
- Documentation pass: per-feature how-tos.
- Optional: tamper-resistance review and AppArmor hardening pass.

## Out of scope (for now)

- Non-Linux **enforcement** clients (macOS, Windows, Chromebook). The
  mobile/PWA experience in Phase 9 is a *control surface*, not an
  enforcement target — it lets phones view and adjust policy; the
  enforced devices are still Linux desktops.
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
