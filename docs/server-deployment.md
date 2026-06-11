# Server deployment

The server is published as a single Docker image and intended to run on
TrueNAS SCALE (via its built-in Apps / Docker-Compose support) or any
other OCI-compatible host. This document describes the image design, the
volume layout, and the "fetch GPL components on first run" pattern that
keeps the published image free of bundled GPL binaries.

## Image contents

The image is **dashboard code only**:

- `node:22-slim` base (multi-stage build: TypeScript and the SvelteKit
  frontend are compiled in a builder stage; the runtime stage gets only
  the compiled output and production dependencies).
- The `dashboard` Node package and its non-GPL npm dependencies
  (Fastify, zod, Drizzle ORM, better-sqlite3, ssh2, croner, argon2,
  jose, etc.), plus the static frontend build.
- A stock Python 3 interpreter (PSF-licensed, from the distro's
  `python3-venv` package). It exists **solely** so first-run setup can
  create the isolated Ansible venv in the data volume; no dashboard
  code is Python.
- A small entrypoint script that performs first-run setup and then
  starts the Node server.

The image deliberately does **not** include:

- AdGuard Home (GPL-3.0). Either fetched into the data volume on first
  run (managed mode) or not present at all (external / disabled modes
  — see "AdGuard Home deployment modes" below).
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
inside the image, and the drizzle-kit SQL migrations all live in the
image and are reconciled into `/data` on each start.

## First-run setup

On container start, the entrypoint runs these steps idempotently:

1. **Schema migration** — apply the committed drizzle-kit migrations
   against `/data/policy.sqlite`.
2. **Ansible bootstrap** — if `/data/ansible/venv` is missing, create it
   and `pip install ansible-core` (downloaded from PyPI at runtime, not
   from the image). Sync `playbooks/` from the image.
3. **AdGuard Home bootstrap** — driven by `PCT_ADGUARD_MODE` (see
   "AdGuard Home deployment modes" below). In `managed` mode, the
   first-time fetch downloads the latest stable release from
   `github.com/AdguardTeam/AdGuardHome/releases`, verifies the
   checksum, and writes it to `/data/adguard/AdGuardHome`; the
   dashboard then supervises it as a child process. In `external` mode,
   the dashboard skips the download entirely and validates that it can
   reach the configured AdGuard Home instance's REST API. In `disabled`
   mode (the default), neither happens.
4. **SSH key bootstrap** — if `/data/secrets/ssh/id_ed25519` is absent,
   generate one. The public key is shown in the dashboard's "Add client"
   flow for the admin to install on each new client (or, more commonly,
   for the client install script to fetch via a one-time enrollment URL).
5. Start the Node server on `0.0.0.0:8000` (default).

If any of the optional downloads fail (no network, etc.), the dashboard
starts anyway with the affected feature disabled and surfaces an error
in the admin UI. Core functionality (Timekpr policy, ActivityWatch pull,
e2guardian via Ansible) is not blocked by a missing AdGuard Home.

## AdGuard Home deployment modes

DNS filtering is optional and configurable through `PCT_ADGUARD_MODE`.
This deliberately accommodates the common case where the admin already
runs AdGuard Home on their homelab and does not want a second instance.

| Mode | What the dashboard does | When to use it |
|---|---|---|
| `disabled` (default) | No DNS integration. Per-website rules go through e2guardian on the client only. | If you don't want DNS-level filtering, or you have a different DNS solution you don't want the dashboard to touch. |
| `managed` | Fetches AdGuard Home on first run, supervises it as a child process, owns the config under `/data/adguard/`. | Greenfield homelab with no existing DNS filter; you want the dashboard to be the only thing managing AdGuard Home. |
| `external` | Dashboard makes REST calls against a pre-existing AdGuard Home instance you already run. No download, no supervision. | You already run AdGuard Home (typical homelab setup). The dashboard plugs into it. |

### Configuration

Set via environment variables:

