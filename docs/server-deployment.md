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
├── apt/
│   └── timekpr/                # managed timekpr-next mirror (if enabled, #389)
├── backups/                    # automatic pre-migration snapshots (#166)
└── logs/
```

The dashboard's database schema, the read-only copy of playbooks shipped
inside the image, and the drizzle-kit SQL migrations all live in the
image and are reconciled into `/data` on each start.

`DATABASE_URL` points at the policy store and defaults to
`/data/policy.sqlite`. It accepts two interchangeable forms: a bare
filesystem path (`/data/policy.sqlite`) and the libsql `file:` URL form
(`file:/data/policy.sqlite`, the form CI's migration job and
`drizzle.config.ts` use). `better-sqlite3` only understands bare paths, so
both the settings loader and `drizzle.config.ts` strip a leading `file:` —
drizzle-kit (migrate/check) and the runtime connection therefore always open
the same file whichever form you set.

## First-run setup

On container start, the entrypoint and the Node server run these steps
idempotently:

1. **Schema migration** — the Node server applies the committed migrations
   **in-process on boot**, against `/data/policy.sqlite`, using drizzle-orm's
   `better-sqlite3` migrator (not `drizzle-kit`, which stays a build-time-only
   dev dependency and is never shipped in the runtime image). The migrator is
   idempotent — it tracks applied migrations in its own journal — so the
   entrypoint itself runs no migration step, and the runtime and migrations
   always open the same `DATABASE_URL` file with no double-migration hazard
   (issues #49, #39). **Before** applying any *pending* migration to an existing
   store, the server first takes an automatic pre-migration snapshot of
   `policy.sqlite` (issue #166) — see "Backup and restore" → "Automatic
   pre-migration snapshot" below — so a regretted upgrade is recoverable; a
   fresh or already-up-to-date database is skipped.
2. **Ansible bootstrap** — the Node server ensures the venv **in-process on
   boot** (issue #39), mirroring the in-process migrator and SSH keygen above:
   if `<PCT_ANSIBLE_DIR>/venv/bin/ansible-playbook` is missing it creates the
   venv and `pip install ansible-core==<PCT_ANSIBLE_CORE_VERSION>` (downloaded
   from PyPI at runtime, not bundled in the image), then records the version in
   a sentinel inside the venv so an image upgrade that bumps the pin reconciles
   it (see "Upgrade path"). It also syncs `playbooks/` from the image's
   read-only copy (`PCT_ANSIBLE_PLAYBOOK_SRC`) — a missing source is a logged
   no-op. `python3`/`pip`/`ansible-playbook` are all driven **as subprocesses**,
   never linked in-process (`docs/licensing-analysis.md`); the image ships only
   a stock `python3-venv` for this, no Ansible binary. The directory root is
   `PCT_ANSIBLE_DIR` (default `/data/ansible`); the Phase-6 runner
   (`transport/ansible`) execs `ansible-playbook` from `<PCT_ANSIBLE_DIR>/venv/
   bin/` against playbooks in `<PCT_ANSIBLE_DIR>/playbooks/`. The bootstrap runs
   in the background after the HTTP listener is up (a slow `pip install` does not
   delay startup) and never crashes the process: a network-less first run leaves
   Ansible disabled with the reason surfaced at `GET /api/system/ansible` for the
   admin UI.
3. **AdGuard Home bootstrap** — driven by `PCT_ADGUARD_MODE` (see
   "AdGuard Home deployment modes" below). In `managed` mode, the
   first-time fetch downloads a release from
   `github.com/AdguardTeam/AdGuardHome/releases` (the latest stable, or a
   release pinned with `PCT_ADGUARD_VERSION`), verifies its SHA-256
   against the release `checksums.txt`, and writes it to
   `<PCT_ADGUARD_DATA_DIR>/AdGuardHome` (default `/data/adguard/`). A
   minimal dashboard-owned seed `AdGuardHome.yaml` is written once (web/REST
   UI bound to `127.0.0.1:<PCT_ADGUARD_ADMIN_PORT>`, DNS to
   `PCT_ADGUARD_BIND_ADDR`) so it boots headless, then the dashboard
   supervises it as a child process — restarting it with capped backoff on
   an unexpected exit and stopping it gracefully on shutdown. Like the
   Ansible bootstrap, this runs in the background after the HTTP listener is
   up and never crashes the process: a failed fetch leaves managed DNS
   disabled with the reason surfaced at `GET /api/system/adguard-managed`.
   In `external` mode, the dashboard skips the download entirely and
   validates that it can reach the configured AdGuard Home instance's REST
   API. In `disabled` mode (the default), neither happens.
4. **SSH key bootstrap** — if `/data/secrets/ssh/id_ed25519` is absent, the
   Node server generates an Ed25519 key pair **in-process on boot** (issue #39,
   via `node:crypto` — the runtime image ships no `ssh-keygen` binary, mirroring
   the in-process migrator above). The private key is written `0600` at
   `PCT_SSH_PRIVATE_KEY_PATH` (default `/data/secrets/ssh/id_ed25519`) and the
   public key `0644` at `PCT_SSH_PUBLIC_KEY_PATH` (default
   `/data/secrets/ssh/id_ed25519.pub`). The step is idempotent — an existing key
   is **never** regenerated, so clients that already authorized it keep working.
   The public key is shown in the dashboard's "Add client" flow for the admin to
   install on each new client (or, more commonly, for the client install script
   to fetch via a one-time enrolment token): the client-enrolment response
   (`POST /api/clients/enrol`, #77) returns it so the client can authorize the
   dashboard. If key generation fails (e.g. an unwritable data volume) the
   dashboard still starts and the enrol response carries `sshPublicKey: null`
   until the problem is fixed.
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
PCT_ADGUARD_BIND_ADDR=0.0.0.0:53   # what AdGuard's DNS server listens on
PCT_ADGUARD_ADMIN_PORT=3000        # AdGuard's web/REST UI (bound to localhost)
PCT_ADGUARD_DATA_DIR=/data/adguard # binary + seed config + work dir
PCT_ADGUARD_VERSION=v0.107.65      # optional: pin a release; latest stable if unset

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

## Timekpr-nExT package mirror deployment modes

Installing Timekpr-nExT on a client normally pulls it from the distro
repository (or, opt-in, the upstream Launchpad PPA). On a slow link the
PPA path stalls the enrolment, and the distro version can lag the upstream
fixes we need. To take Launchpad off the client's critical path and give
the fleet a fresher version, the dashboard can host its own mirror of the
`timekpr-next` package, configured through `PCT_TIMEKPR_MIRROR`. This is
modelled on the AdGuard Home trichotomy above and decided in
[`docs/adr/0011-server-hosted-upstream-package-mirror.md`](adr/0011-server-hosted-upstream-package-mirror.md)
(tracking issue #389).

> **Status:** this release ships the configuration seam only (issue #391).
> The background fetch/refresh job (#392), the served apt index + enrol-time
> advertisement (#393), and the client-side repo path (#394) land in
> subsequent Phase-14 slices; setting `managed`/`external` has no runtime
> effect yet.

| Mode | What the dashboard does | When to use it |
|---|---|---|
| `disabled` (default) | No mirror. The client installs `timekpr-next` from the distro repo; the upstream PPA stays opt-in on the client. | You're fine with the distro version, or you accept the PPA round-trip at install time. |
| `managed` | Maintains a small apt repository under `/data/apt/timekpr/`, refreshed from upstream in the background and served over the LAN; clients point apt at the dashboard at enrol. | You want fast, up-to-date installs with Launchpad off the client's critical path, and you want the dashboard to own the mirror. |
| `external` | Points clients at an apt repository you already host on the LAN. No fetch, no serving. | You already run an apt mirror for `timekpr-next` and just want clients to use it. |

### Configuration

Set via environment variables:

```bash
# disabled (default) — nothing to configure

