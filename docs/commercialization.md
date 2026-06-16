# Commercialization notes

**Status:** Forward-looking. Nothing here is committed scope. This document
captures the thinking that *would* apply if the project is ever taken from a
personal/homelab tool to a commercial product, so that today's design decisions
don't quietly foreclose it. The shipping roadmap is still
[`docs/roadmap.md`](roadmap.md); the firm out-of-scope list there
(non-Linux enforcement, native mobile apps, multi-tenant SaaS) stands until a
deliberate decision to pursue commercialization is taken.

The licensing groundwork for this already exists: the dashboard is
**proprietary source-available** with commercial use gated behind a separate
written agreement, and the owner retains full re-licensing rights (Option C in
[`docs/licensing-analysis.md`](licensing-analysis.md)). So the *legal* path to a
commercial offering is open. This document is about the *product and ethical*
path.

---

## 1. A commercial product needs a much broader client install base

The current enforcement target is a single platform: **Linux Mint with
Cinnamon** (Debian-family). That is the right scope for a personal tool and a
deliberately narrow one. A product someone pays for has to meet families on the
devices they actually own — which in practice means some combination of other
Linux distros, **Windows, ChromeOS, macOS, Android, and iOS**.

**ActivityWatch sets the telemetry benchmark.** ActivityWatch already runs as a
free, standalone tool across Windows, macOS, Linux, and Android, with browser
extensions for per-site data. Because we consume it only over its REST API (no
source-level coupling — see [`docs/licensing-analysis.md`](licensing-analysis.md)),
the *activity-tracking* layer is the most portable part of the whole stack: in
principle the dashboard can pull telemetry from an ActivityWatch instance on any
platform AW supports, with no per-OS work on our side beyond enrollment and the
SSH/transport plumbing. ActivityWatch's platform/feature matrix is a fair
ceiling for what "supported platform" should mean on the telemetry side.

**But telemetry is the easy half — enforcement is the hard half, and it does
not port.** Almost every other component in the stack is Linux-specific:

- **Timekpr-nExT** (session time limits) — Linux/systemd-logind only.
- **e2guardian + iptables OUTPUT-chain redirect** (per-UID web filtering) —
  Linux only; the per-Linux-UID model has no direct analogue elsewhere.
- The **pct-client agent** assumes a Linux desktop session, `notify-send`,
  systemd-user units, etc.

So "support Windows" does not mean "recompile." Each non-Linux platform needs a
**platform-native enforcement backend**, and on the consumer OSs the vendor
already owns that surface:

| Platform | Likely enforcement surface | Notes / friction |
|---|---|---|
| Other Debian/Ubuntu Linux | Same stack as Mint | Lowest-effort expansion; mostly packaging/testing. |
| Other Linux (Fedora/Arch/etc.) | Same tools, different packaging | Timekpr-nExT/e2guardian availability varies by distro. |
| Windows | Microsoft Family Safety APIs / Group Policy / a custom service | No drop-in equivalent to Timekpr; significant native work. |
| macOS | Screen Time / `FamilyControls` + `DeviceActivity` frameworks | Requires a special Apple entitlement and likely MDM enrollment. |
| ChromeOS | Family Link / Google Admin console | Largely a managed-policy integration, not local enforcement. |
| Android | Family Link / Digital Wellbeing / a Device Policy Controller | Background-process and accessibility-API restrictions are tightening. |
| iOS | `FamilyControls` / `ManagedSettings` / `DeviceActivity` | Strict entitlements; App Store review; no arbitrary process control. |

**Honest pushback worth recording now:** on Windows, macOS, ChromeOS, Android,
and iOS the platform vendor already ships *free* first-party parental controls
(Microsoft Family Safety, Apple Screen Time, Google Family Link). A commercial
product cannot win those platforms by re-implementing what the OS gives away. If
there is a defensible product here it is **unified cross-platform management** —
one dashboard, one policy model, one rewards/grant ledger, one parent view
across a mixed-device household — wrapping each platform's native enforcement
rather than competing with it. That reframes most non-Linux work as
*integration with vendor parental-control APIs*, not *building enforcement*, and
it preserves the architecture's existing instinct: orchestrate, don't
reimplement.

