# Client notifications and end-of-budget enforcement

This document specifies the client-side experience around budget
consumption: how the supervised user finds out about screen-time
events, when they're warned that time is running out, and what
happens when a budget actually reaches zero.

This adds a new client-side component (the **`pct-client` agent**)
and a new server-to-client event channel on top of the architecture
described in [`architecture.md`](architecture.md). Timekpr-nExT
continues to do the actual session-kill enforcement; the agent
layers notifications, per-app force-close, and a user-friendly grace
period on top.

Both agent components are TypeScript (the same language as the
dashboard), shipped as a `.deb` that bundles its own Node runtime
under `/usr/lib/pct-client/` — the distro's Node packages are too old
on the target platforms, so we don't depend on them. All desktop
integration (notifications, sound) goes through the desktop's own
command-line tools as subprocesses, not native bindings.

## Goals

For each supervised user on each managed client:

- **Toast notifications** for server-pushed events (e.g. "Mum just
  granted you +30 minutes", "Your YouTube limit was changed to 1h").
  Notifications are rendered through the desktop's native
  notification stack (libnotify / `notify-send` on Cinnamon) and may
  optionally play a sound.
- **Time-remaining warnings** at an escalating cadence as the active
  budget runs down:
  - **every 15 minutes** while more than 15 minutes remain;
  - **every 5 minutes** once 15 minutes or fewer remain;
  - **every minute** once 5 minutes or fewer remain;
  - **a final "time's up — save and quit!" notification** at 0:00.
- **Grace period** after the budget hits zero (default 15 seconds,
  configurable per policy). During the grace period the notification
  shows a visible countdown.
- **End-of-budget enforcement** after the grace period:
  - if the exhausted budget was **per-application** (or per-process
    group): force-close that application;
  - if the exhausted budget was the **overall device screen-time**:
    the OS lock screen is displayed and login is disabled for that
    user until more time is granted.

The user's existing screen state (open apps, unsaved work) is
explicitly considered: the cadence and the grace period exist so
nothing is killed without warning.

## Components

### 1. `pct-client-bridge` — system-level event bridge

- Runs as a system `systemd` unit on each enrolled client, under the
  low-privilege `pct-agent` user (the same one that holds the SSH
  key for the server, see [`client-install.md`](client-install.md)).
- Maintains a single persistent **outbound** connection to the
  dashboard's `/api/events/stream` endpoint, authenticated with the
  client's enrolment token. Outbound-only because the client is
  typically behind NAT and the server may not be able to initiate.
- Reconnects with exponential backoff on disconnect. The dashboard
  considers a client "live" when the bridge connection is open and
  "offline" otherwise.
- Receives JSON event frames addressed to specific supervised users
  on this device, and forwards each one to the per-user agent over a
  small Unix socket at `/run/pct/<linux-uid>.sock`.
- For privileged enforcement actions (force-close another user's
  process, lock the system, persist a lockout flag for PAM) the
  bridge holds a narrow `sudoers` rule and acts on instructions from
  the dashboard. It never trusts instructions from the local user.

### 2. `pct-client-agent` — per-user notification daemon

- Runs as `systemd --user` for each supervised user, started by the
  install script's user-unit drop-in.
- Subscribes to its own socket from the bridge (`/run/pct/<uid>.sock`)
  for server-pushed events.
- Polls `aw-server` on `localhost:5600` for current usage so it can
  render warnings locally without round-tripping the server. The
  authoritative budget value (policy + active grants) is pushed
  down by the server on policy/grant changes and cached locally.
- Renders notifications via the desktop notification stack: `gdbus
  call` against `org.freedesktop.Notifications` (needed for updating
  the countdown toast in place), falling back to `notify-send` if
  that fails. Both are subprocess invocations — no native D-Bus
  bindings.
- Plays sounds via `libcanberra`'s `canberra-gtk-play` (subprocess),
  respecting the user's desktop sound theme and a per-policy
  "muted" flag.
- Force-closes the user's own processes when instructed
  (`SIGTERM` → wait 5s → `SIGKILL`), which does not require
  privilege escalation since they are the user's own processes.

### 3. Timekpr-nExT (unchanged)

Continues to enforce overall session limits at the logind level,
including the actual session kill / screen lock when the daily budget
expires. The agent's role around overall-screen-time enforcement is
to *announce* what Timekpr is about to do (the cadence) and to make
the experience graceful (countdown, grace period, configurable
delay). Timekpr is still the component that actually pulls the
trigger.

## Event channel

```
Dashboard (Fastify)
   │
   │  WebSocket /api/events/stream
   │  Bearer <client_token>
   │
   ▼
pct-client-bridge  (system, one per client)
   │
   │  AF_UNIX  /run/pct/<linux-uid>.sock
   │
   ▼
pct-client-agent   (per supervised user)
   │
   ├──▶ libnotify   (toast)
   ├──▶ libcanberra (sound)
   └──▶ kill(pid, ...) for per-app enforcement
```

WebSocket is chosen over SSE because the channel must also carry
client→server liveness pings and acknowledgements. The framing is
JSON, one event per frame.

### Event types pushed by the server

| Event | Trigger | Agent action |
|---|---|---|
| `grant.applied` | A `Grant` row was added (admin UI or external integrator) | Toast: "+N min granted · reason" + optional sound |
| `policy.changed` | A budget, schedule, or activity rule changed | Toast: "Your X limit is now Y" |
| `enforce.force_close` | Server has determined a per-app/group budget is exhausted *and* the grace period has elapsed | Send `SIGTERM` to the matching processes, then `SIGKILL` after 5 s |
| `enforce.session_lock` | Overall-screen-time budget exhausted and grace elapsed | Hand off to Timekpr-nExT's session-kill (the bridge invokes `timekpra --kill-session` if Timekpr hasn't already done it) |
| `lockout.cleared` | A grant has restored time after a lock | Bridge tells Timekpr to allow login again; user agent toasts "More time! You can log back in." |

