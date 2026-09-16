# How to set up DNS filtering (AdGuard Home)

DNS-level filtering is **optional** and layered on top of the client-side
e2guardian web filter. It is driven entirely by environment variables and
comes in three modes; pick the one that matches your homelab. This guide is
the task-oriented companion to
[`server-deployment.md`](../server-deployment.md) → "AdGuard Home
deployment modes", which explains the design and the license posture.

> DNS filtering has no effect on **whether** a client's traffic is
> filtered by e2guardian — that is the client-side web filter. AdGuard Home
> adds a second, network-level block. If you don't want DNS filtering at
> all, leave it in the default `disabled` mode and skip this guide.

## Decide which mode you want

| You want… | Use mode | Section |
|---|---|---|
| No DNS filtering (default) | `disabled` | [Disabled](#disabled-default) |
| The dashboard to host and run AdGuard Home for you | `managed` | [Managed](#managed) |
| The dashboard to plug into an AdGuard Home you already run | `external` | [External](#external) |

All three set `PCT_ADGUARD_MODE` and restart the container. The dashboard
never links AdGuard Home in-process — it only talks to it over AdGuard's
REST API — so the license posture is identical in every mode.

## Disabled (default)

Nothing to configure. Leave `PCT_ADGUARD_MODE` unset (or set it to
`disabled`). Per-website rules still work through e2guardian on the client;
there is simply no DNS-level layer.

## Managed

The dashboard fetches AdGuard Home on first run, supervises it as a child
process, and owns its config under `/data/adguard/`. Use this on a
greenfield homelab with no existing DNS filter.

1. Add the DNS ports and the mode to your compose service (the managed
   reference file is in
   [`server-deployment.md`](../server-deployment.md) → "TrueNAS SCALE
   deployment" → **B) Managed AdGuard**):

   ```yaml
   ports:
     - "8000:8000"     # dashboard UI
     - "53:53/udp"     # AdGuard DNS
     - "53:53/tcp"     # AdGuard DNS
     - "3000:3000"     # AdGuard's own admin UI (optional)
   environment:
     - PCT_ADGUARD_MODE=managed
   ```

2. (Optional) tune the defaults:

   ```bash
   PCT_ADGUARD_BIND_ADDR=0.0.0.0:53    # what AdGuard's DNS server listens on
   PCT_ADGUARD_ADMIN_PORT=3000         # AdGuard's web/REST UI (bound to localhost)
   PCT_ADGUARD_DATA_DIR=/data/adguard  # binary + seed config + work dir
   PCT_ADGUARD_VERSION=v0.107.65       # optional: pin a release; latest stable if unset
   ```

3. Start (or restart) the container. On first run the dashboard downloads
   the AdGuard Home release, verifies its SHA-256 against the upstream
   `checksums.txt`, writes a minimal seed config, and starts supervising
   it. This happens in the background after the HTTP listener is up, so a
   slow download never blocks dashboard startup.

4. Confirm it came up. The dashboard surfaces managed-AdGuard health at
   `GET /api/system/adguard-managed`; if the fetch failed (e.g. no
   network), managed DNS is left disabled with the reason reported there
   rather than crashing the dashboard.

5. Point your network's DNS at the dashboard host so clients resolve
   through AdGuard Home.

## External

The dashboard makes REST calls against a pre-existing AdGuard Home instance
you already run. No download, no supervision. This is the typical homelab
setup.

1. In **AdGuard Home's own UI**, create a dedicated user account for the
   dashboard (do not reuse your personal admin login). The dashboard
   authenticates as this account and confines itself to a well-defined
   slice of the config — it never touches your global rules, upstream DNS,
   or DHCP settings (see
   [`server-deployment.md`](../server-deployment.md) → "What the dashboard
   expects from an external instance").

2. Provide the connection details as environment variables:

   ```bash
   PCT_ADGUARD_MODE=external
   PCT_ADGUARD_URL=https://adguard.lan
   PCT_ADGUARD_USERNAME=parental-controls
   PCT_ADGUARD_PASSWORD_FILE=/run/secrets/adguard_password
   # or, instead of username/password:
   # PCT_ADGUARD_API_TOKEN_FILE=/run/secrets/adguard_token
   ```

   Keep the credential in a mounted secret file, not inline in the
   environment — the external reference compose file in
   [`server-deployment.md`](../server-deployment.md) → "TrueNAS SCALE
   deployment" → **A) External AdGuard** shows the `secrets:` wiring.

3. Restart the container. On boot the dashboard validates that it can reach
   the configured instance's REST API. A failure is caught and logged (and
   reported by the `GET /api/dns` status endpoint) rather than crashing the
   process — so check the dashboard logs / that endpoint if external DNS
   isn't taking effect. (A dedicated admin-UI surface for DNS status and
   per-client blocklists is still in progress — see #97.)

## Switching modes later

Changing `PCT_ADGUARD_MODE` and restarting is safe:

- **`managed` → `external`** removes the bundled binary from the
  deployment; the dashboard stops supervising its child process and talks
  to your instance instead.
- **`external` → `disabled`** stops all DNS integration; client-side
  e2guardian filtering is unaffected.

The AdGuard Home binary and work dir under `/data/adguard/` are regenerated
on first run in managed mode, so they are **not** part of a backup (see
[How to recover from a backup](recover-from-backup.md)); the managed-mode
`adguard/conf/` config the dashboard owns **is**.
