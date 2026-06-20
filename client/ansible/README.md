# `client/ansible/` — server-driven client configuration

Playbooks the **dashboard** runs against enrolled clients over SSH, via the
Ansible runner (`server/src/transport/ansible/`). The runner execs
`ansible-playbook` as a subprocess from an isolated venv in the data volume and
parses its exit code — Ansible (GPL-3.0) is **never** linked into the dashboard
process (`CLAUDE.md` → "License boundaries", rule 3).

## Layout

```
client/ansible/
├── ansible.cfg                       # baseline config for local lint/syntax-check
└── playbooks/
    ├── e2guardian-filtering.yml      # #90 — per-UID web filter + iptables redirect
    └── templates/                    # Jinja2 templates the playbooks render
```

At first-run setup (#39) the dashboard copies `playbooks/` into the data-volume
Ansible directory (`PCT_ANSIBLE_DIR`, default `/data/ansible`); the runner
resolves a playbook at `<ansibleDir>/playbooks/<name>` and a per-run dynamic
inventory it generates from the `Client` records.

## `--extra-vars` contracts

Each playbook is driven entirely by extra-vars the dashboard computes from
policy — the client holds no dashboard state. The contracts are defined and
validated server-side (zod), so the playbook and the dashboard cannot drift:

- **`e2guardian-filtering.yml`** ← `e2guardian` (see `e2guardianPlanSchema` in
  `server/src/transport/ansible/e2guardian.ts`): a `proxyPort`, the
  `redirectPorts` to capture, and a `users[]` list of
  `{ linuxUsername, linuxUid, filterGroup, listenPort, bannedSites[] }`.

## Validation

These playbooks are validated structurally in CI / locally:

```bash
cd client/ansible
ansible-playbook --syntax-check playbooks/e2guardian-filtering.yml \
  -i 'localhost,' -e @../../server/test-fixtures/... # (extra-vars supplied at run time)
ansible-lint playbooks/
```

Live behaviour (config actually filters, iptables actually redirects) is
asserted by a Molecule integration test against a containerised e2guardian
client — tracked separately because it needs privileged Docker infra (see the
issue linked from the #90 PR), the same way the live `timekpra` round-trip
(#207) is split from the unit-tested command generation.
