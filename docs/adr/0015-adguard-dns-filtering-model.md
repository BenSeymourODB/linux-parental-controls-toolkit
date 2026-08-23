# ADR 0015 — AdGuard DNS filtering is per-device, composed from policy into marked `user_rules`

- **Status:** Accepted (2026-08-23)
- **Issue:** [#97](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/97)
- **Phase:** 7 (DNS filtering, optional). Builds on the mode router
  ([#95](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/95)),
  the REST client ([#94](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/94)),
  and the managed supervisor (ADR 0009 / [#96](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/96)).

## Context

Phase 7 gives the admin DNS-level blocking through AdGuard Home. The policy model
already expresses domain blocking — a `deny` `Schedule` targeting a `domain`-kind
`Activity` (directly or via a group) — and Phase 6's e2guardian path already
enforces exactly that at the web proxy. The open questions #97 must settle before
any rules can be written are:

1. **At what granularity does AdGuard filter?** The policy subject is a supervised
   *user*. But a DNS query carries no Linux UID — the resolver only sees the
   querying device's IP. e2guardian can filter per-UID because it sits in the
   traffic path behind an iptables `--uid-owner` redirect; AdGuard, upstream of
   that, cannot.
2. **How are the dashboard's rules kept separate** from a household's own
   hand-written AdGuard rules, given AdGuard's `set_rules` API replaces the
   **entire** global `user_rules` list (there is no per-rule owner and no
   per-client rule list)?
3. **Which dashboard entity becomes an AdGuard client**, and keyed on what?

## Decision

**1. Filter per dashboard `Client` (device), not per supervised user.** Each
dashboard `Client` that has reported IPs and at least one always-on domain deny
among its users becomes one AdGuard persistent client. The rule set pushed for
that device is the **union** of the always-on `domain` denies of every supervised
user linked to it (own + inherited group denies, via
`policy/group-resolution.ts`). This is the honest granularity for DNS; per-user
web filtering remains e2guardian's job (Phase 6). On the common Alpha-1 case (one
child per device) the two coincide anyway.

**2. Own the dashboard's rules with a sentinel marker block.** Apply is a
read-modify-write over the whole `user_rules` list:

```
! >>> pct-managed: do not edit (managed by the parental-controls dashboard) >>>
||youtube.com^$client='pct:Alice-laptop'
||tiktok.com^$client='pct:Alice-laptop'
! <<< pct-managed <<<
```

We `getUserRules`, drop any existing lines from the previous marker-`begin`
through marker-`end` inclusive (preserving every other line — the household's own
rules), append the freshly-composed block, and `setUserRules`. Re-running against
unchanged policy yields a byte-identical list, so the operation is idempotent.
Rules are `||<domain>^$client='<name>'`, deduplicated and sorted for a stable
diff.

**3. Map `Client` → AdGuard client `pct:<friendlyName ?? hostname>`, keyed on
`reportedIps`.** The `pct:` prefix is the existing managed-namespace guard
(`addClient`/`updateClient`/`deleteClient` refuse anything outside it), so the
dashboard can never mutate a household's own AdGuard clients. `ids` are the
client's self-reported IPs (#355). Reconcile adds/updates/deletes only `pct:`
clients so the AdGuard client set tracks the dashboard client set. The
`friendlyName ?? hostname` label is assumed distinct per client (the friendly
name exists precisely to be an admin-facing distinguishing label, #355); the
reconcile keys by this name.

**4. v1 covers always-on denies only.** AdGuard `user_rules` have no native
time-of-day or calendar grammar, so a scheduled/windowed DNS deny would require a
server-side rule-swap scheduler that re-composes and re-pushes at window
boundaries. That is deferred to a follow-up, exactly as the e2guardian slice
shipped always-on denies (#90) before windows (#216). A `domain_group` (named
bundle) is likewise deferred to #178/#195; matcher-kind translation
(glob/regex/substring) emits `||matcher^` from the matcher string directly, as
e2guardian does today.

## Consequences

- The admin surface (#97) **displays and pushes** what policy already declares;
  domains are authored in the existing Activities/Schedules editors, keeping the
  policy store the single source of truth. There is no second, DNS-only place to
  type domains.
- Rules take effect through the global `user_rules` with a `$client=` scope; the
  managed clients inherit global filtering (no per-client filtering toggle is set),
  so a deployment must have AdGuard filtering enabled globally for DNS denies to
  bite — surfaced through the active-mode health the view already shows.
- A device whose IP changes drifts out of coverage until re-enrolment updates
  `reportedIps` — dynamic-IP reconciliation is #356's concern, called out in the
  view.
- Because `set_rules` is whole-list, a household rule that happens to sit between
  our markers would be dropped; the markers are deliberately verbose to make an
  accidental collision vanishingly unlikely, and foreign rules outside the block
  are always preserved.

## Alternatives considered

- **Per-user DNS filtering** — rejected: DNS cannot see the Linux UID; it would
  be a lie on any multi-user device.
- **Per-client AdGuard rule lists / blocked-services** — AdGuard exposes no
  per-client custom-rule list over REST; `$client=` modifiers on global
  `user_rules` are the documented mechanism.
- **A dashboard-only shadow of the rules** (write-only, never read back) —
  rejected: it would clobber the household's own `user_rules`. The
  read-modify-write with a marker is what makes cohabitation safe.
