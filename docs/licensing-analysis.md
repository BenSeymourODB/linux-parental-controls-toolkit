# Licensing analysis

**Project:** Linux screen-time administration server/client application  
**Purpose of this document:** Identify the license of each proposed component, assess copyleft propagation risk, and evaluate options for commercial distribution of the overall solution.

> **Disclaimer:** This document is an engineering-level analysis of open-source license terms as commonly understood in the industry. It is not legal advice. A qualified attorney should review any distribution strategy before commercial release.

---

## Component license inventory

| Component | License | Copyleft strength | Notes |
|---|---|---|---|
| Timekpr-nExT | **GPL-3.0** | Strong | All source files GPL-3.0 |
| ActivityWatch | **MPL-2.0** | Weak (file-level) | "Incompatible With Secondary Licenses" exhibit present |
| e2guardian | **GPL-2.0** | Strong | Forked from DansGuardian (also GPL-2.0) |
| AdGuard Home | **GPL-3.0** | Strong | GitHub repo: `AdguardTeam/AdGuardHome` |
| Ansible | **GPL-3.0** | Strong | Core engine; playbooks themselves are not derived works if kept separate |
| FreeIPA (server) | **GPL-3.0** (most components); LGPL-3.0 (client libraries `libipa_*`) | Strong / Weak | Python server code GPL-3.0; C client libs LGPL-3.0 |
| LittleBrother | **GPL-3.0** | Strong | Not adopted; listed for completeness |
| FleetDM | **MIT** (core); proprietary (`/ee/` directory) | None | Core is permissive; premium features require commercial license |
| SaltStack | **Apache-2.0** | None | Permissive |
| osquery (used by FleetDM) | **Apache-2.0** | None | Permissive |
| Custom dashboard | **Your choice** | — | Entirely new code; no license constraints from the above apply unless the dashboard links GPL code at the binary level |

---

## Understanding the copyleft landscape

### GPL-3.0 (Timekpr-nExT, AdGuard Home, Ansible, FreeIPA server)

GPL-3.0 is a **strong copyleft** license. The key obligation: if you distribute a work that is a "derivative work" of GPL-3.0 code, the entire combined work must be distributed under GPL-3.0, with source code.

**What counts as a derivative work?** This is the central question for this project. The FSF's guidance and established industry practice both focus on the **process boundary and the intimacy of coupling** between components:

