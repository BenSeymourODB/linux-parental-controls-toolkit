# CLAUDE.md

Guidance for AI coding agents (Claude Code and others) working in this
repository. Read this before writing or changing code. The two documents in
`docs/` (`proposed-tech-stack.md` and `licensing-analysis.md`) are the
authoritative sources; this file summarises the rules that matter when
writing code.

---

## What this project is

A server/client toolkit that lets an admin set time and content limits on
specific Linux user accounts:

- **Server**: a custom web dashboard (Python, FastAPI, SQLite) packaged as
  a Docker container. Orchestrates clients over SSH and via Ansible.
- **Client**: a supervised Linux desktop. Initial target is **Linux Mint
  with Cinnamon** (Ubuntu/Debian-family). Enforcement uses existing
  open-source tools — we do not reimplement screen-time or web-filtering
  logic.

The dashboard is the only fully custom component. Everything else is an
existing tool we configure and orchestrate.

## Tech stack — what to use, what not to use

### Server side (this repo's primary code)

- **Language:** Python 3.11+.
- **Web framework:** FastAPI (with Uvicorn). Do not introduce Flask, Django,
  or a separate frontend build pipeline unless the design doc is updated.
- **Database:** SQLite for the policy store. Migrations via Alembic.
- **Frontend:** Two surfaces, both served by the same FastAPI process:
  - `/admin/*` — server-rendered Jinja2 + HTMX, plus small Svelte
    "islands" where genuine interactivity helps (live burndown chart,
    drag-to-reorder editors). Desktop admin experience.
  - `/app/*` — a SvelteKit static build (PWA-capable) for the
    mobile-first user/parent experience (per-child status, parents
    adjusting limits from a phone). Talks only to `/api/*`.
  - `/api/*` — JSON API; the single contract for both frontends **and
    for external integrations** (see "External integrations" below).
  Both frontends are built at image-build time. **No runtime Node
  process** — the image stays Python-only at runtime. CI gains a Node
  build step.
- **Process management:** `subprocess` / `asyncio` subprocess for invoking
  external GPL tools (`timekpra`, `ansible-playbook`). No Python imports of
  GPL projects (see "License boundaries" below).
- **Packaging:** Single Docker image. Persistent state lives in a mounted
  volume. The image must not contain GPL binaries; see
  [`docs/server-deployment.md`](docs/server-deployment.md).

### Client side

- **Session limits:** Timekpr-nExT (driven remotely via `timekpra` over SSH).
- **Activity tracking:** ActivityWatch (`aw-server`, `aw-watcher-window`,
  `aw-watcher-afk`, plus the browser extension).
- **Web filtering:** e2guardian with per-Linux-UID filter groups; iptables
  OUTPUT-chain redirect to its proxy port.
- **Client agent:** small Python daemon installed by the client install
  script — system-level `pct-client-bridge` (event channel from the
  server) plus a per-supervised-user `pct-client-agent` (notifications,
  sound, time-remaining cadence, per-app force-close). The agent does
  not replace Timekpr-nExT's session enforcement; it adds notifications
  and a graceful end-of-budget experience around it. See
  [`docs/client-notifications.md`](docs/client-notifications.md).
- **DNS filtering (optional, server-side):** AdGuard Home in one of
  three modes — `disabled` (default), `managed` (dashboard fetches and
  supervises a sidecar), or `external` (dashboard talks to an existing
  AdGuard Home instance the homelab already runs). All three integrate
  only via AdGuard's REST API. See
  [`docs/server-deployment.md`](docs/server-deployment.md).
- **Configuration management:** Ansible (agentless, SSH).

### Tools that were considered and rejected

Do not reach for these without updating the design doc:
LittleBrother, UCS / UCC, SaltStack, Puppet, Chef, Pi-hole, FleetDM,
malcontent (Flatpak-only).

## External integrations

