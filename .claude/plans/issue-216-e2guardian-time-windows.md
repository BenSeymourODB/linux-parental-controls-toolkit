# Plan — #216 e2guardian per-website time-window denies (recurring)

Phase 6. Extends #90's always-on e2guardian filter so **recurring** (weekday /
time-of-day) domain denies actually filter during their window, not just
always-on ones.

## Mechanism decision (the issue's "pick one and document it")

Three candidates were named in the issue: (1) a client systemd timer swapping
list variants, (2) a dashboard croner re-push at each window boundary, or (3)
**e2guardian's native time-based list support**.

**Chosen: (3).** e2guardian evaluates a `#time:` tag on a list entry / `.Include`
directive itself, at request time. Rendering the window into the config means:

- **Stays purely config-file + reload** — no new client-side scheduler to install
  or maintain, no widening of the license boundary (`CLAUDE.md` rule 6) or the
  tamper surface (`docs/client-install.md` ceiling).
- **No clock-drift / re-push race** — nothing has to fire at 16:00 to swap a file;
  the constraint is declarative and lives in the pushed config.
- **One transport model** — same `pushE2guardianFiltering` Ansible run as #90.

Rejected (1) as tamper-surface + maintenance for no gain; (2) as fragile
(boundary races, transport load, server-clock coupling).

e2guardian `#time:` body grammar: `<start_hour> <start_min> <end_hour> <end_min>
<days>`, days a concatenation of cron digits **0=Sunday .. 6=Saturday**
(`0 0 24 0` = all day; `24` is the idiomatic end-of-day hour). Applied as a
trailing tag on the `.Include<...>` line so the whole included domain list is
active only in-window.

## Scope

- **In:** recurring denies — `recurrence_days` and/or `recurrence_start/end_minute`
  set, **both** `effective_from`/`effective_to` null.
- **Out (deferred, tracked):** date-scoped denies (`effective_*` set). e2guardian's
  `#time:` expresses weekday/time-of-day but **not calendar date ranges**; this
  rides with the date-scoped resolver work (#142). A follow-up issue is filed and
  linked from the PR.
- **Out (existing deferral):** live Molecule proof that the windowed `.Include`
  filters end-to-end against a real e2guardian daemon -> folds into #215, exactly
  as #90's filtergroup/port binding did (no live daemon in the CI sandbox).

## Weekday-mask mapping

`recurrence_days` is a 7-bit **ISO** mask (bit0=Mon ... bit6=Sun; ADR 0005).
e2guardian wants cron digits (Sun=0 ... Sat=6). Map bit `i` -> ISO `i+1` -> digit
`(i+1) % 7`, sorted ascending. Mon-Fri (`0b0011111`) -> `12345`; Sat+Sun -> `06`.

## Design

### Server — server/src/transport/ansible/e2guardian.ts

- New pure exported `e2guardianTimeTag(days, startMinute, endMinute)` -> the
  `#time:` body string. `null` minutes => `0 0 24 0`; `null` days => `0123456`.
  End-of-day sentinel `1440` => hour `24`. Fully unit-tested (grammar detail lives
  in tested TS, template stays dumb — the repo's "hermetic plan derivation" idiom).
- Extract `domainsForRule(db, rule)` shared by the always-on and windowed
  collectors (DRY; today it is inlined in `resolveBannedSites`).
- New `resolveWindowedDenies(db, userId)`: collect non-always-on, non-date-scoped
  `deny` schedules; expand to domains; **group by identical `timeTag`** so one
  window list serves all its domains; sites deduped+sorted, windows sorted by tag.
- `e2guardianWindowSchema = { timeTag: string, sites: string[] (>=1) }`; add
  required `windows: E2guardianWindow[]` to `e2guardianUserFilterSchema`.
- `buildE2guardianPlan`: keep a user if `bannedSites` **or** `windows` non-empty
  (a windowed-only user still gets a filter group + port + redirect; outside the
  window nothing is banned, which is correct).
- `planToExtraVars`: map `windows` through to the playbook.

### Client — client/ansible/playbooks/

- New `templates/pct-windowed-bannedsites.j2`: a plain domain list for one window
  (`item.1.sites`), header noting the window + #216.
- `pct-filtergroup.conf.j2`: after the always-on `.Include`, loop `item.windows`
  emitting a time-tagged `.Include<...>#time: <tag>` line per window.
- `e2guardian-filtering.yml`: a task rendering each `(user, window)` list via
  `e2guardian.users | subelements('windows', skip_missing=true)`, dest keyed by
  the same slug the filtergroup uses, notifying **Reload e2guardian**.

### Docs

- `docs/architecture.md` -> "Enforcement responsibilities": change the Per-website
  time-window row from *"e2guardian config swap on schedule | Ansible + systemd
  timer"* to *"e2guardian `#time:` list tag | Ansible-deployed config"* and add a
  sentence recording the decision + the date-scoped deferral.

## Tests (server/tests/transport/ansible/)

- `e2guardianTimeTag`: Mon-Fri window; weekend; all-day (null minutes -> `0 0 24 0`);
  daily (null days -> `0123456`); end-of-day `1440` -> `24 0`; single day.
- `buildE2guardianPlan` windowed: single window; multiple denies sharing a window
  (dedupe+sort); distinct windows sorted; windowed-only user gets a group;
  always-on + windowed coexist; group-target expansion; `domain_group` skipped;
  date-scoped-recurring **still skipped** (deferred #142).
- Evolve the existing "ignores ... recurring/windowed denies ..." test: it encoded the
  *old* contract #216 changes — split into "ignores allow/extend + date-scoped"
  (still `[]`) and move the recurring case to the positive tests. Not a weakening.
- Update `SAMPLE_PLAN` + the exact extra-vars match to carry `windows`.
- `pushE2guardianFiltering`: windows reach the nested extra-vars.
- New `e2guardian-playbook.test.ts`: js-yaml parse guard — the windowed-list task
  exists, loops `subelements(...,'windows')`, dest slug matches the filtergroup
  `.Include`, and notifies Reload e2guardian.

## Phases

1. Server plan-gen (schema + resolvers + formatter) + unit tests.
2. Playbook + templates + YAML-parse guard test + architecture doc.

## License boundary

Unchanged. e2guardian configured only by writing config files + reload via the
Ansible subprocess; nothing linked/imported/vendored; no GPL binary in the image.
