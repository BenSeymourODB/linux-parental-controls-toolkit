# How to enrol a client

Enrolling turns a fresh Linux Mint / Cinnamon machine into a managed client
the dashboard can push policy to and pull telemetry from. It is a two-part
exchange: you **mint a single-use enrolment token** in the dashboard, then
run the **install one-liner** on the client with that token. This guide is
the task-oriented companion to [`client-install.md`](../client-install.md),
which documents the installer's design in full.

## Before you start

- The dashboard is running and reachable from the client over the network.
- You have created the supervised **policy user(s)** you want to link to
  this machine (see [How to define a policy](define-a-policy.md) →
  "Create the supervised users"). The enrolment token binds each policy
  user to a local Linux login on the client, so the users must exist first.
- The client is Linux Mint 21+ (or another Debian-family distro), and you
  can run commands on it with `sudo`.

## Step 1 — Mint an enrolment token

From the dashboard's admin **Add client** flow (or directly against the
API), mint a token that binds the policy user(s) to the local login
name(s) they use on this machine:

```http
POST /api/clients/enrolment-tokens
Content-Type: application/json

{
  "supervisedUsers": [{ "userId": 1, "osUsername": "alice" }],
  "hostname": "alice-laptop",
  "ttlSeconds": 3600
}
```

- `supervisedUsers` — one entry per supervised account: the policy
  `userId` and the **local Linux login name** (`osUsername`) it maps to on
  this client.
- `hostname` *(optional)* — a friendly reference recorded for the admin.
- `ttlSeconds` *(optional)* — how long the token stays valid.

The response returns the **one-time token** and its expiry:

```json
{ "id": 7, "token": "<one-time-token>", "expiresAt": "2026-08-23T20:00:00.000Z" }
```

The token is single-use and short-lived, and only its SHA-256 hash is
stored server-side — copy it now; it is never shown again.

## Step 2 — Run the installer on the client

On the client, run the install one-liner the dashboard serves, passing the
server URL and the token as arguments (after `-s --`, so they reach the
script and not `bash`):

```bash
curl -fsSL https://<server>/install-client.sh | sudo bash -s -- \
    --server-url https://parentalcontrols.lan \
    --enrolment-token <one-time token from step 1> \
    --supervised-user alice
```

…or download it first and run it locally:

```bash
sudo bash install-client.sh \
    --server-url https://parentalcontrols.lan \
    --enrolment-token <one-time token from step 1> \
    --supervised-user alice
```

The installer does **not** prompt — the server URL, token, and supervised
user come from these flags (or the `PCT_SERVER_URL` /
`PCT_ENROLMENT_TOKEN` / `PCT_SUPERVISED_USERS` environment variables), and a
run without them aborts with a clear "missing …" message.

The installer (an idempotent orchestrator) will:

1. Sanity-check the distro, `sudo`, and reachability of the server.
2. Install the managed tools via `apt` — Timekpr-nExT, ActivityWatch,
   e2guardian, `openssh-server`, and the `pct-client` agent — and apply
   their baseline config.
3. Create the low-privilege `pct-agent` orchestration user with a
   `timekpra`-scoped `sudoers` drop-in, and authorize the dashboard's
   public SSH key (fetched with the enrolment token).
4. **Register with the dashboard** — `POST /api/clients/enrol` (bearer-
   authenticated with the enrolment token) carrying the hostname, the SSH
   user, the supervised-user details, and the tool versions it detected
   (the `pct-client` agent plus `timekpr` / `e2guardian` / `activitywatch`,
   best-effort). On success the token is consumed and the client appears in
   the dashboard's inventory.
5. Run the **self-test** and print a pass/fail checklist.

## Step 3 — Confirm the client is healthy

- The client now appears in the dashboard's **Clients** view, which runs
  server-side health probes over SSH (the same state the on-client
  self-test checks).
- The **self-test** at the end of the install must have passed: it verifies
  the `pct-agent` account and authorized key, the `timekpra`-scoped
  sudoers, the Timekpr-nExT daemon and its client indicator autostart,
  `aw-server` answering on `localhost:5600`, e2guardian active, and the
  `0600` enrolment record at `/etc/pct/pct-client.env`.

Once the client is healthy, define or adjust its policy — see
[How to define a policy](define-a-policy.md).

## Re-running on an already-enrolled client

Enrolment is **not** repeatable (the token is single-use and the hostname
is unique), but the rest of the install is idempotent. To reconcile an
existing client after an installer change, re-run with `--skip-enrol`:

```bash
sudo bash install-client.sh --skip-enrol --supervised-user alice
```

This re-runs provision + baseline + self-test only, contacts no dashboard,
and leaves the existing enrolment, token, and authorized key untouched. See
[`client-install.md`](../client-install.md) → "Upgrading an already-enrolled
client" for the full detail (including the "already enrolled" `409`
tolerance on a plain re-run).