Events the agent generates **locally** (no server round-trip needed):

| Event | When | UI |
|---|---|---|
| Time-remaining warning | Per the cadence rules below | Toast (and sound, configurable per warning level) |
| "Time's up — save and quit!" | At 0:00 of any active budget | Persistent toast with a visible grace-period countdown |
| Force-close countdown | During the grace period | Same toast, updating each second |

The agent uses the locally cached budget total (last pushed by the
server) plus the local usage stream from `aw-server` to compute
"time remaining" without needing the server to be reachable.

## Notification cadence — exact rules

For every active budget the supervised user has (overall + each
per-activity / per-group budget), the agent independently tracks
remaining time and fires warnings.

| Remaining time | Warning interval | Cumulative count of warnings before zero |
|---|---|---|
| > 15 min | 15 min | one at each :00, :15, :30, :45 boundary of remaining time |
| 6–15 min | 5 min | one each at 15, 10 min (so 2 in this range) |
| 1–5 min | 1 min | one each at 5, 4, 3, 2, 1 min (so 5 in this range) |
| 0:00 | — | "Time's up — save and quit!" |

The "boundary of remaining time" framing means the warnings line up
with round numbers (15, 10, 5, 4, 3, 2, 1) regardless of when in
real time the budget started.

If multiple budgets cross a boundary inside the same 5-second
window, the agent **coalesces** them into one toast ("YouTube and
Discord both have 5 minutes left") to avoid notification spam.

## Sound design

Sounds are optional and configurable per policy at three levels:

- **`off`** — no sounds at all.
- **`subtle`** (default) — a soft `message-new-instant` for routine
  warnings; a slightly more prominent `complete` for grant arrivals;
  `dialog-warning` for the 1-min-and-under range; `bell` for "time's
  up".
- **`prominent`** — the same set but routed through a higher-volume
  channel and with louder sound files packaged under
  `/usr/share/pct-client/sounds/`.

The chosen sound theme is read from policy at policy-push time, so
admins can pick "off" for a user who finds notifications anxiety-
inducing, or "prominent" for a user who routinely misses subtle
ones.

## Grace period and force-close

When a budget reaches 0:00 the agent shows the "time's up" toast
**immediately**, with a visible countdown of the grace period
(default 15 seconds, configurable via `policy.grace_seconds`,
range 0–60).

During the grace period:

- The user can save and close their work.
- The agent updates the toast each second showing how much time is
  left in the grace period.
- If a `grant.applied` event arrives that adds time to the exhausted
  budget, the agent dismisses the countdown and notifies "+N min
  granted — keep going" (this is the chore-completion happy path
  from the calendar integrator).

