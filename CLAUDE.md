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
- **Frontend:** Server-rendered Jinja2 templates plus light vanilla
  JS / HTMX. No React, no separate Node build.
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
- **DNS filtering (optional, server-side):** AdGuard Home as a sidecar.
- **Configuration management:** Ansible (agentless, SSH).

### Tools that were considered and rejected

Do not reach for these without updating the design doc:
LittleBrother, UCS / UCC, SaltStack, Puppet, Chef, Pi-hole, FleetDM,
malcontent (Flatpak-only).

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
   GPL components (AdGuard Home, Ansible) are downloaded on first run into
   the data volume. Client-side GPL components (Timekpr-nExT, e2guardian)
   are installed by the client install script via `apt`.
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
  - `dashboard.web` — FastAPI app, routes, templates
  - `dashboard.policy` — policy model, DB access
  - `dashboard.transport.ssh` — SSH + `timekpra` invocation
  - `dashboard.transport.ansible` — playbook orchestration
  - `dashboard.transport.activitywatch` — telemetry pull
  - `dashboard.transport.adguard` — AdGuard Home REST client
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

## When in doubt

- Re-read [`docs/proposed-tech-stack.md`](docs/proposed-tech-stack.md) and
  [`docs/licensing-analysis.md`](docs/licensing-analysis.md).
- If the task seems to require violating a license-boundary rule, stop and
  ask in the issue thread before writing code.
- Prefer using an existing upstream tool over writing new enforcement
  logic. The dashboard's job is orchestration, not enforcement.