The dashboard exposes an authenticated JSON API at `/api/*` that is the
single source of truth for both built-in frontends and for external
systems. The first planned external integrator is
[next-digital-wall-calendar](https://github.com/BenSeymourODB/next-digital-wall-calendar),
which will call the dashboard to **grant** screen-time rewards when
chores or calendar events are completed (e.g. "Alice finished her
chores → grant +30 minutes of overall time today" or "+45 minutes of
YouTube"). Design rules that apply now, even before this is built:

- All inbound external traffic goes through `/api/*`; never expose a
  separate side-channel.
- Per-integration API tokens (scoped, revocable, rate-limited).
- Grant requests are **idempotent** by an integration-supplied
  `source_ref` so a retried calendar webhook does not double-grant.
- Grants are recorded in an immutable ledger (`Grant` entity, see
  `docs/architecture.md`) so the admin can audit who gave what time and
  why, and revoke if needed.
- Grants are additive adjustments on top of the policy, not a
  replacement for it. The policy model stays the source of the
  baseline; grants are a separate layer.

## License boundaries — non-negotiable

The dashboard is **not** a derivative work of any GPL component. This is
true only as long as we keep process and network boundaries between the
dashboard and GPL code. Concrete rules:

1. **Never `import` a GPL project's Python modules.** Specifically:
   no `import timekpr*`, no `import ansible.*` from dashboard code.
   Ansible is invoked as a subprocess (`ansible-playbook ...`).
2. **Talk to `timekpra` as a subprocess.** Use `subprocess.run` /
   `asyncio.create_subprocess_exec`. Pass arguments via the CLI; parse
   stdout. Do not parse Timekpr-nExT's on-disk state files using its own
   parsing code.
3. **Talk to ActivityWatch and AdGuard Home over their REST APIs only.**
   No source-level integration.
4. **Do not bundle GPL binaries inside the dashboard Docker image.**
   GPL components are kept out of the image: Ansible is installed into
   an isolated venv inside the data volume on first run; AdGuard Home
   is either fetched at first run (managed mode), pointed at an
   existing instance (external mode), or skipped entirely (disabled
   mode). Client-side GPL components (Timekpr-nExT, e2guardian) are
   installed by the client install script via `apt`.
5. **e2guardian** is configured by writing config files and signalling a
   reload. No code-level integration.

If any of these rules ever becomes inconvenient, **stop and update the
design docs first**; do not silently collapse the process boundary.

See [`docs/licensing-analysis.md`](docs/licensing-analysis.md) for the
full reasoning.

## Code conventions

- Format with **black**, lint with **ruff**. Both should be wired into a
  pre-commit hook once the codebase exists.
- Type-annotate all public functions. Run **mypy** in `--strict` mode for
  the dashboard package.
- Keep modules small and per-responsibility. The dashboard already has a
  natural split:
  - `dashboard.web` — FastAPI app: mounts `/api`, `/admin`,
    `/app` (static), `/integrations`
  - `dashboard.api` — DTOs, JSON routes used by both frontends and by
    external integrations
  - `dashboard.policy` — policy model, DB access, grant ledger
  - `dashboard.integrations` — external-system inbound APIs (e.g. the
    family-calendar rewards endpoint; see `docs/architecture.md`)
  - `dashboard.transport.ssh` — SSH + `timekpra` invocation
  - `dashboard.transport.ansible` — playbook orchestration
  - `dashboard.transport.activitywatch` — telemetry pull
  - `dashboard.transport.adguard` — AdGuard Home REST client
  - `dashboard.events` — WebSocket server-to-client event stream
    (`grant.applied`, `policy.changed`, `enforce.force_close`, etc.;
    see `docs/client-notifications.md`)
- Tests live in `tests/` mirroring the package layout. Use `pytest`.
- Do not introduce a new dependency without a sentence in the PR
  description explaining why an existing one doesn't suffice.

## Repository layout (target)

```
.
├── CLAUDE.md                 # this file
├── README.md                 # human-facing overview
├── docs/                     # architecture, deployment, licensing, roadmap
├── server/                   # the Docker-packaged dashboard (Python)
│   ├── pyproject.toml
│   ├── src/dashboard/...
│   ├── tests/
│   └── Dockerfile
├── client/                   # client-side install scripts and templates
│   ├── install-client.sh
│   └── ansible/              # playbooks invoked by the server
└── scripts/                  # dev utilities (lint, build, etc.)
```

This layout is the target; commit it in pieces as features land rather
than scaffolding everything up front.

## Working on this repo

- Designated feature branch: `claude/fervent-galileo-Bb2il`. Do not push
  elsewhere without explicit approval.
- All non-trivial work should be tracked by an issue on the
  [roadmap project](https://github.com/users/BenSeymourODB/projects/2).
- Keep PRs small and focused on one milestone item at a time.

## Tamper resistance is deliberately bounded

The client-side hardening described in
[`docs/client-install.md`](docs/client-install.md) ("Tamper resistance
posture") is the **ceiling**, not the starting point. Do not propose
or implement:

- Anti-tamper hooks, kernel modules, eBPF probes, or other low-level
  enforcement techniques.
- Obfuscation of agent binaries or configuration.
- Lockdown of `/etc`, `/usr`, or boot media against root access.
- Any feature whose purpose is "make it harder for the supervised
  user to circumvent the system."

The design assumes a household context: parent admin, child user.
If the supervised user has reached the level of skill required to
defeat the documented protections, they have **outgrown the product**
and the right response is a parent-child conversation, not an arms
race in software. A bug report that boils down to "my advanced
teenager found a workaround" is not a defect to chase; it's a
signal that the product is no longer the right fit for that user.

If a task seems to call for hardening beyond what's already
documented, push back on the request rather than implementing it.

## When in doubt

- Re-read [`docs/proposed-tech-stack.md`](docs/proposed-tech-stack.md) and
  [`docs/licensing-analysis.md`](docs/licensing-analysis.md).
- If the task seems to require violating a license-boundary rule, stop and
  ask in the issue thread before writing code.
- Prefer using an existing upstream tool over writing new enforcement
  logic. The dashboard's job is orchestration, not enforcement.
