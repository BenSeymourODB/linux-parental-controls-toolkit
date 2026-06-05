# linux-parental-controls-toolkit

A server/client toolkit for administering screen-time, per-application, and
per-website limits across Linux desktops. The server provides a web dashboard
through which an admin defines policy for supervised users; one or more Linux
clients (initial target: **Linux Mint with Cinnamon**) enforce the policy
locally using established open-source tools (Timekpr-nExT, ActivityWatch,
e2guardian, AdGuard Home).

> **Status:** Design phase. No implementation has landed yet. This repository
> currently contains the architecture and licensing analyses that the
> implementation will follow. See [`docs/roadmap.md`](docs/roadmap.md) for the
> work breakdown and the [roadmap project](https://github.com/users/BenSeymourODB/projects/2)
> for issue-level tracking.

## What the product does

For each supervised Linux user account, an admin can set:

- **Overall screen-time budgets** (daily / weekly / monthly), enforced via
  Timekpr-nExT at the session level.
- **Per-activity time quotas**, where "activity" means a desktop application,
  a process group, a website, or a website group.
- **Schedules and exceptions** ("homework time has no Discord", "weekend mornings
  allow YouTube until 11:00").
- **Per-user web filtering** via e2guardian, with optional network-level
  blocking via AdGuard Home.

Telemetry from each client (ActivityWatch) flows back to the dashboard so the
admin can see what was actually used, not just what was allowed.

## Long-term goals

These are not in the initial scope but they shape the architecture today
so we don't paint ourselves into a corner:

- **Mobile-first / PWA experience.** A SvelteKit-built progressive web
  app under `/app` for per-child status dashboards and for parents to
  adjust limits from a phone (home-screen install, push notifications,
  service worker). The Phase 1 scaffolding treats the JSON API as
  first-class so the PWA can land later without refactoring the
  internals. See `docs/roadmap.md` Phase 9.
- **API compatibility with
  [next-digital-wall-calendar](https://github.com/BenSeymourODB/next-digital-wall-calendar).**
  A family calendar and chore-tracking app that should be able to grant
  screen-time rewards when chores or calendar events are completed
  ("Alice cleaned her room → +30 min of overall time today",
  "Bob finished homework → +45 min of YouTube"). This is implemented via
  an authenticated `/api/integrations/*` surface with an immutable
  `Grant` ledger; the calendar app calls in, the dashboard records and
  enforces the grant. See `docs/architecture.md` ("External
  integrations") and `docs/roadmap.md` Phase 10.

## High-level architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Server (Docker container, runs on TrueNAS SCALE / any Linux)    │
│                                                                  │
│   FastAPI (Python 3.11)                                          │
│   ├── /admin        Jinja + HTMX + Svelte islands (desktop UI)   │
│   ├── /app          SvelteKit static PWA (mobile / per-child)    │
│   ├── /api          JSON API (single contract)                   │
│   └── /integrations webhook API (e.g. calendar rewards)          │
│            │                                                     │
│            ▼                                                     │
│   ┌─────────────────────┐                                        │
│   │ Policy + Grant      │  SQLite                                │
│   │ store               │                                        │
│   └─────────────────────┘                                        │
│            │                                                     │
│            ├──▶ SSH / timekpra runner (live policy push)         │
│            ├──▶ Ansible runner (config push, tamper revert)      │
│            └──▶ ActivityWatch pull (telemetry, via SSH tunnel)   │
│                                                                  │
│   ┌────────────────┐                                             │
│   │ AdGuard Home   │  (optional sidecar; pulled at first run)    │
│   └────────────────┘                                             │
└──────────────────────────────────────────────────────────────────┘
            │  SSH (key-auth, port-forwarded API pull)
            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Client (Linux Mint / Cinnamon; other Debian-family supported)   │
│                                                                  │
│   Timekpr-nExT  ◀── timekpra CLI over SSH                        │
│   ActivityWatch ──▶ aw-server REST (port 5600, SSH-tunnelled)    │
│   e2guardian    ◀── config files + reload via Ansible            │
│   iptables      ◀── per-UID redirect to e2guardian               │
└──────────────────────────────────────────────────────────────────┘
```

See [`docs/architecture.md`](docs/architecture.md) for the detailed view.

## Server: runs as a Docker container

The server is packaged as a single Docker image you can deploy on TrueNAS
SCALE (or any Docker / OCI host). Persistent data (the policy SQLite DB,
SSH keys for clients, Ansible inventory) lives in mounted volumes.

### GPL-aware bundling

The dashboard itself is original code with no GPL linkage; it only ever
talks to GPL components across process or network boundaries (see
[`docs/licensing-analysis.md`](docs/licensing-analysis.md)). To keep the
published image free of bundled GPL binaries, GPL-licensed dependencies are
**downloaded on first run** rather than baked into the image:

- **AdGuard Home** (GPL-3.0): downloaded from upstream releases the first
  time the admin enables DNS filtering, then run as a sidecar.
- **Ansible** (GPL-3.0): installed into a separate, isolated venv inside the
  container's data volume on first run.
- **Timekpr-nExT, ActivityWatch, e2guardian** (GPL-3.0 / MPL-2.0 / GPL-2.0):
  installed on the *client* by the client enrollment script via the
  distribution's own package manager; the server never ships their binaries.

This is consistent with the licensing analysis's recommendation: keep the
dashboard's process boundary clean, and avoid distributing GPL binaries as
part of the dashboard image. See [`docs/server-deployment.md`](docs/server-deployment.md)
for the deployment story.

## Client install

A `scripts/install-client.sh` (forthcoming) sets up a Linux Mint client:
installs Timekpr-nExT, ActivityWatch, e2guardian, the chosen browser's
ActivityWatch extension, configures the supervised user(s), drops an SSH
key for the server's Ansible user, and registers the client with the
server. See [`docs/client-install.md`](docs/client-install.md).

## Documentation map

| Document | What's in it |
|---|---|
| [`docs/proposed-tech-stack.md`](docs/proposed-tech-stack.md) | The four-layer architecture and the rationale for each tool choice. |
| [`docs/licensing-analysis.md`](docs/licensing-analysis.md) | License inventory, copyleft analysis, and the process-boundary rules we follow. |
| [`docs/architecture.md`](docs/architecture.md) | Detailed component / data-flow diagrams and the policy model. |
| [`docs/server-deployment.md`](docs/server-deployment.md) | Docker image design, TrueNAS SCALE deployment, GPL-component fetch-on-first-run pattern. |
| [`docs/client-install.md`](docs/client-install.md) | Client enrollment script design and Linux Mint specifics. |
| [`docs/roadmap.md`](docs/roadmap.md) | Phased milestone plan; the basis for GitHub issues. |
| [`CLAUDE.md`](CLAUDE.md) | Guidance for AI coding agents working in this repo. |

## License

The dashboard and tooling in this repository are intended to be released
under a permissive license (final choice TBD — see Option B / Option C in
[`docs/licensing-analysis.md`](docs/licensing-analysis.md)). All GPL-licensed
upstream tools are used across process boundaries and are not redistributed
as part of this repository.
