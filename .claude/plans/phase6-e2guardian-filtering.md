# Plan — #90: e2guardian per-UID filter groups + iptables OUTPUT redirect

Roadmap: `docs/roadmap.md` → Phase 6 (first playbook in the repo).
Issue: #90. Architecture: `docs/architecture.md` → "Enforcement responsibilities"
(Per-website filter → e2guardian → Ansible-deployed config; iptables OUTPUT
redirect to e2guardian).

## What lands in this PR (a meaningful, mergeable slice)

1. **Server-side plan generation** — pure, unit-tested derivation of a typed,
   zod-validated per-UID e2guardian filter plan from policy.
   - `server/src/transport/ansible/e2guardian.ts`:
     - `e2guardianPlanSchema` / `E2guardianPlan` — the `--extra-vars` contract.
     - `buildE2guardianPlan(db, clientId, opts?)` — for each supervised user
       linked to the client (`listClientLinks`), gather their **always-on
       `deny` schedules** (no recurrence days, no intra-day window, no effective
       date bounds — the degenerate always-on row per ADR 0005) that target a
       **`domain`-kind** Activity (directly, or via a `group` whose members are
       `domain` activities). Collect the concrete domain matchers, dedupe+sort,
       and assign a deterministic filter-group number + listen port per UID.
     - Scope boundary: `domain_group` activities (named bundles the client
       expands) and **time-windowed** denies are deferred (see below).
   - `listClientLinks(db, clientId)` added to `policy/repository.ts` (mirrors
     `listUserLinks`).
2. **Runner wiring** — `pushE2guardianFiltering({ runner, host, plan, sink?, ...})`
   passes the plan to the existing `AnsibleRunner` as nested `--extra-vars`
   (the runner's `extraVars` type is widened to a JSON object — it already
   `JSON.stringify`s it), measures duration, maps the Ansible error taxonomy to
   an `AuditOutcome`, and records an optional audit entry. Unit-tested with an
   injected stub runner + sink.
3. **Ansible playbook + templates** (`client/ansible/`, establishing the
   layout) consuming `e2guardian` extra-vars:
   - per-UID e2guardian filter group config + banned-site lists under
     `/etc/e2guardian/pct.d/` (the namespace the Phase-3 baseline reserved),
   - the paired iptables OUTPUT redirect (`-m owner --uid-owner <uid>` → the
     user's e2guardian listen port) for tcp/80 and tcp/443, idempotent,
   - reload e2guardian + persist iptables.
   - Validated with `ansible-playbook --syntax-check` + `ansible-lint`.

## Deferred (new follow-up issues, linked from the PR)

- **Per-website time-window config swaps** on a schedule (the issue explicitly
  notes this can be a follow-up).
- **Live Molecule integration test** (`ansible.int.test.ts`) applying the
  playbook against a real e2guardian client and asserting filtering + iptables
  state — needs privileged Docker infra not available in the scheduled sandbox
  (mirrors the #207 deferral for the live `timekpra` round-trip). Until it runs,
  the e2guardian directive details are best-effort + structurally validated.
- **`domain_group` expansion** (named bundles → concrete lists) — owned by
  #178/#195 (richer matcher + domain/domain_group resolution).

## License boundary

e2guardian is configured purely by writing config files + signalling a reload,
driven by `ansible-playbook` as a subprocess. No in-process/GPL linkage, no GPL
binary added to the image. (`CLAUDE.md` → "License boundaries".)

## Quality gate

`npm run format && npm run lint:fix && npm run typecheck && npm test` from
`server/`; coverage ≥ 80%. `ansible-playbook --syntax-check` + `ansible-lint`
on the new playbook.