This also interacts with the deliberately **bounded tamper-resistance posture**
([`docs/client-install.md`](client-install.md), and the README). The
"if they can defeat it, they've outgrown the product" stance is a sound
*household* default and should not be quietly abandoned for revenue. A paid,
mainstream-parent product may face different expectations, but ratcheting up
client-side hardening is explicitly off the table in this repo; if
commercialization seems to demand it, that is a decision to make in the open
(and to re-examine the product's whole philosophy), not a default to drift into.

## 2. Commercialization should give back to the upstream projects

This product is, by design, mostly **existing open-source tools strung together
in a license-compliant way**. The dashboard is the only fully custom component;
Timekpr-nExT, ActivityWatch, e2guardian, AdGuard Home, and Ansible do the actual
work. If we ever earn money on top of that, a meaningful share of the value was
created by those maintainers. Giving back is both the right thing and good
risk management — our product is only as healthy as the upstreams it depends on.

A commercialization effort should commit to contributing back in three forms:

- **Money.** Recurring sponsorship of the projects we depend on (GitHub
  Sponsors / Open Collective / direct, whichever each project uses). The natural
  beneficiaries are exactly the components in
  [`docs/licensing-analysis.md`](licensing-analysis.md): Timekpr-nExT,
  ActivityWatch, e2guardian, AdGuard Home, and Ansible.
- **Human developer time.** Upstream the fixes and features we'd otherwise keep
  local — bug reports with reproductions, patches, packaging help for distros we
  add, and documentation. Contributing to the GPL/MPL upstreams carries no
  license complication for *us*: those contributions are made under the
  project's own license and never touch the dashboard's process boundary.
- **Agent assignment, where the project allows it.** Where a project welcomes
  it, dedicate coding-agent capacity to working its issue tracker. This is
  explicitly **gated on each project's contribution policy** — some maintainers
  disallow or restrict AI-generated PRs, and that decision is theirs to make.
  Respect `CONTRIBUTING.md` and any AI-contribution policy; never dump unsolicited
  agent-generated PRs on a project that hasn't asked for them.

**One ethical flag that belongs in any commercialization decision:**
ActivityWatch is intentionally a **self-monitoring** tool, and its maintainers
**actively discourage supervised/remote monitoring** — a constraint this repo
already acknowledges ([`docs/proposed-tech-stack.md`](proposed-tech-stack.md),
Layer 3b). Building a *personal* household tool on top of it is one thing;
*selling* a supervised-monitoring product built on it is a stronger claim on
their work and runs against their stated intent. Before commercializing on
ActivityWatch we should (a) re-read its license and stated position, (b) talk to
the maintainers rather than around them, and (c) be willing to fund or build a
purpose-fit telemetry agent if supervised monitoring at commercial scale is not
something the AW project wants to be the foundation for. Generosity upstream
does not buy the right to ignore a maintainer's "please don't use it this way."

## 3. Focus expansion on platforms whose users will actually pay

Two things have to be true at once for commercialization to make sense: a
**broader install base** (point 1) *and* an install base whose users are
**willing to pay** for parental controls as a service.

Here is the uncomfortable part, stated plainly so we plan around it rather than
discover it later: **the current target user is close to the worst-case paying
customer.** A parent running a homelab and supervising children on self-hosted
Linux Mint desktops is technical, cost-sensitive, and self-hosts *specifically
to avoid* recurring SaaS fees and handing family data to a third party. That
user is the right *first* user — they can stand the product up, give sharp
feedback, and tolerate rough edges — but they are not a SaaS revenue base.

The paying market is mainstream, non-technical parents on the platforms their
kids actually use — predominantly **Windows, ChromeOS, iOS, and Android** — who
are already used to paying for parental-controls subscriptions (Qustodio, Bark,
Aura, Norton Family, etc. occupy exactly this space). So commercialization
should prioritize platform expansion by *willingness-to-pay*, not by
*engineering convenience*:

- **Lowest engineering cost** is more Debian-family Linux, then other Linux —
  but that is also the **lowest commercial return**, because it deepens our hold
  on the segment least likely to subscribe.
- **Highest commercial return** is the consumer OSs (iOS/Android/ChromeOS/
  Windows) — which is also the **highest engineering and platform-policy cost**
  (entitlements, app review, MDM, vendor API limits, per-OS enforcement).

There is no free lunch here, and the doc should not pretend otherwise: the
cheapest expansion and the most lucrative expansion point in opposite
directions. A credible commercialization plan picks **one** consumer platform to
do *well* (most likely ChromeOS or Android, where Google's managed-policy APIs
give the most leverage for the least native enforcement work, and where
school-issued Chromebooks make screen-time a felt problem), proves families will
pay for **unified cross-household management** that the free first-party tools
don't offer, and only then widens.

**The engineering shape of that pivot is already scoped in the issue tracker.**
Epic [#24](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/24)
("commercial multi-tenant SaaS edition") and its children decompose the hosted
track and should be read alongside this section — they are the concrete "if we
decide to do it" plan that point 3's framing argues *for* doing consciously:

- [#25](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/25)
  — multi-tenant data model & family-group isolation (the `Family` boundary).
- [#26](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/26)
  — centralised identity, accounts & per-family roles (replaces single-admin auth).
- [#27](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/27)
  — cloud hosting & the control-plane↔home **connectivity inversion** (a cloud
  server can't SSH into a desktop behind home NAT). Flagged there as the
  highest-risk, make-or-break item — spike before committing to the rest.
- [#28](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/28)
  — tenant lifecycle, billing & subscriptions.
- [#29](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/29)
  — children's-data privacy & compliance (COPPA/GDPR-K), flagged as a likely
  *gating legal requirement*, not a nice-to-have.

That epic is the SaaS/tenancy half of commercialization. Note that **points 1
and 2 above (platform breadth and giving back to upstream) are not yet tracked
by any issue** — if commercialization is pursued, they likely warrant their own
issues (or children of #24), since a hosted product for mainstream parents
implies the consumer-platform enforcement work in point 1, and monetizing the
FOSS stack implies the upstream-contribution commitments in point 2.

**This pivot should be made consciously**, because two load-bearing assumptions
in the current design would change (both also called out across #24–#29):

- The roadmap currently lists **cloud-hosted multi-tenant SaaS** as explicitly
  out of scope, and the whole product assumes a **single-admin, self-hosted
  household** deployment ([`docs/roadmap.md`](roadmap.md), "Out of scope").
  A paying mainstream market almost certainly wants a hosted service, which means
  multi-tenancy, per-tenant data isolation, hosted auth, and a very different
  operational and privacy/regulatory posture (children's data — COPPA/GDPR-K and
  similar). None of that is a small addition.
- The bounded tamper-resistance philosophy (point 1) was written for the
  household context. It does not automatically transfer to a paid product and
  should be revisited deliberately if we go there — not eroded by default.

The cleanest reading: keep building the self-hosted Linux tool for the homelab
user (who is the right design partner and validates the policy/grant model), and
treat consumer-platform + hosted-SaaS as a **separate, later, deliberately
scoped product bet** rather than incremental scope creep on this repo.

---

## Summary

| Theme | Position |
|---|---|
| Platform breadth | Telemetry (ActivityWatch) ports cheaply over REST; enforcement does not and must be built per-OS, mostly by integrating vendor parental-control APIs rather than reimplementing them. |
| Giving back | If we monetize FOSS we depend on, commit to money + developer time + (where the project allows) agent capacity, upstream to the components in the licensing analysis, and respect ActivityWatch's anti-supervised-monitoring stance. |
| Willingness to pay | Our ideal *design* user (self-hosting homelab parent) is a poor *paying* user; the paying market is mainstream parents on consumer OSs and implies a conscious pivot to hosted, multi-tenant, consumer-platform product — out of scope today, and not to be drifted into. |

The SaaS/tenancy half of this already lives in the issue tracker as the
stretch-goal epic
[#24](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/24)
(children
[#25](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/25)–[#29](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/29)).
The platform-breadth and give-back-to-upstream themes (points 1–2) are not yet
tracked. If any of this moves from "notes" to "plan," update
[`docs/roadmap.md`](roadmap.md) and
[`docs/licensing-analysis.md`](licensing-analysis.md) first, file the new themes
against the [roadmap project](https://github.com/users/BenSeymourODB/projects/2),
and record the go/shelve decision in an ADR as #24's acceptance criteria already
require.
</content>
</invoke>
