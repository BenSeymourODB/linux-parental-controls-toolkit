# Windows client support (forward-looking design)

> **Status:** Exploratory. This is a *planning* document for a body of work
> that lands **after every phase in [`roadmap.md`](roadmap.md)** (i.e. after
> Phase 14). Nothing here is committed; it exists so the phases we build
> *before* it don't accidentally bake in Linux-only assumptions that are
> expensive to unwind once a Windows enforcement client exists. Where a
> decision is cheap now and expensive later, it is called out under
> [Modularity tweaks to make cheaply now](#modularity-tweaks-to-make-cheaply-now).

The roadmap currently lists non-Linux **enforcement** clients as out of scope
"for now" (`roadmap.md` → "Out of scope"). This document is the "later": it
scopes what a Windows enforcement client would take, what supporting software
we'd choose, and which seams to keep clean in the meantime. It deliberately
**disregards commercialisation** — the motivating users self-host.

## Why this, and the constraints that shape it

The demand is concrete: parents who want the same **time-budget / schedule**
controls this toolkit offers, but who cannot move their household to Linux
because their children play games protected by **Easy Anti-Cheat (EAC)** and
**BattlEye** (Fortnite, etc.) that either block or degrade under Proton/Wine.
They also reject Microsoft's Family Safety because it is **cloud-bound** and a
privacy concern, and they are willing to **self-host** the dashboard.

Three constraints fall out of this and drive every choice below:

1. **Anti-cheat compatibility is a hard requirement, not a nice-to-have.**
   Kernel-mode anti-cheat (EAC, BattlEye) treats kernel drivers, code
   injection, API hooking, and memory tampering as cheating signals. Any
   enforcement mechanism we ship on Windows **must use only documented,
   non-invasive OS APIs**. We may *terminate* a game process; we must never
   *inject into, hook, or instrument* one. See
   [Anti-cheat compatibility](#anti-cheat-compatibility) — this turns out to
   align exactly with the project's existing tamper-resistance ceiling
   (`docs/client-install.md`, `CLAUDE.md`).
2. **Privacy / self-host.** No cloud dependency, no Microsoft account, no
   telemetry leaving the household LAN. The existing architecture already
   satisfies this (the dashboard is the only control plane and runs on the
   admin's own box); Windows support must not introduce a cloud hook.
3. **Same control plane.** Parents with mixed households (a Linux Mint desktop
   *and* a Windows gaming PC) should manage both from one dashboard with one
   policy model. We are adding an *enforcement target*, not a second product.

## What already ports for free

The dashboard is OS-agnostic by construction and most of it does **not**
change. Re-reading [`architecture.md`](architecture.md) through a
"which layer knows about the OS?" lens:

| Layer | OS-aware today? | Windows impact |
|---|---|---|
| Policy store (`User`, `Budget`, `Schedule`, `Exception`, `Grant`, …) | No — budgets are seconds, schedules are weekday+window, grants are seconds | **None.** A "daily budget of 7200s, no Discord 16:00–18:00 on weekdays, +30 min chore grant" is platform-neutral. |
| `/api/*` JSON contract, zod DTOs | No | **None.** The same contract serves a Windows client. |
| Grant ledger + idempotency + external integrators (calendar) | No | **None.** Chore rewards work identically. |
| Effective-policy resolver (#143), recurrence/date-scoping (ADR 0005) | No | **None.** "What applies for user U on day D" is computed server-side in seconds/weekdays. |
| Event stream `/api/events/stream` (WebSocket, JSON frames) | No — JSON event types | **Mostly none.** Frame *types* (`grant.applied`, `enforce.force_close`, …) are reusable; the *agent that consumes them* is OS-specific. |
| Burndown / admin UI / PWA | No | **None** beyond surfacing a per-client OS badge. |

What is OS-aware, and therefore the entire surface of this work:

- **The transport runners** (`server/src/transport/*`): `timekpr` over SSH,
  Ansible playbooks, ActivityWatch pull, e2guardian config push. These encode
  *how a Linux client enforces*.
- **The client-side components**: Timekpr-nExT, e2guardian, iptables,
  ActivityWatch, and our `pct-client` agent (`docs/client-install.md`,
  `docs/client-notifications.md`).

So the real statement of work is: **add a second enforcement backend and a
second client agent behind the existing transport facade and event stream,
without the policy model or API noticing.**

## The architectural inversion: the agent becomes the enforcer

This is the single most important design consequence and it deserves to be
stated plainly, because it bends one of the project's founding principles.

On Linux, the dashboard's job is **orchestration, not enforcement** — we
configure Timekpr-nExT (session budgets), e2guardian (web filtering), and
ActivityWatch (telemetry), all mature upstream tools, and our agent only adds
notifications and a graceful per-app force-close around them
(`CLAUDE.md` → "Prefer using an existing upstream tool"; `client-notifications.md`).

**On Windows there is no Timekpr-nExT to orchestrate.** There is no mature,
FOSS, privacy-respecting, locally-enforcing screen-time daemon for Windows that
we can drive the way we drive Timekpr over SSH (Microsoft Family Safety is the
incumbent and is exactly what these users are fleeing). Therefore, on Windows,
**our own `pct-client` agent must carry the session-budget and schedule
enforcement itself** — it stops being a thin notification layer and becomes the
enforcement engine.

This is a conscious, documented exception to "orchestrate, don't reimplement",
forced by the platform, and it is bounded:

- We reimplement only **session budget + allowed-hours + per-app time**
  enforcement, because no upstream equivalent exists. We do **not** invent new
  *policy concepts* — the agent enforces the same `Budget`/`Schedule`/`Grant`
  model the server already owns.
- Everything that *does* have a cross-platform upstream tool still uses it:
  **ActivityWatch** (telemetry) ships Windows builds; **AdGuard Home** (DNS
  filtering) is server-side already and OS-neutral. We do not rebuild those.
- The enforcement we add uses only documented OS APIs (see anti-cheat section),
  which keeps the new code small and keeps us off the kernel.

> License note: because this new enforcement code is **our own** (no GPL
> Timekpr involved), it carries no new copyleft exposure — it sits under the
> dashboard/agent's proprietary-source-available license like the rest of
> `pct-client`. If anything the Windows path has a *smaller* GPL surface than
> Linux (no Timekpr, and — see below — likely no e2guardian). See
> [License-boundary implications](#license-boundary-implications).

## Enforcement primitive mapping — Linux → Windows

| Concern | Linux (today) | Windows mechanism | Notes |
|---|---|---|---|
| **Total session time budget** | Timekpr-nExT (logind), `timekpra` over SSH | **`pct-client` agent (Windows service)** tracks active session seconds against the server-pushed budget; locks/logs off at zero | No upstream tool; agent enforces. Lock via `LockWorkStation`, end session via `WTSLogoffSession` / `shutdown /l`. |
| **Allowed hours / schedule windows** | `timekpra --setallowedhours` | Built-in **logon hours** (`net user <u> /time:` → `NetUserSetInfo`) for the *coarse* gate, agent for *mid-session* enforcement | `net user` logon hours block *new* logons on whole-hour boundaries only; the agent handles "you're already logged in and the window just closed" and sub-hour windows. |
| **Per-app / app-group time quota** | Timekpr PlayTime (process-name mask) + dashboard polling + agent kill (Phase 8) | **Agent**: match processes by name/path, enforce quota from AW usage, graceful close then terminate | This is *already* the Phase 8 model (dashboard decides, agent kills). Ports almost unchanged; the matcher is a Windows process image name instead of a Linux comm. |
| **Per-app hard deny (block launch)** | AppArmor profile (Ansible) | **Software Restriction Policies / AppLocker** (Pro/Enterprise) *or* agent-side terminate-on-launch (Home) | AppLocker is the clean, OS-native deny; not on Windows Home. Agent fallback = watch + terminate, which is anti-cheat-safe (terminate, not block-by-injection). |
| **Per-website filter (per-user)** | e2guardian + iptables OUTPUT redirect | **Deprioritised** on Windows; see below | Transparent proxy + TLS intercept on Windows needs a local CA install (privacy-hostile, brittle, and risks tripping app pinning). Prefer DNS. |
| **Per-website / domain block** | e2guardian, optionally AdGuard Home (Phase 7) | **AdGuard Home DNS** (already server-side, Phase 7) — point the Windows client's DNS at it | OS-neutral, no client software, no CA. Granularity is per-device (per-IP AdGuard client), not per-Linux-UID — documented limitation. |
| **Session lock / logoff at budget zero** | Timekpr session-kill; bridge `timekpra --kill-session` | Agent service: `LockWorkStation`, then `WTSLogoffSession`; deny re-logon via logon-hours + agent | Same UX (grace countdown → lock) the notifications doc already specifies. |
| **Telemetry (what was used, when)** | ActivityWatch (`aw-watcher-window`, `aw-watcher-afk`) | **ActivityWatch Windows build** (same watchers exist) | Cross-platform. Pull model unchanged (REST over an SSH tunnel). |
| **Notifications / sound / countdown** | `notify-send`/`gdbus`, `canberra-gtk-play` | Windows toast (WinRT `ToastNotification`) + `System.Media` sounds | Same per-user agent role as `client-notifications.md`; different rendering subprocess/binding. |

The shape of the table is the point: **two rows fundamentally change**
(session budget moves into our agent; web filtering shifts from local proxy to
server-side DNS), **most rows are a re-binding of the same idea**, and the
**policy model behind every row is unchanged**.

## Supporting software choices

For each OS-specific concern, the options considered and a recommendation.

### Remote transport: OpenSSH for Windows (+ Ansible)

The transport facade is SSH-centric (`ssh2` exec + port-forward,
`server/src/transport/ssh/`). **Windows ships OpenSSH Server** as an optional
feature, so the same facade reaches a Windows client: exec for agent control
commands, port-forward for the ActivityWatch pull. Recommendation: **keep SSH
as the universal transport**; it avoids a second remoting stack in the
dashboard.

Ansible can manage Windows hosts via **WinRM/PSRP** or, increasingly, **over
SSH with PowerShell**. Windows playbooks use `win_*` modules and are a separate
playbook set from the Linux ones. Because we are *not* installing GPL tooling on
Windows (no Timekpr/e2guardian), the Windows playbook's job shrinks to:
install/upgrade the agent MSI, lay down config, register the service, set logon
hours, point DNS at AdGuard. Recommendation: **Ansible over SSH** (one
transport), `win_*` modules, a `client/ansible/windows/` playbook tree parallel
to the Linux one.

### Session / budget / per-app enforcement: our agent, documented APIs only

No third-party dependency. The Windows agent is a **Windows Service**
(LocalSystem or a dedicated low-privilege service account for the privileged
parts) plus a **per-user component** launched at logon (Scheduled Task with
"At log on" trigger, or a per-user service). It uses:

- **Win32 / WTS APIs** for session state, lock, and logoff
  (`WTSQuerySessionInformation`, `WTSLogoffSession`, `LockWorkStation`).
- **Process enumeration + `TerminateProcess`** (after a graceful
  `WM_CLOSE`/`CloseMainWindow` request and a grace countdown) for per-app
  force-close — the exact Phase 8 / Phase 8b flow, re-bound.
- **`NetUserSetInfo`** (logon hours) for the coarse allowed-hours gate.

Node binding choice: prefer **`child_process` to small bundled helper
executables / PowerShell** for these calls (consistent with the project's
"desktop integration via subprocess, not native bindings" rule in
`client-notifications.md`), falling back to a vetted FFI (`koffi`/`ffi-napi`)
only where a subprocess is impractical. Decide in an ADR during the epic.

### Web filtering: DNS-first via AdGuard Home, proxy deferred

Recommendation: on Windows, **do not port e2guardian + transparent-proxy +
iptables**. A transparent intercepting proxy on Windows requires Windows
Filtering Platform redirection *and* a locally-trusted root CA to read HTTPS —
which is privacy-hostile (the toolkit's whole pitch is privacy), brittle across
browsers/apps with cert pinning, and a maintenance sink. Instead:

- Lean on **AdGuard Home (Phase 7)**, which is already server-side and
  OS-neutral, for domain-level blocking. Set the Windows client's DNS to the
  AdGuard instance (via the Windows playbook).
- Accept that DNS filtering is **per-device, not per-user** (AdGuard clients
  are per-IP/identifier). Document this as a known Windows limitation; for the
  motivating use case (gaming PCs, often single-child) it is acceptable.
- Leave a per-user HTTPS-filtering proxy as an explicit **non-goal for the
  first epic**, revisitable later if demand is real.

### Telemetry: ActivityWatch Windows build (unchanged model)

ActivityWatch publishes Windows builds of `aw-server` and the window/afk
watchers. The pull model (`server/src/transport/activitywatch/`) is unchanged —
SSH port-forward to `localhost:5600`, REST pull, normalise to `UsageSample`.
The only Windows-specific work is the install/launch path (per-user autostart)
and confirming the watcher's window-title bucketing maps to our activity
matchers. **No code-level change to the AW client.**

### Packaging & service model: MSI bundling Node

Mirror the Linux `.deb`-that-bundles-Node approach (`client-notifications.md`):
ship a **signed MSI** (e.g. WiX) that bundles its own Node runtime under
`C:\Program Files\pct-client\`, registers the system service (via a service
wrapper — `WinSW`/`NSSM`, or `node-windows`), and installs the per-user logon
task. Distribution rides the same Phase 14 channel decision (#167/#168) — our
agent is ours to host; nothing GPL is in the installer.

### User / privilege model

| Linux | Windows equivalent |
|---|---|
| Supervised user = non-sudo account | Supervised user = **Standard** (non-admin) account |
| Admin (parent) = sudo | Admin (parent) = local **Administrator** |
| `pct-agent` service user + scoped sudoers | System service as **LocalSystem** (or dedicated svc account) — a Standard user cannot stop/modify it; this is the tamper boundary |
| `UserOnClient.linux_uid` | Windows **SID** (and account name) |

A Standard user being unable to stop a LocalSystem service is the natural
analogue of "no sudo for the supervised user" — same posture, native mechanism.

## Anti-cheat compatibility

This is the requirement that makes the whole effort viable, so it gets its own
section. EAC and BattlEye run kernel-mode components and flag, as cheating:
kernel drivers from unknown vendors, **code/DLL injection** into protected
processes, **API/function hooking**, **memory reads/writes** of the game, and
debugger attachment. They generally **do not** care about an external,
higher-privileged process terminating the game via a documented API — being
killed is not tampering.

Our design stays on the safe side by construction:

- **Never inject, hook, or read game memory.** All enforcement is external:
  enumerate processes, request graceful close (`WM_CLOSE`), then
  `TerminateProcess`. This is indistinguishable from the user closing the game
  or the OS shutting down.
- **No kernel driver, no filter driver, no minifilter.** The agent is pure
  user-mode service + APIs.
- **Graceful-first.** The Phase 8b grace countdown (15s default, configurable)
  applies: warn → countdown → request close → terminate. A clean exit is also
  the *best* anti-cheat outcome (the game logs out normally).
- **Prefer terminate over block-by-interference.** Where we deny an app launch
  without AppLocker, we let it start and then terminate it, rather than
  attempting to prevent process creation by hooking `CreateProcess` (which is
  exactly the kind of interference anti-cheat punishes).

The happy accident here is that **this is the same philosophy the project
already committed to** for Linux: the tamper-resistance ceiling in
`docs/client-install.md` and `CLAUDE.md` explicitly forbids kernel modules,
eBPF, hooks, and obfuscation. The constraint that keeps us anti-cheat-safe on
Windows is a constraint we already chose. Worth stating in the epic as a
first-class invariant: *"the Windows agent uses only documented user-mode APIs;
any proposal involving a driver, injection, or hooking is rejected on both
tamper-posture and anti-cheat grounds."*

> One residual risk to validate empirically during the epic: a few anti-cheat
> titles dislike *any* unsigned background process touching the session. Ship
> the agent **code-signed**, and test against Fortnite (EAC) and a BattlEye
> title early. This is a verification task, not a design unknown.

## License-boundary implications

The GPL boundary rules (`docs/licensing-analysis.md`, `CLAUDE.md`) are about
not linking GPL code in-process. On Windows:

- **Smaller GPL surface, not larger.** We drop Timekpr-nExT (GPL-3.0) entirely
  and almost certainly e2guardian (GPL-2.0). The remaining third-party tools
  are **ActivityWatch (MPL-2.0, REST only)** and **AdGuard Home (GPL-3.0, REST
  only, server-side)** — both already at arm's length via REST.
- **Our new enforcement code is ours.** Reimplementing session-budget
  enforcement in the agent introduces no copyleft because we are not deriving
  from any GPL tool — we are not porting Timekpr's code, we are calling Win32.
  (Porting Timekpr logic would be both pointless and a boundary violation;
  don't.)
- **Ansible (GPL-3.0) stays a subprocess.** Same as today.
- **Installer.** The Windows MSI bundles only our agent + Node + (cross-platform
  MPL) AdGuard is *not* in it. No GPL binaries shipped, so the
  "don't bundle GPL in our artifact" rule (#5 in `CLAUDE.md`) is satisfied more
  easily than on Linux.

Net: Windows support **relaxes** the license tension rather than adding to it.

## Tamper posture (unchanged ceiling)

The household-context tamper ceiling (`docs/client-install.md` → "Tamper
resistance posture") applies verbatim. On Windows: supervised user is Standard,
the enforcing service runs as LocalSystem so the user can't stop it, periodic
Ansible re-apply reverts unauthorised config edits, and **we do not** add
anti-tamper hooks, drivers, obfuscation, or boot-media lockdown. A user with
local Administrator (or physical access) can defeat it; the product does not
claim otherwise. "My advanced teenager got around it" remains a parent-child
conversation, not a software arms race — and on Windows it doubly so, because
the alternative (kernel-level lockdown) is precisely what would break
anti-cheat.

## Modularity tweaks to make cheaply now

These are the inexpensive seams to keep clean in the phases we build *before*
this epic, so Windows support is an addition rather than a refactor. None of
them require building anything Windows-specific now.

1. **Reserve a `platform` column on `Client`.** `linux` today, `windows`
   later. Cheap as a reserved, defaulted column (cf. how #146 reserved
   recurrence columns); expensive as a backfill once a fleet exists. Lets the
   transport facade and the admin UI branch per client without schema churn.
2. **Generalise the user-mapping field names.** `UserOnClient.linux_username`
   / `linux_uid` are Linux-specific (`architecture.md`). When this table is
   implemented (Phase 2), consider neutral names — `os_username` +
   `os_user_ref` (a uid on Linux, a SID on Windows) — or at least *don't* lean
   on "linux"/"uid" semantics in `/api/*` DTOs that external integrators and
   the PWA consume. Renaming an internal column is cheap; renaming a published
   API field after the calendar integrator depends on it is not.
3. **Keep event-stream frame names OS-neutral.** They already are
   (`enforce.force_close`, `enforce.session_lock`, `lockout.cleared`). When
   adding event types, avoid Linux-only nouns. A Windows agent should consume
   the same frames.
4. **Fold a capability advertisement into the version handshake (#165).**
   Phase 8b already bakes a version handshake + N-1 window into the bridge ↔
   `/api/events/stream` connection. Extend it (cheaply, while it's being
   designed) so a client advertises *which enforcement primitives it supports*
   (e.g. `session_budget`, `per_app_close`, `applocker_deny`, `dns_filter`).
   Then the server can withhold `enforce.*` frames a client can't honour and
   the admin UI can grey out unsupported controls per client — the mechanism a
   mixed Linux/Windows fleet needs, designed once. **This is now decided** in
   [`adr/0007-event-stream-version-compatibility.md`](adr/0007-event-stream-version-compatibility.md):
   capabilities are an additive flag set in the handshake, a Linux and a Windows
   client speak the same `eventProtocol` and differ only in advertised
   capabilities, and the server withholds `enforce.*` frames a client can't
   honour.
5. **Don't hardcode "distro" as the only client-shape axis.** The
   `client/distros/<id>.sh` adapter pattern (`client-install.md` → "Other
   distributions") is a Debian/Fedora/Arch split. A Windows client is not a
   "distro"; the install entry point should branch on **OS family first**, then
   distro within Linux. Keep that in mind when the distro-adapter dispatch is
   built, rather than wedging Windows under a `distros/` tree later.
6. **Keep the transport facade's per-client dispatch keyed on capability, not
   `if (linux)`.** The facade (`server/src/transport/`) already separates
   runners; when Phase 4/6 wire real dispatch, route on the client's declared
   platform/capabilities so a `WindowsAgentRunner` can be added beside
   `SSHTr`/`AnsTr` without touching call sites.

Items 1–4 are the highest-leverage and the cheapest; they are reservations and
naming choices, not features.

## Proposed epic breakdown (sequenced after Phase 14)

A set of epics, each roughly a milestone, mirroring how the Linux client was
built up (install → transport → telemetry → enforcement → notifications).

- **W0 — ADR: Windows enforcement model & anti-cheat invariant.** Pin the
  "agent-as-enforcer, documented user-mode APIs only, no driver/injection/hook"
  decision; record the AppLocker-vs-agent-terminate split and the
  DNS-first/web-proxy-deferred decision. Capability-handshake schema finalised.
- **W1 — Windows agent skeleton + service model.** MSI (WiX) bundling Node;
  LocalSystem service + per-user logon component; enrolment against the existing
  `/api/clients/enrol`; reports `platform=windows` and capabilities. Reuses the
  bridge ↔ event-stream protocol from Phase 8b.
- **W2 — Session-budget + allowed-hours enforcement.** Agent enforces overall
  daily/weekly/monthly budget and schedule windows from server-pushed effective
  policy; lock → grace → logoff; logon-hours coarse gate via `NetUserSetInfo`.
  Consumes `policy.changed` / `grant.applied`; honours `lockout.cleared`.
- **W3 — ActivityWatch on Windows + telemetry parity.** Install/launch AW
  watchers; confirm pull + normalisation; per-app usage feeds the same
  `UsageSample` rollups.
- **W4 — Per-app enforcement (Phase 8 parity).** Process matching, graceful
  close + terminate, AppLocker deny where available with agent-terminate
  fallback; anti-cheat verification against an EAC and a BattlEye title.
- **W5 — Notifications & end-of-budget UX (Phase 8b parity).** Windows toasts +
  sounds + countdown; same cadence/grace/`NotificationPolicy` knobs.
- **W6 — DNS filtering integration.** Point Windows client DNS at AdGuard Home;
  surface the per-device granularity caveat in the admin UI.
- **W7 — Windows Ansible playbooks + fleet update (Phase 14 parity).** `win_*`
  playbooks for install/upgrade/config-reapply; agent MSI distribution channel;
  fold Windows clients into the fleet-version dashboard.
- **W8 — Admin UX for mixed fleets.** Per-client OS badge, capability-aware
  control greying, docs.

Sequencing rationale matches the Linux build-up: you cannot enforce before the
agent exists (W1), cannot do per-app before telemetry (W3 → W4), and
notifications wrap enforcement (W5), exactly as Phases 3 → 5 → 8 → 8b did.

## Risks and open questions

- **No upstream session-enforcer means we own that code forever.** The biggest
  ongoing cost. Bounded by keeping it to documented APIs and the existing policy
  model, but it is genuinely new surface area Linux didn't have.
- **Anti-cheat empirical risk.** Low by design (we only terminate), but must be
  *verified* with code-signed builds against real EAC/BattlEye titles in W1/W4,
  not assumed.
- **Per-user web filtering gap.** DNS-first is per-device. If a Windows box has
  multiple supervised users needing different web policy, the first epic does
  not serve that. Acceptable for the motivating use case; document loudly.
- **Windows Home vs Pro.** AppLocker/SRP are Pro+. The agent-terminate fallback
  covers Home but is coarser. Decide minimum supported edition in W0.
- **Logon-hours coarseness.** `net user` logon hours are whole-hour and only
  block *new* logons; mid-session and sub-hour enforcement is all on the agent.
  No surprise, just more agent responsibility.
- **OpenSSH-on-Windows posture.** Running sshd on a household gaming PC is a
  small attack surface; confine to LAN, key-only, and consider whether the
  agent's outbound event-stream connection can carry enough that sshd is only
  needed for the AW pull (or whether we tunnel AW over the agent connection and
  drop sshd entirely — an option worth weighing in W0).

## See also

- [`roadmap.md`](roadmap.md) → "Out of scope" (this document is the "later").
- [`architecture.md`](architecture.md) — the layers and transport facade this
  work extends.
- [`client-notifications.md`](client-notifications.md) — the agent role and
  event channel the Windows agent reuses.
- [`client-install.md`](client-install.md) — tamper posture (unchanged) and the
  distro-adapter pattern (which Windows sits *beside*, not inside).
- [`licensing-analysis.md`](licensing-analysis.md) — the GPL boundary, which
  Windows relaxes rather than tightens.
</content>
</invoke>
