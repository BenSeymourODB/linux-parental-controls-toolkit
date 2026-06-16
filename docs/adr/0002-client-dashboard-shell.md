# ADR 0002 — Client "My Time" dashboard: data model and rendering shell

- **Status:** Accepted (2026-06-16)
- **Issue:** [#61](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/61)
- **Phase:** new phase (sequenced after Phase 9); depends on Phase 5
  (usage data), Phase 8b (`pct-client-agent` + cached budget), and Phase 9
  (the `/app` child-status Svelte view it reuses)

## Context

The supervised-user client dashboard ("My Time", proposed in
[#61](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/61)
and mocked up under [`design/client/`](../../design/client/dashboard.html))
is a read-only desktop surface a child can open any time to see how much
time they have left, what they've used, what's coming up, and what rewards
they've earned. It complements the toast/interrupt channel in
[`client-notifications.md`](../client-notifications.md) with a pull channel.

Two questions had to be answered before it can be built:

1. **Where does the data come from** — the authoritative server `/api/*`,
   or the local `pct-client-agent`?
2. **What renders the UI** on the Linux Mint / Cinnamon desktop, given the
   firm constraint that we will **not** build a second UI implementation —
   it must render the *same* SvelteKit (Svelte 5, `adapter-static`) build
   that the Phase 9 `/app` child-status view produces.

### Constraints carried in from elsewhere

- **One UI codebase.** The client dashboard reuses the Phase 9 Svelte
  child-status component; no GTK/native re-implementation.
- **Lean client install.** The agent is shipped as a `.deb` that bundles
  its own Node runtime (`client-notifications.md`); we don't want to add a
  full Chromium per app, nor a *second* managed runtime.
- **License discipline.** Consistent with
  [`licensing-analysis.md`](../licensing-analysis.md): a permissive shell,
  WebKitGTK reached by *dynamic* link (LGPL — fine), no GPL static linkage,
  no proprietary-engine lock-in.
- **Bounded tamper posture** (`CLAUDE.md`, `client-install.md`): the surface
  is read-only and must not become a new attack/escalation surface.
- **Must work during a server/network outage** and update *live* (time
  ticking down) — the server is a control plane, not a data plane
  (`architecture.md` → "Failure modes").

## Decision

### 1. Data model — hybrid, agent-first for the live view

The dashboard reads from **both** sources, by responsibility:

- **Live "time left / today's usage"** comes from the **local agent**,
  which already caches the authoritative budget (policy + active grants,
  pushed by the server) and already polls `aw-server` on `localhost:5600`
  to compute remaining time for the warning cadence. Reusing that means the
  dashboard ticks live and keeps working offline, with no new
  budget-computation logic and no per-user server round-trip.
- **Richer/historical views** (this week, this month, the rewards/grant
  ledger) come from the server **`/api/*`** when it is reachable, and
  degrade gracefully when it is not (today's data still renders from the
  agent).

The agent therefore exposes a **localhost-only, uid-scoped, read-only**
data endpoint. It is bound to loopback, scoped to the requesting Linux UID
(the same per-user isolation model as the `/run/pct/<uid>.sock` channel in
`client-notifications.md`), and serves only the current user's data — a
child can never read another user's budget. All timestamps remain UTC;
the budget window is the user's effective timezone per
[ADR 0001](0001-budget-timezone.md).

### 2. Authentication — from the Linux session, not a PIN

On the client the user is already authenticated as a Linux user. The agent
maps `linux-uid → User` and authorises the local read directly; the Phase 9
PIN is **not** re-prompted on the client. (The PIN remains the auth model
for the `/app` PWA when accessed from a phone.)

### 3. Rendering shell — Tier 0 now, Tauri v2 as the upgrade path

A staged choice, recorded after the survey in
[#61 (research comment)](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/61#issuecomment-4722719125):

- **MVP (Tier 0): the installed browser in app mode.** A `.desktop`
  launcher opens the user's installed browser against the agent's localhost
  URL — Chromium-family `--app=http://127.0.0.1:<port>` yields a chromeless
  window. No new runtime, language, or bundled binary; reuses the Svelte
  build verbatim; license-clean; available as soon as the Phase 9 view
  exists. This validates the whole hybrid model cheaply.
- **Upgrade path: [Tauri v2](https://v2.tauri.app/).** When we want a
  branded, single-instance, tray-integrated app window, adopt Tauri v2: a
  thin Rust frame around the **system WebKitGTK 4.1** already present on the
  targets, MIT/Apache-2.0, whose bundler emits a `.deb` directly. The UI
  stays 100% the one Svelte codebase (Rust is only the frame), so the
  "no second UI implementation" rule holds.
- **Stay-in-Node fallback:** if we prefer the agent process to own the
  window without adding a Rust toolchain,
  [`webview-nodejs`](https://github.com/Winterreisender/webview-nodejs)
  (a NAPI binding to system WebKitGTK) is the option, accepting its
  smaller bus factor and DIY packaging.

## Consequences

- **Agent gains a local read API.** `pct-client-agent` exposes a
  loopback-bound, uid-scoped, read-only HTTP (and/or WS for live updates)
  endpoint serving cached budget + `localhost:5600`-derived usage. This is
  new client surface and must be covered by the bounded-tamper review.
- **Client apt dependency.** The installer pins `libwebkit2gtk-4.1-0`
  (Mint 22 / Ubuntu 24.04 ship 4.1 as primary; Mint 21 / Ubuntu 22.04
  carry it in-repo). Relevant to both Tier 0 (browser already pulls it in)
  and a future Tauri build.
- **CI/toolchain.** Tier 0 adds nothing. Adopting Tauri later introduces
  **Rust** as the first non-Node/non-Python toolchain in the repo and a
  WebKitGTK build dependency in CI — a deliberate, deferred decision, not
  an MVP cost.
- **Offline behaviour is explicit:** today's live data always renders from
  the agent; week/month/rewards render only when the server is reachable
  and otherwise show a clear "available when online" state.
- **No new enforcement and no new license surface** are introduced by the
  dashboard itself; it is viewing-only. All adjustment controls stay on
  `/admin` and `/app`.

## Alternatives not chosen

- **Server-`/api`-only data** was rejected: it would not tick live without
  a browser-facing push/poll mechanism, would not work during an outage,
  and would need per-user server auth on a device where the user is already
  locally authenticated. The agent already computes "time remaining," so
  reusing it is both more robust and less code.
- **A native (GTK) UI** (e.g. a Photino/InfiniFrame .NET shell, or hand-
  written GTK) was rejected: it duplicates the UI → a second implementation
  to keep in sync (violates the core constraint), and .NET would add a
  second managed runtime to the `.deb`.
- **Bundling a full browser engine (Electron / NW.js / QtWebEngine)** was
  rejected: ~100–150 MB and heavy per-window RAM for a read-only widget —
  exactly the "full browser runtime" we set out to avoid.
- **Non-standard engines (Sciter, Ultralight)** were rejected: a partial or
  proprietary HTML/CSS engine would not render our Svelte build faithfully
  (a porting effort) and/or carries license lock-in.
- **Re-prompting the Phase 9 PIN on the client** was rejected as needless
  friction where the OS session already authenticates the user.
