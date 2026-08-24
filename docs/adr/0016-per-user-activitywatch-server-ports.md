# ADR 0016 — Per-supervised-user `aw-server` port convention

- **Status:** Proposed (2026-08-24)
- **Issue:** [#369](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/369)
  (the per-(client, user) ActivityWatch health axis this unblocks). Related:
  [#103](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/103)
  (per-user `pct-client-agent` probe — shares the per-user dimensionality),
  [#88](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/88)
  (telemetry normalisation), and the SSH port-forward infra
  [#86](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/86).
- **Phase:** 5 (ActivityWatch telemetry pull). This is the foundational
  convention Phase-5 multi-user telemetry and the #369 health axis both need;
  it does not, by itself, ship a user-facing feature.

## Context

`aw-server` is a **per-supervised-user** process (Phase 5 design, #86): each
supervised Linux account runs its own `systemd --user` `aw-server`, keyed to
that account's activity. The dashboard reaches it only over an SSH
loopback port-forward and its REST API (`CLAUDE.md` → license-boundary rule 4).

Today every layer assumes a single, conventional loopback bind of
`127.0.0.1:5600`:

- **Client install** — `client/install-baseline-tools.sh`
  (`pct_baseline_configure_activitywatch`) writes each supervised user's
  `aw-server-rust/config.toml` and `systemd --user` unit with the **same**
  `--host ${AW_HOST} --port ${AW_PORT}` (`127.0.0.1:5600`) for every user.
- **Telemetry pull** — `server/src/transport/activitywatch/telemetry.ts` has a
  single `awPort` (default `5600`).
- **Health probe** — `server/src/transport/health/components.ts` defines one
  `activitywatch-rest` probe at `AW_SERVER_PORT = 5600`; the enforcement
  telemetry consumer notes the same limitation ("the loopback tunnel can't
  disambiguate several" users).

On a genuinely multi-user client this is broken, not merely incomplete: only
**one** user's `aw-server` can bind `5600`; the others fail to bind. The
health probe (#323) reports whichever user owns the `5600` bind and is blind to
the rest, and the telemetry pull can only ever pull that one user's data. There
is **no distinct, discoverable port to probe or pull per user.**

The Alpha-1 assumption is one Linux account per child (#185), so the common
early case has a single supervised user per client and the `:5600` convention is
correct for it. But the model is explicitly many `UserOnClient` rows per
`Client` (shared family desktops), and #369 / #103 both need a per-user health
axis. Standing up any of the three per-user consumers (health, telemetry, the
Phase-8b agent probe) requires first settling **one** convention for how each
user's `aw-server` gets a distinct, server-discoverable port, applied
consistently across install, telemetry, and health. #369 was retracted from an
earlier implementation run for exactly this reason: the decision has to be made
before the health axis can be built without inventing a one-off.

This ADR settles that convention. It does not itself change any of the three
consumers — it is the decision the follow-on implementation issues build on.

## Decision

**The server is the authority for each user's `aw-server` port, and records it
explicitly on the `UserOnClient` link.**

1. Add a non-null `aw_server_port` column to `usersOnClients` (Drizzle
   migration generated with `npm run db:generate`, per #133's timestamp-prefix
   rule — never hand-numbered).
2. When a `UserOnClient` link is created (enrolment #77 / admin link), the
   server **allocates** the lowest free port in a bounded per-client window
   starting at `5600` (`AW_SERVER_PORT_BASE`), i.e. the first/only supervised
   user on a client gets `5600`, the next `5601`, and so on. The allocation is
   **persisted**, so it is stable even if the client's supervised-user set later
   changes (a removed user's port is not reused implicitly; a new user takes the
   next free slot). A small bound (e.g. 32 ports, `5600–5631`) is ample for a
   household desktop and keeps the window well clear of other services.
3. The enrol response (#77 / #205 already hand the client its config) carries
   each supervised user's allocated port, and `install-baseline-tools.sh` binds
   that user's `aw-server` config + unit to it instead of the fixed `AW_PORT`.
4. The telemetry pull and the health prober read the persisted
   `aw_server_port` per `UserOnClient` and forward to / probe **that** port over
   the existing SSH loopback tunnel — one authoritative value, read the same way
   everywhere.

`5600` remains the default for the single-user case, so **existing single-user
clients are unaffected**: their one link is allocated `5600` and every layer
behaves exactly as today until a second supervised user is added.

### Considered alternatives

**A. Deterministic offset from an ordinal, no persistence** — port =
`5600 + index`, where `index` is the user's position among the client's
supervised users in an agreed order (e.g. sorted by `linux_uid`). Both client
install and server recompute it identically, so no schema change is needed. This
is elegant and migration-free, but **fragile under membership change**: adding or
removing a supervised user shifts every higher user's ordinal, silently
reassigning ports and requiring a coordinated re-provision of the client units;
any drift between the client's and the server's view of the set (or its
ordering) points telemetry/health at the wrong user's data. For a convention
that three independent consumers must agree on, a persisted authoritative value
is safer than a recomputed one.

**B. Deterministic from `linux_uid`** — port = `BASE + (uid − UID_MIN)` or a
hash of the uid into a bounded window. Stable per user (a uid does not move),
and needs no new column if `linux_uid` is available everywhere. But typical uids
(1000+) do not map into a tidy port window without a modulo, and a modulo
reintroduces **collision** risk between two users on the same client, which then
needs resolution logic anyway — at which point persisting the resolved port (C)
is simpler and removes the guesswork.

**C is preferred** because the server already owns the `client ↔ user` mapping
and already delivers per-client configuration at enrol; making the port one more
explicitly-allocated, persisted, discoverable field fits that pattern, removes
all recomputation and drift, survives membership changes, and is trivially
backward-compatible (single user ⇒ `5600`).

## Consequences

- A new `usersOnClients.aw_server_port` column + migration; enrol/link
  allocation logic; the enrol-response DTO gains the per-user port; the client
  install consumes it; telemetry and health read it. These land as the
  follow-on issues tracked from #369's implementation plan
  (`docs/plans/369-per-user-activitywatch-health-axis.md`), sequenced so the
  client-install/enrol change settles before the health axis builds on it.
- **License boundary unchanged.** This is purely a port-allocation convention:
  `aw-server` is still reached only over its documented REST API through the
  loopback SSH tunnel, and no GPL code is linked in-process or added to the
  image (`CLAUDE.md` → rules 4–5; `docs/licensing-analysis.md`). `license-guard`
  is unaffected.
- **Tamper-resistance ceiling unchanged.** Binding each user's loopback
  `aw-server` to a distinct port is ordinary multi-user service configuration,
  not a hardening measure (`CLAUDE.md` → "Tamper resistance is deliberately
  bounded").
- Phase 6 Ansible (#91) owns `aw-server` unit upgrades "beyond this baseline";
  the per-user port becomes part of that managed baseline and must be carried
  through when #91's playbook takes over from the install script.
- The per-user axis defined here is deliberately generic (keyed by the per-user
  components), so the Phase-8b `pct-client-agent` probe (#103) reuses it rather
  than inventing a second one — honouring #369's "design the per-user health
  axis once" guidance.

## Status note

Filed as **Proposed** by a scheduled implementation run to unblock the
lowest-phase eligible issue (#369), whose prior run deliberately left this
decision to be made explicitly. It records a recommended option with the
alternatives considered; the maintainer's acceptance (or a steer to option A/B)
on the PR is what moves it to **Accepted** and releases the follow-on
implementation.