# managed — the dashboard hosts and refreshes the mirror
PCT_TIMEKPR_MIRROR=managed
PCT_TIMEKPR_MIRROR_DIR=/data/apt/timekpr        # apt repo lives here
PCT_TIMEKPR_MIRROR_PACKAGE=timekpr-next         # or timekpr-next-beta
PCT_TIMEKPR_MIRROR_VERSION=0.5.5                # optional: pin a version; newest if unset

# external — point at an apt repo you already host
PCT_TIMEKPR_MIRROR=external
PCT_TIMEKPR_MIRROR_URL=https://apt.lan/timekpr
```

The mirrored **package/channel is chosen on the server**
(`PCT_TIMEKPR_MIRROR_PACKAGE`, stable or beta), so a client never has to
know which channel it gets.

### License posture

`timekpr-next` is GPL, so the mirror follows exactly the AdGuard
managed-mode precedent: in `managed` mode the mirror is materialised in the
`/data` volume **at runtime and never baked into the image**, so the
published image stays GPL-free and `license-guard.yml` (which scans the
image) is unaffected. The dashboard only *fetches* and *serves files* (and,
where practical, shells packaging tools out as subprocesses) — no GPL code
is linked in-process. Source-availability is met by a documented upstream
source pointer, with source-package mirroring as an optional enhancement.
See [`docs/licensing-analysis.md`](licensing-analysis.md) and ADR 0011.

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
      - PCT_SECRET_KEY=change-me-to-a-long-random-string # required: signs the session cookie
      - PCT_DEFAULT_TZ=America/New_York # server-default timezone for budget rollover
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
      - PCT_SECRET_KEY=change-me-to-a-long-random-string # required: signs the session cookie
      - PCT_DEFAULT_TZ=America/New_York # server-default timezone for budget rollover
      - PCT_ADGUARD_MODE=managed
volumes:
  pct_data:
```

