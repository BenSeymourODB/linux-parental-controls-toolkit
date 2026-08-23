# Plan — #97: Admin UI for per-client domain blocklists + active-mode surface

Roadmap: `docs/roadmap.md` → Phase 7 (DNS filtering). Issue: #97.
Architecture: `docs/architecture.md` → "Enforcement responsibilities" (per-website
filter → e2guardian; DNS-level → AdGuard Home, REST-only). Decision record:
`docs/adr/0015-adguard-dns-filtering-model.md` (written in this PR).

## What already exists (verified against the tree)

- **Data model + policy** — `domain`-kind `Activity` + `deny` `Schedule` CRUD
  (`ActivitiesView`, `SchedulesView`), effective-schedule resolution incl.
  inherited group denies (`policy/group-resolution.ts` `gatherUserScheduleRules`),
  and the always-on-deny → domain expansion already used by the Phase-6
  e2guardian path (`transport/ansible/e2guardian.ts`).
- **AdGuard REST client** (`transport/adguard/client.ts`) — `listManagedClients`
  / `addClient` / `updateClient` / `deleteClient` (all `pct:`-guarded),
  `getUserRules` / `setUserRules` (whole-list, unconfined — the caller must
  read-modify-write). The client docstrings explicitly name #97 as the consumer.
- **AdGuard service** (`transport/adguard/service.ts`) — `getClient()` returns a
  wired REST client for `external` mode, and for `managed` once the supervised
  instance is running (else `null`); `status` is the mode/health snapshot.
- **Active-mode read contract** — `GET /api/dns` (`api/dns`) returns the
  `DnsStatus` (mode, configured, health, baseUrl, checkedAt, detail).
- **Dashboard `Client`** carries `reportedIps` (JSON string array, #355),
  `friendlyName`, and `hostname`.

## What is missing (this issue)

1. No `/admin` DNS view (none of the 18 existing views is DNS/blocklist).
2. No write path composing per-client domain denies into AdGuard rules — the
   `getUserRules`→compose→`setUserRules` read-modify-write, the rule-ownership
   marker, and the reconcile of `pct:` clients from dashboard clients.

## Design (grounded in ADR 0015)

- **Granularity = per dashboard `Client` (device).** DNS queries carry no Linux
  UID, so AdGuard filters per device/IP, not per supervised user (that is
  e2guardian's job, Phase 6). Each dashboard `Client` with reported IPs maps to
  one AdGuard persistent client named `pct:<friendlyName ?? hostname>`, whose
  `ids` are the client's `reportedIps`. The denies pushed for that AdGuard client
  are the **union** of the always-on `domain` denies of every supervised user on
  the device (own + inherited group denies).
- **Rule ownership via a marker block.** Dashboard-owned rules live between two
  sentinel comment lines in AdGuard's global `user_rules`. On every apply we
  strip the previous marked block (preserving all foreign, hand-written rules),
  then append a freshly-composed block — an idempotent read-modify-write over the
  whole `user_rules` list (the only shape AdGuard's `set_rules` offers).
- **Rule form.** `||<domain>^$client='<clientName>'`, one per (domain, client),
  deduplicated and sorted for a deterministic, diff-stable block.
- **v1 scope = always-on denies only.** AdGuard `user_rules` have no native
  time-of-day/date scheduling, so scheduled/windowed DNS denies would need a
  swap scheduler — deferred to a follow-up (see below). This mirrors how the
  Phase-6 e2guardian slice (#90) shipped always-on denies first and added
  windows later (#216).

## Phases

1. **Backend — composition + apply (test-first).**
   - `policy/domain-denies.ts` — extract the always-on `domain`-deny resolver
     (`resolveAlwaysOnDomainDenies`, `isAlwaysOnRule`, `domainsForDenyRule`) as a
     policy-layer concern shared by both enforcement mechanisms; refactor
     `transport/ansible/e2guardian.ts` to consume it (behaviour identical — its
     tests guard the refactor).
   - `transport/adguard/blocklist.ts` — `buildDnsBlocklistPlan(db, { clientPrefix })`,
     `composeUserRules(existing, plan)` (marker RMW, pure), `formatBlockRule`,
     `reconcileManagedClients(client, plan)`, `applyDnsBlocklist(service, db)`
     (orchestrator; typed error when no client is wired), and the pure
     `previewDnsBlocklist(db, { clientPrefix })`.
2. **API.**
   - `GET /api/dns/blocklist` — preview: the per-client plan (name, ids, domains),
     plus `skipped` clients (denies but no reported IPs) and an `applyable` flag
     derived from the DNS status.
   - `POST /api/dns/blocklist/apply` — reconcile + push; returns a summary.
     `409` when DNS is `disabled`, unconfigured, or has no wired client.
   - Both admin-only, registered on the existing `/api` scope (reads `scope.db`
     + `scope.adguard`).
3. **Frontend.**
   - `$lib/api/dns.ts` wrappers + contract re-exports.
   - `DnsFilteringView.svelte` + a "DNS filtering" nav item: prominent active-mode
     banner (incl. the `external`-mode "writes confined to `pct:` clients"
     warning), a `disabled`-mode explanatory empty state (not a broken editor),
     the per-client blocklist preview, and an Apply button. Authoring the domains
     themselves stays in the existing Activities/Schedules editors (policy is the
     source of truth); this view surfaces and pushes what policy already declares.
   - Component test + `npm run build`.
4. **Docs + gate + PR.** `docs/server-deployment.md` DNS section; full server +
   frontend gate; draft PR; deferred-work follow-ups filed and linked.

## Deferred (linked follow-ups)

- **Scheduled / time-windowed / date-scoped DNS denies** — needs a rule-swap
  scheduler (AdGuard has no declarative time grammar). New follow-up issue.
- **`domain_group` expansion** (named bundles → concrete domains) — owned by
  #178/#195.
- **Matcher-kind-aware translation** (glob/regex/substring → AdGuard rule syntax)
  — v1 emits `||matcher^` from the matcher string directly, as e2guardian does.
- **Dynamic-IP reconciliation** (a device whose IP changes) — #356's territory;
  v1 keys on the last-reported IPs.
- **Auditing DNS pushes** — `audit_log` is transport-command-shaped (client
  target + argv); a REST rule push has neither. Left out of v1 (the same reason
  the retention purge used a dedicated ledger).

## License boundary

AdGuard Home is driven over its REST API only (`CLAUDE.md` → "License
boundaries" rule 4). No AdGuard code is linked/imported/vendored; no GPL binary
is added to the image. Pure TypeScript + zod + Svelte.

## Quality gate

`npm run format && npm run lint:fix && npm run typecheck && npm test` from
`server/` (coverage ≥ 80%); `svelte-check` + `npm run build` +
component tests from `server/frontend/`.