After the grace period:

- **Per-app budget exhausted** → agent receives `enforce.force_close`
  from the server (or, if the server is unreachable, falls back to
  the local decision since the local timer has reached zero). It
  matches the running processes for the activity (by the same
  matcher used to compute usage), `SIGTERM`s them, waits 5 s, then
  `SIGKILL`s anything still alive.
- **Overall screen-time exhausted** → the bridge invokes
  `timekpra --kill-session` if Timekpr hasn't already taken action.
  This triggers logind's session-end behaviour: the user is logged
  out and returned to the greeter. Re-login is blocked by Timekpr's
  own budget (the user is out of time until the daily reset or until
  a grant arrives).

## Lockout and grant-unlock

For overall-screen-time exhaustion, the user is locked out:

- Timekpr-nExT enforces "no remaining budget = no login" at the PAM
  layer; the lock persists until either:
  - the daily/weekly/monthly budget refreshes (whatever the policy
    window is), or
  - a `Grant` is recorded against the user's overall budget — the
    server pushes the new effective budget down to the client over
    the existing SSH+`timekpra` transport, Timekpr updates its state,
    and login is allowed again.
- The bridge listens for `lockout.cleared` events from the server.
  When one arrives it forwards a per-user toast to the agent if the
  user happens to already be logged in (e.g. on another device).
- For multi-device users, a grant against the overall budget
  obviously clears the lockout on every device that holds the same
  budget.

For per-app enforcement, no global lockout is needed — only that
specific process is killed; the user can keep using the rest of
their session.

## Configuration knobs

All of these live on the policy and are pushed to the client as part
of normal policy distribution:

| Knob | Default | Notes |
|---|---|---|
| `notifications.enabled` | `true` | Master switch per user. |
| `notifications.sound_profile` | `subtle` | One of `off` / `subtle` / `prominent`. |
| `notifications.cadence_overrides` | none | Optional per-budget cadence override (e.g. "no sub-5-minute warnings for the homework activity"). |
| `policy.grace_seconds` | `15` | 0 disables the grace period; max 60. |
| `policy.force_close.signal` | `SIGTERM`, then `SIGKILL` after 5 s | Could be tuned per app if an app needs longer to save. |

## Failure modes

- **Server unreachable**: bridge keeps trying to reconnect; agent
  keeps using the last cached budget and continues to warn / enforce
  on the local clock. Grants the server tries to push while the
  bridge is offline are replayed on reconnect. This means a
  household network outage cannot grant a child more time but also
  cannot wrongly cut them off — they get exactly what the last-known
  policy said they should have.
- **Bridge crashed / killed**: `systemd` restarts it. The
  per-user agent surfaces a small persistent "offline" indicator
  in the notification stack so the admin can spot it.
- **User dismisses the "time's up" toast**: the toast re-appears
  each second of the grace-period countdown specifically so it
  cannot be ignored to death. After the grace period the enforcement
  action runs regardless of whether the toast is visible.
- **Notification stack unavailable** (e.g. headless session): agent
  logs the events and the enforcement still happens. This is
  acceptable for a degraded mode.

## Out of scope here

- The web/mobile UI for the admin and parent to *configure* these
  notifications. Lives in the `/admin` and `/app` frontends.
- The exact wire format of the WebSocket frames — fix it during
  implementation, document it in a separate API reference once it
  stabilises.
- Push notifications to the *parent*'s phone when a child's budget
  is running low. That's a feature of the `/app` PWA, covered in
  [`roadmap.md`](roadmap.md) Phase 9, not of this client-side agent.