For LAN-only access, exposing port 8000 directly is fine. For external
access, terminate TLS at a reverse proxy (TrueNAS's built-in or a
separate Nginx Proxy Manager / Caddy instance) and put the dashboard
behind authentication. See
[`reverse-proxy-tls.md`](reverse-proxy-tls.md) for a full guide —
copy-pasteable Caddy / nginx / Traefik configs, how to proxy the
`/api/events/stream` WebSocket, the connectivity model (the proxy fronts
the HTTP surface only; SSH to clients stays LAN-side), and the
application-layer caveats behind a proxy.

The reverse proxy is also where volumetric/DoS protection belongs — the
dashboard does not rate-limit by request volume. It does apply a small
per-IP **failed-attempt** limiter in the application layer to the two
surfaces that face unauthenticated callers (the admin login and the
token-authenticated `POST /api/clients/enrol` enrolment exchange, issue
#154), as cheap defence-in-depth that holds even with no proxy in front;
that is throttling of *failures*, not a substitute for proxy-level rate
limiting. That limiter keys on `request.ip`; behind a proxy, set
`PCT_TRUST_PROXY` (off by default) so it sees the real client IP rather
than the proxy's — see
[`reverse-proxy-tls.md`](reverse-proxy-tls.md) → "Client IP and the
failed-attempt limiter" (#235).

## Authentication

- The dashboard ships with single-admin local password auth (Argon2
  hash) suitable for a home deployment behind a LAN.
- **Scope boundary (deliberate).** This is *one* admin login, not a user
  system. The policy-model `User` is a supervised person, not an auth
  principal (see [`architecture.md`](architecture.md) → "Policy model"
  and [`adr/0002-client-dashboard-shell.md`](adr/0002-client-dashboard-shell.md)).
  Phase 2 auth is intentionally minimal — verify a single Argon2id hash,
  set a signed session cookie keyed on `PCT_SECRET_KEY`, guard the
  routes — implemented with `argon2` plus `@fastify/cookie` (see
  issue #52). Do not pull in a multi-user auth framework for this;
  accounts, roles, MFA, federation, and self-registration are explicitly
  out of scope until the identity work below.
- **First-admin bootstrap.** On first run, if no admin credential exists
  yet and **both** `PCT_ADMIN_USERNAME` and `PCT_ADMIN_PASSWORD` are set,
  the dashboard seeds the single admin row from them. The password is
  Argon2id-hashed immediately on seeding and the plaintext is never
  stored; only the hash is persisted (in the `admin_credentials` table,
  a singleton enforced by a `CHECK (id = 1)` constraint). Seeding is
  idempotent — once an admin exists it is never reseeded or overwritten,
  so you can drop `PCT_ADMIN_PASSWORD` from the environment after the
  first successful start. If the variables are absent and no admin
  exists, the dashboard logs a warning and login stays disabled until an
  admin is configured. Until `PCT_SECRET_KEY` is set the auth endpoints
  and the admin guard fail closed with `503 auth_not_configured` (a
  session cannot be signed without it), so set a long random
  `PCT_SECRET_KEY` in any real deployment.
- **Session cookie.** The session is a signed (`PCT_SECRET_KEY`),
  `HttpOnly`, `SameSite=Strict` cookie carrying a small non-secret
  payload; it expires after 7 days. `SameSite=Strict` closes off CSRF
  against the cookie-authenticated mutating routes. The cookie is not
  marked `Secure` (the default LAN deployment is plain HTTP on port
  8000); when terminating TLS at a reverse proxy, that proxy is the
  appropriate place to enforce HTTPS.
- **Per-user PIN sessions (child `/app` access).** Separate from the admin
  login above, a supervised `User` may be given a numeric PIN (4–10 digits)
  so a child can open the mobile `/app` surface and see **only their own**
  data (Phase 9, #112). This does **not** make `User` a general account or an
  admin: it is a deliberately narrow, lightweight credential.
  - The admin sets, resets, or clears a user's PIN from `/admin`
    (`PUT`/`DELETE /api/users/:userId/pin`); only its Argon2id hash is stored
    (in a dedicated `user_pins` table, never on the widely-read `users` row),
    and the response only ever reveals *whether* a PIN is set.
  - A child signs in at `/app` with their **user id + PIN**
    (`POST /api/app/session`), which issues a second signed cookie
    (`pct_pin_session`, `HttpOnly`, `SameSite=Strict`, **12-hour** expiry —
    shorter than the admin week because it is a shared family device). Failed
    attempts are throttled per `(user, source IP)` — enough to cut off online
    guessing from any one source, without letting an attacker lock a child out
    of their *own* device from a different IP — and an unknown user / unset PIN
    takes the same time as a wrong PIN, so the endpoint cannot be used to
    enumerate which accounts exist. There is intentionally **no unauthenticated endpoint that
    lists users** — login is by id, not a roster picker.
  - **Deny-by-default scoping.** A PIN session reaches a route only if that
    route explicitly opts into the `requirePinSession` guard and serves *only*
    the session's own user; every other route keeps the admin guard and rejects
    a PIN session outright. So a PIN login can never read another user's data,
    and a PIN session is never an admin session (or vice versa). The
    own-data screens build on this guard in #110 / #111.
  - This browser PIN path is distinct from the Phase-12 client "My Time"
    dashboard, which authenticates from the Linux session (`linux-uid → User`),
    not a PIN (see [`adr/0002-client-dashboard-shell.md`](adr/0002-client-dashboard-shell.md)).
- Future: optional OIDC integration so a household identity provider
  (FreeIPA, Authentik) can be used. When that (Phase 11 multi-admin/OIDC)
  or the larger centralised-identity work (stretch epic #24 → #26:
  accounts, per-family roles, TOTP MFA, OIDC-as-RP, invite-co-parent)
  is picked up, **evaluate a managed TypeScript auth library such as
  [Better-auth](https://www.better-auth.com/) before hand-rolling** —
  it is Fastify-compatible and has a Drizzle adapter, and that feature
  set is exactly what such a library exists to provide. Reconcile its
  managed tables with this repo's committed drizzle-kit migrations as
  part of that evaluation.
- Client SSH access uses a single dedicated key generated on first run;
  rotation is a one-click action in the dashboard that pushes a new key
  via the existing connection.

## Backup and restore

The entire deployable state lives under `/data`, and most of it is
**regenerated on first run** (see "First-run setup"): the Ansible venv is
`pip`-installed, the playbooks are synced from the image, and the AdGuard Home
binary is refetched from upstream. A useful backup therefore captures only the
**non-regenerable** state, and must capture the policy store *consistently* — a
hot `cp` of a live SQLite file can grab a torn page or miss an un-checkpointed
WAL and restore to corruption.

`scripts/pct-data-backup.sh` does both. It takes a transactionally consistent
snapshot of `policy.sqlite` via SQLite's online backup (`sqlite3 … ".backup"`,
safe even while the dashboard is running) and packs the non-regenerable state
into one owner-only `tar.gz`:

| Path | In a backup? | Why |
|---|---|---|
| `policy.sqlite` | ✅ consistent snapshot | the canonical policy store |
| `secrets/` | ✅ verbatim (perms preserved) | SSH key + API keys; losing the SSH key means re-authorizing every client |
| `adguard/conf/` | ✅ if present | managed-mode config the dashboard owns |
| `ansible/inventory.yml` | ✅ if present | the dashboard's inventory |
| `ansible/venv/`, `ansible/playbooks/` | ❌ | reinstalled / synced on first run |
| `adguard/AdGuardHome` (binary) | ❌ | refetched from upstream on first run |
| `logs/` | ❌ | runtime logs, not state |

```bash
# Back up the running deployment's volume (archive defaults to ./pct-data-backup-<UTC>.tar.gz):
scripts/pct-data-backup.sh backup --data-dir /data --output /backups/pct-$(date -u +%F).tar.gz

# Restore — stop the dashboard first so nothing is writing /data, then:
docker compose stop dashboard
scripts/pct-data-backup.sh restore --data-dir /data --force /backups/pct-2026-06-19.tar.gz
docker compose start dashboard   # first-run setup re-creates the venv / AdGuard binary
```

Restore refuses a non-empty `--data-dir` without `--force` so it can't clobber a
live deployment by accident. With `--force` it **replaces** the in-scope paths
(`policy.sqlite` and its WAL/SHM sidecars, `secrets/`, `adguard/conf/`,
`ansible/inventory.yml`) wholesale rather than merging onto whatever was there —
so a restore reproduces exactly the backed-up state and never resurrects a
rotated key or replays a stale WAL — while leaving the regenerable siblings (the
Ansible venv, the AdGuard binary) untouched. It then re-runs `PRAGMA
integrity_check` on the restored database. The host needs `sqlite3` and `tar` on
its `PATH`.

If your storage does volume-level snapshots (e.g. TrueNAS SCALE dataset
snapshots of `pct_data`), those remain a valid coarse backup of the whole
volume — but take them with the container stopped, since they copy
`policy.sqlite` at the file level rather than through the SQLite backup API.

### Automatic pre-migration snapshot

`scripts/pct-data-backup.sh` is the *manual* path. The dashboard also takes an
**automatic** snapshot at the one moment a backup matters most and is easiest to
forget — a server upgrade that ships new schema migrations (issue #166).

On boot, **before** the in-process migrator (see "First-run setup" step 1)
applies any *pending* migration to an already-migrated `policy.sqlite`, the
server snapshots it with SQLite's `VACUUM INTO` (a transactionally consistent,
standalone copy — never a hot file copy) to
`/data/backups/pre-migrate-<UTC>.sqlite`. A fresh database — or one already at
the current schema — is skipped: there is nothing to lose. The last
`PCT_PRE_MIGRATION_BACKUP_RETAIN` snapshots (default 5) are kept; older ones are
pruned.

If a migration then fails, the server **does not start serving on a
half-migrated database** — it logs the failure and exits — and the snapshot is
left in place. To recover, stop the container, restore the named snapshot over
`policy.sqlite`, and start the **prior** image tag:

```bash
docker compose stop dashboard
# Restore a specific pre-migration snapshot as the policy store:
cp /data/backups/pre-migrate-20260620T091500123Z.sqlite /data/policy.sqlite
rm -f /data/policy.sqlite-wal /data/policy.sqlite-shm   # drop stale sidecars
# Pin docker-compose back to the previous image tag, then:
docker compose start dashboard
```

The behaviour is controlled by `PCT_PRE_MIGRATION_BACKUP` (default `true`),
`PCT_PRE_MIGRATION_BACKUP_DIR` (default `/data/backups`), and
`PCT_PRE_MIGRATION_BACKUP_RETAIN` (default `5`). Snapshotting is best-effort: if
it cannot write (e.g. an unwritable `/data/backups`) the server logs the error
loudly and still migrates — the migrator's own failure remains the boot health
gate — so disable it only if you snapshot `/data` externally.

## Data retention

The dashboard keeps a bounded history of *dated* data and lets the admin
tune how long. Retention has two layers:

- A **global default window**, set with `PCT_RETENTION_DEFAULT_DAYS`
  (default `365` — one year). It applies to every retention category that
  has no override. It must be a positive integer; an absurdly large value
  is rejected at startup. "Effectively forever" is the per-category
  keep-forever mode below, not a giant day count here.
- **Per-category overrides**, stored in the policy DB and managed at
  runtime through the admin API (`GET` / `PUT` / `DELETE
  /api/retention/:category`). Each override is either a custom day count
  or "keep forever". A category with no override inherits the default.

The retention **categories** are the dated tables that have an "age"
(grounded in [`docs/adr/0005-recurrence-and-date-scoping.md`](adr/0005-recurrence-and-date-scoping.md)
§4 — recurrence rules themselves are *not* dated and are never purged):

| Category         | What it covers                                                       | A row is purgeable once… |
| ---------------- | -------------------------------------------------------------------- | ------------------------ |
| `usage_samples`  | ActivityWatch usage history                                          | its interval **ended** (`ended_at`) longer ago than the window |
| `grant_ledger`   | the immutable grant ledger                                           | it has **expired** (`expires_at`) longer ago than the window — so an active grant is never purged, and revocation (a column on the grant row) is never orphaned |
| `audit_log`      | transport audit entries                                              | it was recorded (`at`) longer ago than the window |
| `date_overrides` | date-specific policy rows wholly in the past (an exception past its expiry, a schedule/group-schedule past its `effective_to`) | the override's window **ended** longer ago than the window; open-ended recurrence rules (null `effective_to`) are never dated data and are never purged |

Each category keys its "age" on the *end* of the record's relevant window, so
a purge only ever removes data that is wholly in the past — an active or
future-dated record can never be selected.

Purging is **automatic**. A croner-scheduled job (#137) runs on the cadence set
by `PCT_RETENTION_PURGE_CRON` (default `0 3 * * *` — 03:00 daily) and drives the
per-entity deletion routines (#138, `server/src/policy/purge.ts`): one bounded,
idempotent purge per category that deletes strictly-expired rows in batches
(`PCT_RETENTION_PURGE_BATCH_SIZE`, default `1000`), so a large first run never
holds a long write lock and an interrupted run resumes cleanly. The effective
policy is rebuilt each pass, so a window change applies on the next run without a
restart.

Every run is recorded in a purge-run ledger (`retention_purge_runs`) — what each
category's cutoff was and how many rows it deleted — so purges are observable;
the admin retention page shows the last run. Admins can also trigger a run, or a
side-effect-free **preview** that only counts what *would* be purged, through the
admin API:

- `POST /api/retention/purge` — run the purge now (recorded as a `manual` run).
- `POST /api/retention/purge/preview` — dry run: per-category counts, deletes
  and records nothing.
- `GET /api/retention/purge/runs` — recent runs, newest first (the first is the
  last-run summary).

Only the global default and the purge cadence/batch size live in the
environment — restart to change them; per-category overrides are runtime config
and need no restart.

## Upgrade path

`docker pull` a newer image tag and restart. The server applies any new
migrations in-process on boot (see "First-run setup" step 1) — taking an
automatic pre-migration snapshot first (see "Backup and restore" → "Automatic
pre-migration snapshot"), so a regretted upgrade is recoverable. If a migration
fails, the server exits rather than serving a half-migrated database; restore the
snapshot and start the previous tag. The Ansible venv inside
`/data/ansible/venv` is pinned per image release; upgrades reconcile it
on first start under the new tag.
