# Issue #89 — `transport/ansible/` runner (subprocess + dynamic inventory)

Roadmap: `docs/roadmap.md` → Phase 6 ("Ansible runner inside the dashboard
(subprocess)"). Foundation the per-playbook issues (#90/#91/#92) depend on.

## Goal

A `transport/ansible/` module that invokes `ansible-playbook` **as a
subprocess** from the isolated Python venv bootstrapped into the data volume
at first run, with a dynamic inventory generated from the dashboard's `Client`
records. Never embed or vendor Ansible — the subprocess boundary *is* the
license boundary (`docs/licensing-analysis.md`, `CLAUDE.md` → "License
boundaries", rule 3).

## License-boundary check

- Only ever `execFile("<venv>/bin/ansible-playbook", argv)` — no in-process
  Ansible, no bindings, no vendored source.
- No new runtime dependency, no GPL binary added to the image (the venv lives
  in `/data`, bootstrapped by #39 — out of scope here). `license-guard` stays
  green.

## Scope (this PR)

1. **Pure inventory generation** (`inventory.ts`): `buildInventory(hosts)` →
   an Ansible **INI** inventory string (`[supervised]` group, one line per
   host `<hostname> ansible_user=<sshUser>`). INI chosen over YAML so we add
   **no `yaml` runtime dependency** and the output is trivial to reason about.
   Hostnames and SSH usernames are validated against a strict charset and
   rejected otherwise, so a hostile/garbled `Client` row can never inject
   extra inventory tokens or newlines (`AnsibleInventoryError`).
2. **The runner** (`index.ts`): `createAnsibleRunner({ ansibleDir, logger })`
   exposing `runPlaybook({ playbook, hosts, extraVars?, limit? })`:
   - resolves `<ansibleDir>/venv/bin/ansible-playbook` and
     `<ansibleDir>/playbooks/<playbook>` (playbook name validated — no path
     traversal);
   - writes the generated inventory to a per-run temp file (`mkdtemp`), passes
     `-i <file>`, and removes it in a `finally` (no clobber of a user-managed
     `/data/ansible/inventory.yml`, safe under concurrent runs);
   - `execFile`s the binary (callback style, raised `maxBuffer`), captures
     stdout/stderr/exit code, logs a structured run record via the
     `componentLogger(app, "transport/ansible")` convention (#11);
   - maps the outcome to a typed **error taxonomy** (`errors.ts`).
3. **Config** (`config.ts`): add `ansibleDir` (`PCT_ANSIBLE_DIR`, default
   `/data/ansible`) so the eventual caller/job and tests resolve the same
   path; mirror in `.env.example` + the deployment-doc env note.

## Error taxonomy (`errors.ts`)

`ansible-playbook`'s exit codes are bit-flagged by Ansible's TaskQueueManager:
`2` = failed hosts, `4` = unreachable hosts (OR-able). Map:

- spawn `ENOENT` → `AnsibleUnavailableError` (venv/binary missing — feeds the
  "Ansible not bootstrapped yet" path, #39).
- exit `(code & 4)` set → `AnsibleUnreachableError` (host(s) unreachable —
  this is what the Phase-4 offline-queue, #84, will key on).
- any other non-zero → `AnsiblePlaybookFailedError` (carries `exitCode`,
  `stderr`).
- exit `0` → resolves `AnsibleRunResult { exitCode, stdout, stderr, playbook }`.

Bad inventory input → `AnsibleInventoryError`. All extend `AnsibleError`.

## Tests (`tests/transport/ansible/`)

- `inventory.test.ts` — group/line format, per-host `ansible_user`, empty-host
  list, hostname/username validation rejects injection attempts.
- `runner.test.ts` — `vi.mock("node:child_process")` per `docs/testing.md`:
  asserts the binary path + `-i <tmp>` + playbook path + `--extra-vars` /
  `--limit` argv; the temp inventory file content; happy-path result; `ENOENT`
  → `AnsibleUnavailableError`; `code & 4` → `AnsibleUnreachableError`; other
  non-zero → `AnsiblePlaybookFailedError`; temp file cleaned up; playbook-name
  traversal rejected.
- A `config.test.ts` case for the `PCT_ANSIBLE_DIR` default/override.

## Out of scope (own issues)

- The venv bootstrap itself + `playbooks/` sync (#39, Phase 6 first-run setup).
- DB-backed audit persistence of each run (#85) — this PR logs a structured
  run record and leaves the seam; the audit *table* lands with #85.
- Loading real `Client` rows from the DB (#51 CRUD) — the runner takes injected
  hosts; a `clients` row already satisfies the `AnsibleHost` shape.
- The concrete playbooks (#90/#91/#92) and incremental output streaming.