```bash
# disabled (default) — nothing to configure

# managed — dashboard hosts AdGuard Home
PCT_ADGUARD_MODE=managed
PCT_ADGUARD_BIND_ADDR=0.0.0.0:53   # what AdGuard listens on
PCT_ADGUARD_ADMIN_PORT=3000        # AdGuard's own web UI; optional

# external — point at your existing instance
PCT_ADGUARD_MODE=external
PCT_ADGUARD_URL=https://adguard.lan
PCT_ADGUARD_USERNAME=parental-controls
PCT_ADGUARD_PASSWORD_FILE=/run/secrets/adguard_password
# or:
# PCT_ADGUARD_API_TOKEN_FILE=/run/secrets/adguard_token
```

### What the dashboard expects from an external instance

When in `external` mode, the dashboard treats the existing AdGuard Home
as a shared service and confines itself to a well-defined slice of its
configuration:

- A **dedicated AdGuard user account** (created by the admin in
  AdGuard's own UI) with the credentials supplied above. The dashboard
  authenticates as that user.
- A set of **per-client AdGuard "clients"** (in AdGuard's terminology —
  these are network-side client identities, by IP/MAC) that this
  dashboard owns and manages. The dashboard names them with a stable
  prefix (e.g. `pct:alice-laptop`) so it can identify which clients are
  its responsibility and leave everything else alone.
- **Blocked-services and custom-rule entries** scoped to those
  dashboard-owned clients only. The dashboard never edits global rules,
  upstream DNS, or DHCP settings.

This means the admin can keep using their existing AdGuard for
household-wide blocklists, custom DNS, etc., without the dashboard
clobbering any of it.

### License posture is identical in both modes

The dashboard talks to AdGuard Home only via its REST API in either
mode. `managed` mode runs AdGuard as a separate child process under
`/data/adguard/`, fetched from upstream at runtime — exactly the
process boundary required by `licensing-analysis.md`. `external` mode
removes the binary from the deployment entirely; the user runs AdGuard
themselves. Neither mode causes the dashboard to link or import GPL
code.

## TrueNAS SCALE deployment

Two reference compose files; pick the one that matches your AdGuard
mode.

#### A) External AdGuard (typical homelab — you already run AdGuard)

```yaml
services:
  dashboard:
    image: ghcr.io/benseymourodb/linux-parental-controls-toolkit:latest
    container_name: pct-dashboard
    restart: unless-stopped
    ports:
      - "8000:8000"
    volumes:
      - pct_data:/data
    environment:
      - PCT_BASE_URL=https://parentalcontrols.lan
      - PCT_TIMEZONE=America/New_York
      - PCT_ADGUARD_MODE=external
      - PCT_ADGUARD_URL=https://adguard.lan
      - PCT_ADGUARD_USERNAME=parental-controls
      - PCT_ADGUARD_PASSWORD_FILE=/run/secrets/adguard_password
    secrets:
      - adguard_password
volumes:
  pct_data:
secrets:
  adguard_password:
    file: ./secrets/adguard_password
```

#### B) Managed AdGuard (greenfield, dashboard hosts AdGuard too)

```yaml
services:
  dashboard:
    image: ghcr.io/benseymourodb/linux-parental-controls-toolkit:latest
    container_name: pct-dashboard
    restart: unless-stopped
    ports:
      - "8000:8000"          # dashboard UI
      - "53:53/udp"          # AdGuard DNS
      - "53:53/tcp"          # AdGuard DNS
      - "3000:3000"          # AdGuard's own admin UI (optional)
    volumes:
      - pct_data:/data
    environment:
      - PCT_BASE_URL=https://parentalcontrols.lan
      - PCT_TIMEZONE=America/New_York
      - PCT_ADGUARD_MODE=managed
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

`docker pull` a newer image tag and restart. The entrypoint's migration
step applies any new drizzle-kit migrations. The Ansible venv inside
`/data/ansible/venv` is pinned per image release; upgrades reconcile it
on first start under the new tag.