- Code that is **statically or dynamically linked** into the same binary as GPL code is almost universally considered a derivative work.
- Code that **calls a GPL binary as a subprocess** (e.g., invoking `timekpra` via `subprocess.run()`) and communicates only through standard pipes, sockets, or command-line arguments is generally considered **separate** and thus not a derivative work. The FSF's own FAQ acknowledges this distinction.
- Code that **communicates with a GPL service over a network socket or REST API** (e.g., the dashboard calling AdGuard Home's HTTP API) is similarly understood to be separate, since there is no code-level coupling.

The `timekpr-webui` and `timekpr-next-remote` projects both invoke `timekpra` as a subprocess over SSH, and neither treats itself as GPL-3.0 software as a result (timekpr-webui uses MIT). This is consistent with the above analysis.

**For this project:** The custom dashboard never imports, links against, or embeds any GPL-3.0 code. It calls `timekpra` as a subprocess and calls AdGuard Home's REST API over HTTP. It invokes Ansible as a separate process. Under the process-boundary interpretation, the dashboard is not a derivative work of any GPL-3.0 component and is not subject to GPL-3.0 copyleft.

However, if the dashboard were ever refactored to **import Timekpr-nExT Python modules directly** (e.g., to read its data files using its own parsing logic), that would collapse the process boundary and likely create a derivative work.

### GPL-2.0 (e2guardian)

GPL-2.0 applies the same logic as GPL-3.0 regarding process separation. e2guardian runs as a standalone daemon; the dashboard configures it by writing config files and sending a reload signal (or running an Ansible task). This is not a derivative relationship. No GPL-2.0 infection risk exists under this integration model.

One additional nuance: GPL-2.0 and GPL-3.0 are **not mutually compatible** (a combined binary cannot be licensed under both). This is irrelevant here because the dashboard links against neither, but it becomes relevant if someone wants to create a monolithic binary that incorporates both — that combination is not possible under open-source licenses.

### MPL-2.0 (ActivityWatch)

MPL-2.0 is a **weak (file-level) copyleft** license. Its obligations are narrower than GPL: only the specific MPL-licensed *files* that you modify must be redistributed under MPL-2.0. Code in other files that you write — even in the same project — can use any compatible license.

ActivityWatch's LICENSE file includes an "Incompatible With Secondary Licenses" notice, which means you cannot re-license MPL-2.0 ActivityWatch files under GPL. However, this does not affect the dashboard: the dashboard does not incorporate ActivityWatch source files at all. It calls the ActivityWatch REST API. MPL-2.0 imposes no obligations on the dashboard.

### Apache-2.0 (SaltStack, osquery)

Apache-2.0 is **permissive** (no copyleft). It is compatible with GPL-3.0 (but not GPL-2.0) and imposes only attribution and notice requirements. If SaltStack were used instead of Ansible, the dashboard could invoke it as a subprocess or API client with no license obligations beyond including the Apache-2.0 notice in documentation.

### MIT (FleetDM core)

MIT is **fully permissive**. No restrictions on use, modification, or distribution beyond attribution.

---

## GPL "infection" assessment

Under the integration architecture described in the tech stack document, **GPL-3.0 does not propagate ("infect") the custom dashboard**. The reasons:

1. The dashboard does not link against any GPL code.
2. All GPL tools (Timekpr-nExT, AdGuard Home, Ansible, FreeIPA) are invoked as separate processes or called via network APIs.
3. e2guardian (GPL-2.0) is configured by writing files; no code-level coupling exists.
4. ActivityWatch (MPL-2.0) is called via its REST API; no source files are incorporated.

The GPL-licensed components remain GPL-licensed. The custom dashboard code is free to use whatever license the project owner chooses.

**The main architectural risk to watch:** If a future developer adds a Python import of a Timekpr-nExT internal module (e.g., to avoid a subprocess call), that import would likely create a derivative-work relationship and subject the dashboard module containing the import to GPL-3.0. The process boundary must be maintained deliberately.

---

## Licensing options for the overall solution

### Option A: Fully open-source (GPL-3.0 or AGPL-3.0)

Release the custom dashboard under GPL-3.0 or AGPL-3.0.

- **Pros:** Full alignment with the licenses of the major components; no friction with the open-source community; simplest legal posture.
- **Cons:** Requires releasing all dashboard source code to anyone who receives the software. AGPL-3.0 extends this obligation to network users (anyone who uses the dashboard over a browser), making it the stronger open-source choice if the goal is ensuring the code stays open.
- **Monetization options:** Service/support contracts, hosted deployment, configuration consulting. The "open core" model (open dashboard, commercial add-ons in a separate codebase) is viable but requires care to keep the commercial add-ons genuinely decoupled.

### Option B: Open-source dashboard (MIT or Apache-2.0)

Release the custom dashboard under a permissive license.

- **Pros:** Downstream users (including competitors) can incorporate the dashboard into proprietary products without releasing their changes. Maximizes adoption.
- **Cons:** Same — competitors can take the dashboard proprietary. Also, distributing the full *solution* (dashboard + GPL-licensed dependencies bundled together) as a single package would require the bundled GPL components to remain GPL, even if the dashboard itself is MIT. The MIT dashboard license only governs the dashboard source.
- **Monetization options:** Commercial support, hosted SaaS, certified builds. No restriction on charging for the software itself.

### Option C: Proprietary dashboard, GPL dependencies kept separate

The dashboard is closed-source. It is distributed or deployed separately from the GPL-licensed client-side tools, which users install themselves (via PPA, apt, etc.).

- **Pros:** The dashboard code is fully proprietary. This is legally defensible as long as the process-boundary separation is maintained.
- **Cons:** Users must install Timekpr-nExT, ActivityWatch, and e2guardian themselves, or the product must provide installation automation (an Ansible playbook) that does so. The installer/playbook is effectively a distribution of GPL software and must comply with GPL terms (i.e., provide source or point to it — which is trivially satisfied since all of these are publicly available).
- **Monetization options:** Commercial license for the dashboard software. Subscription SaaS. OEM licensing.
- **Key risk:** If the dashboard is ever bundled and shipped as a single downloadable that includes GPL binary artifacts (e.g., a Docker image containing both the dashboard and `timekpra`), the entire image is subject to GPL-3.0 distribution requirements (source must be available). This is manageable (provide a link to upstream source) but must be planned for.

### Option D: Dual licensing

The dashboard is released under both GPL-3.0 (free, open-source) and a commercial license (for users who need proprietary distribution rights).

- **Pros:** Common model for infrastructure tools (MySQL, Qt, MongoDB pre-SSPL). Open-source community edition drives adoption; commercial license provides revenue.
- **Cons:** Requires that the project own all copyrights in the dashboard (or have contributor license agreements), since you cannot dual-license code contributed by others under GPL without their permission.
- **Monetization options:** Commercial license fee, OEM embedding, SaaS.

---

## Summary recommendation

The architecture as designed keeps the custom dashboard **cleanly separated** from all GPL-licensed components via process boundaries and API calls. This means the dashboard's license is entirely the project owner's choice — GPL infection is not a concern under the proposed integration model.

For a personal project that may eventually become commercial, **Option C or D** gives the most flexibility. Option C (proprietary dashboard, dependencies installed separately) is the simplest path to a commercial product. Option D (dual-licensed dashboard) is the most community-friendly path to commercial licensing.

The one firm constraint that applies regardless of chosen license: **any distribution that bundles GPL-licensed binaries** (whether as a Docker image, an installer, or otherwise) must satisfy the GPL's source-availability requirements for those specific components. Since all GPL components in this stack are publicly available upstream, this is satisfied by providing links to their upstream repositories and is not a material burden.

---

## Quick-reference: per-component obligations when distributing

| Component | If you distribute it unchanged | If you modify it and distribute it |
|---|---|---|
| Timekpr-nExT (GPL-3.0) | Must provide or point to source | Must release modified source under GPL-3.0 |
| ActivityWatch (MPL-2.0) | Must include license notice | Must release modified MPL-2.0 *files* under MPL-2.0 |
| e2guardian (GPL-2.0) | Must provide or point to source | Must release modified source under GPL-2.0 |
| AdGuard Home (GPL-3.0) | Must provide or point to source | Must release modified source under GPL-3.0 |
| Ansible (GPL-3.0) | Must provide or point to source | Must release modified source under GPL-3.0 |
| SaltStack (Apache-2.0) | Must include license and notice | May keep changes proprietary; must include notice |
| FleetDM core (MIT) | Must include copyright notice | May keep changes proprietary |
| Custom dashboard (your choice) | Per your chosen license | Per your chosen license |
