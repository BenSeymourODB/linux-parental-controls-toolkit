# Server deployment

The server is published as a single Docker image and intended to run on
TrueNAS SCALE (via its built-in Apps / Docker-Compose support) or any
other OCI-compatible host. This document describes the image design, the
volume layout, and the "fetch GPL components on first run" pattern that
keeps the published image free of bundled GPL binaries.

## Image contents

The image is **dashboard code only**:

- Python 3.11 slim base.
- The `dashboard` Python package and its non-GPL Python dependencies
  (FastAPI, Uvicorn, SQLAlchemy, Alembic, Pydantic, Jinja2, HTTPX,
  Paramiko or AsyncSSH, APScheduler, etc.).
- A small entrypoint script that performs first-run setup and then
  starts Uvicorn.

The image deliberately does **not** include:

- AdGuard Home (GPL-3.0). Fetched into the data volume on first run, only
  if DNS filtering is enabled.
- Ansible (GPL-3.0). Installed into an isolated venv inside the data
  volume on first run.
- Timekpr-nExT, e2guardian, ActivityWatch. These are client-side and
  installed by `client/install-client.sh` via `apt`.

The licensing rationale lives in
[`licensing-analysis.md`](licensing-analysis.md). The short version: by
not shipping GPL binaries in the image, the dashboard distribution is
unambiguously its own work, and we still satisfy GPL terms for the
components we orchestrate because the user obtains them directly from
their upstream sources.

## Volume layout

A single named volume (`pct_data`) is mounted at `/data` inside the
container.

```
/data
├── policy.sqlite               # canonical policy store
├── secrets/
│   ├── ssh/                    # SSH keys used to reach clients
│   └── api-keys.env
├── ansible/                    # venv + inventory + playbooks
│   ├── venv/                   # populated on first run (pip install ansible)
│   ├── inventory.yml
│   └── playbooks/              # synced from the image's read-only copy
├── adguard/                    # populated on first run if enabled
│   ├── AdGuardHome             # binary fetched from upstream releases
│   └── conf/
└── logs/
```

The dashboard's database schema, the read-only copy of playbooks shipped
inside the image, and Alembic migrations all live in the image and are
reconciled into `/data` on each start.

## First-run setup

On container start, the entrypoint runs these steps idempotently:

1. **Schema migration** — `alembic upgrade head` against
   `/data/policy.sqlite`.
2. **Ansible bootstrap** — if `/data/ansible/venv` is missing, create it
   and `pip install ansible-core` (downloaded from PyPI at runtime, not
   from the image). Sync `playbooks/` from the image.
3. **AdGuard Home bootstrap** — only if the admin has enabled DNS
   filtering in the dashboard. The first-time fetch downloads the latest
   stable release from `github.com/AdguardTeam/AdGuardHome/releases`,
   verifies the checksum, and writes it to `/data/adguard/AdGuardHome`.
   The dashboard then supervises it as a child process.
4. **SSH key bootstrap** — if `/data/secrets/ssh/id_ed25519` is absent,
   generate one. The public key is shown in the dashboard's "Add client"
   flow for the admin to install on each new client (or, more commonly,
   for the client install script to fetch via a one-time enrollment URL).
5. Start Uvicorn on `0.0.0.0:8000` (default).

If any of the optional downloads fail (no network, etc.), the dashboard
starts anyway with the affected feature disabled and surfaces an error
in the admin UI. Core functionality (Timekpr policy, ActivityWatch pull,
e2guardian via Ansible) is not blocked by a missing AdGuard Home.

## TrueNAS SCALE deployment

The reference deployment for TrueNAS SCALE will be provided as a
`docker-compose.yml` (consumed by SCALE's Custom App feature):

```yaml
services:
  dashboard:
    image: ghcr.io/benseymourodb/linux-parental-controls-toolkit:latest
    container_name: pct-dashboard
    restart: unless-stopped
    ports:
      - "8000:8000"          # dashboard UI
      - "53:53/udp"          # only if AdGuard Home is enabled
      - "53:53/tcp"          # only if AdGuard Home is enabled
    volumes:
      - pct_data:/data
    environment:
      - PCT_BASE_URL=https://parentalcontrols.lan
      - PCT_TIMEZONE=America/New_York
volumes:
  pct_data:
```

For LAN-only access, exposing port 8000 directly is fine. For external
access, terminate TLS at a reverse proxy (TrueNAS's built-in or a
separate Nginx Proxy Manager / Caddy instance) and put the dashboard
behind authentication.

## Authentication

- The dashboard ships with single-admin local password auth (Argon2
  hash) suitable for a home deployment behind a LAN.
- Future: optional OIDC integration so a household identity provider
  (FreeIPA, Authentik) can be used.
- Client SSH access uses a single dedicated key generated on first run;
  rotation is a one-click action in the dashboard that pushes a new key
  via the existing connection.

## Backup and restore

The entire deployable state lives under `/data`. A backup is a snapshot
or `tar` of that volume. TrueNAS SCALE's dataset snapshots handle this
natively for the volume that backs `pct_data`. Restoration is restoring
the snapshot and starting the container; no other state is held inside
the image.

## Upgrade path

`docker pull` a newer image tag and restart. The entrypoint's
`alembic upgrade head` handles schema migrations. The Ansible venv inside
`/data/ansible/venv` is pinned per image release; upgrades reconcile it
on first start under the new tag.
