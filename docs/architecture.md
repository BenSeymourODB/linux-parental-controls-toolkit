# Architecture

This document expands the layered architecture described in
[`proposed-tech-stack.md`](proposed-tech-stack.md) into the concrete component
diagram, data-flow, and policy model the implementation should follow. The
license-boundary rules in [`licensing-analysis.md`](licensing-analysis.md)
constrain how components are allowed to communicate.

## Component diagram

```
┌─────────────────────────── SERVER (Docker container) ────────────────────────────┐
│                                                                                  │
│   ┌────────────────────────────────────────────────┐                             │
│   │ Dashboard (FastAPI + Jinja/HTMX, Python 3.11+) │                             │
│   │                                                │                             │
│   │  Routes  ─►  Policy service  ─►  SQLite        │                             │
│   │                       │                        │                             │
│   │                       ▼                        │                             │
│   │            ┌──────────────────────────┐        │                             │
│   │            │  Transport facade        │        │                             │
│   │            └──────────────────────────┘        │                             │
│   │                  │      │      │      │        │                             │
│   │  ┌───────────────┘      │      │      └────────┴──────────────┐              │
│   │  ▼                      ▼      ▼                              ▼              │
│   │ SSH+timekpra      Ansible runner   AW REST client      AdGuard REST client   │
│   │  (subprocess)      (subprocess)    (HTTP via SSH tunnel)   (HTTP, LAN)       │
│   └────────┬───────────────┬────────────────┬────────────────────┬─────────────┘ │
│            │               │                │                    │               │
│            │               │                │                    ▼               │
│            │               │                │           ┌────────────────────┐   │
│            │               │                │           │ AdGuard Home       │   │
│            │               │                │           │ (sidecar, GPL-3.0, │   │
│            │               │                │           │ fetched on first   │   │
│            │               │                │           │ run, not bundled)  │   │
│            │               │                │           └────────────────────┘   │
└────────────┼───────────────┼────────────────┼───────────────────────────────────┘
             │ SSH key-auth  │ SSH key-auth   │ SSH port-forward to client:5600
             ▼               ▼                ▼
┌─────────────────────────── CLIENT (Linux Mint / Cinnamon) ───────────────────────┐
│                                                                                  │
│   Timekpr-nExT daemon  ◀── timekpra CLI (root, invoked by SSH user via sudoers)  │
│   ActivityWatch:                                                                 │
│       aw-server      (REST :5600, localhost only)                                │
│       aw-watcher-window  (per-user systemd --user unit)                          │
│       aw-watcher-afk     (per-user systemd --user unit)                          │
│       browser extension  (Firefox / Chromium)                                    │
│   e2guardian          (config files in /etc/e2guardian, per-UID filter groups)   │
│   iptables OUTPUT     (per-UID redirect to e2guardian)                           │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Process boundaries (license-critical)

Every line that crosses the dashed boundary between dashboard code and an
external tool is one of:

- **subprocess** — `subprocess.run` / `asyncio.create_subprocess_exec`
  (used for `timekpra`, `ansible-playbook`).
- **local REST** — HTTP client against an API the tool exposes
  (ActivityWatch, AdGuard Home).
- **config file + signal** — writing to a config path and sending the
  daemon a reload (e2guardian; managed via Ansible task).

The dashboard's Python source must not `import` any GPL-licensed package.
This is enforced by convention; CI may add an import-allowlist check.

## Policy model

The policy store is the single source of truth on the server. Sketched
entities (final schema lives in `server/src/dashboard/policy/models.py`
once implementation begins):

```
User          (id, display_name)
Client        (id, hostname, ssh_user, enrolled_at, last_seen)
UserOnClient  (user_id, client_id, linux_username, linux_uid)

Activity      (id, kind=app|app_group|domain|domain_group, matcher)
ActivityGroup (id, name)  --  many-to-many with Activity

Budget        (id, user_id, scope=overall|activity|group,
                target_id?, window=daily|weekly|monthly,
                seconds_allowed)

Schedule      (id, user_id, target_kind, target_id?,
                cron_or_window, action=allow|deny|extend)

Exception     (id, user_id, ...,  expires_at)

UsageSample   (user_id, client_id, activity_id, started_at, ended_at)
              --  populated from ActivityWatch pulls
```

Key derived views the dashboard renders:

- **Per-user budget burndown**: how much of each budget has been consumed
  today / this week / this month.
- **Per-activity timeline**: when each activity was active, sourced from
  `UsageSample`.
- **Pending policy changes**: queued for clients that are currently offline.

## Data flow

### Outbound (server → client) — policy push

1. Admin edits policy in the dashboard.
2. Dashboard writes the change to SQLite and computes the per-client diff.
3. For session-limit-only changes: invoke `timekpra` over SSH for each
   affected client.
4. For file-level changes (e2guardian groups, iptables rules, new
   ActivityWatch deployment): run the appropriate Ansible playbook against
   the client inventory.
5. If a client is offline, the change is queued; an Ansible run is
   scheduled on next reconnect (detected by SSH probe).

### Inbound (client → server) — telemetry pull

1. Periodic job on the server (APScheduler inside the FastAPI app)
   opens an SSH tunnel to each enrolled client, forwarding a local port
   to the client's `aw-server` on `localhost:5600`.
2. Dashboard calls `aw-server`'s REST API to pull events for the polling
   window.
3. Events are normalised into `UsageSample` rows. Raw event blobs are
   discarded; only aggregated samples are kept.
4. The dashboard re-checks budgets; if a per-activity quota is exhausted,
   it triggers the enforcement step (kill the process via Ansible
   ad-hoc command, or adjust Timekpr-nExT PlayTime).

ActivityWatch's REST API is unauthenticated. We never expose it on the
network — all access goes through SSH port forwarding initiated by the
server, which is consistent with the upstream project's guidance.

## Enforcement responsibilities — who does what

| Concern | Enforced by | Configured by |
|---|---|---|
| Total session time | Timekpr-nExT (logind) | `timekpra` over SSH |
| App-group time | Timekpr-nExT PlayTime | `timekpra` over SSH |
| Per-app deny (hard block) | AppArmor | Ansible-deployed profile |
| Per-app time quota (granular) | Dashboard polling + process kill | Ansible ad-hoc / signal |
| Per-website filter | e2guardian | Ansible-deployed config |
| Per-website time-window | e2guardian config swap on schedule | Ansible + systemd timer |
| DNS-level block | AdGuard Home | Dashboard via REST API |

## Failure modes the design must handle

- **Client offline at policy-change time** — queue the change; replay on
  next successful SSH probe.
- **Telemetry gap** — accept it; budgets are conservative (no usage data
  means no consumption credited, not punitive deduction).
- **Clock skew** — clients NTP-sync; budgets compute on the server clock
  but reconcile with `UsageSample` end-times reported by the client.
- **Tamper attempt on client** — periodic Ansible re-application of the
  desired state reverts unauthorised edits. Audit log records each
  reversion.
- **Server outage** — clients keep enforcing their last-known
  Timekpr-nExT / e2guardian / iptables state. The server is a control
  plane, not a data plane.
