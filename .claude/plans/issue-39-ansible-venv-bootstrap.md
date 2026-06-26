# Issue #39 — Ansible venv bootstrap (Phase-6 step)

Issue #39 is a **cross-phase tracker** for the deferred container first-run
steps. Its slices land with their phases:

| Step | Phase | Status |
| --- | --- | --- |
| Schema migration | 2 | ✅ in-process on boot (#49) |
| SSH key bootstrap | 4 | ✅ in-process on boot (#205) |
| **Ansible venv bootstrap** | **6** | **this slice** |
| AdGuard Home fetch/supervise | 7 | deferred — AdGuard REST client/config not landed yet |

Phase 6 is reachable: the `transport/ansible` runner (#130), the re-apply
scheduler (#93), and the ActivityWatch playbook (#91) are all merged. The
runner resolves `ansible-playbook` at `<ansibleDir>/venv/bin/ansible-playbook`
and **throws `AnsibleUnavailableError` until the venv exists** — this slice is
the missing piece that creates it.

## Goal

On boot, idempotently ensure the isolated Ansible venv exists in the data
volume with `ansible-core` installed, sync the in-image playbooks into
`<ansibleDir>/playbooks/`, and surface the result so the admin UI can show
"Ansible unavailable" with a reason when a network-less first run can't pip
install. No GPL code is linked in-process — `python3`/`pip`/`ansible-playbook`
are all subprocesses (`CLAUDE.md` → License boundaries; the image already
ships `python3-venv` solely for this).

## Design decisions

1. **In-process at boot, mirroring migration (#49) and SSH keygen (#205).**
   The doc framed the Ansible step as an entrypoint step, but in-process gives
   us: Vitest tests (the entrypoint is shell), status surfaced to the admin UI,
   and no extra tooling in the image. Node spawns `python3 -m venv` / `pip` /
   `ansible-playbook` as **subprocesses** — the license boundary is identical
   to a shell entrypoint, so nothing is collapsed. Update the entrypoint comment
   and `docs/server-deployment.md` step 2 accordingly.

2. **Supervisor object holding a status snapshot, mirroring `AdGuardService`.**
   `AnsibleVenvSupervisor` exposes an immutable `.status` (read by a new
   read-only `GET /api/system/ansible` route behind `requireAdmin`, mirroring
   `GET /api/dns`) and an idempotent `async bootstrap(logger?)` that never
   throws — every failure is caught, classified, logged loudly, and surfaced.

3. **Non-blocking kickoff in `main.ts`, not `app.ts`.** `pip install
   ansible-core` is slow; we must not delay `listen`. The supervisor is built
   and decorated in `app.ts` (default state `idle`, no spawn — so unit tests
   that build the app make no subprocess calls, exactly like AdGuard `disabled`
   mode is inert). `main.ts` fires `void app.ansibleVenv.bootstrap(app.log)`
   after `listen`, like it already fires the SSH keygen. State transitions
   `idle → bootstrapping → ready | unavailable`.

4. **Version reconciliation via a sentinel.** Write the installed `ansible-core`
   version to `<venv>/.pct-ansible-core-version`. On boot: binary missing →
   create + install; binary present but sentinel ≠ configured version (or
   missing) → reinstall (upgrade reconcile, satisfying the doc's "upgrades
   reconcile it per release"); binary present and sentinel matches → no-op
   `ready`. Keeps idempotency *and* the upgrade path honest and testable.

5. **Playbook sync is best-effort + gated on packaging.** Sync from
   `ansiblePlaybookSourceDir` into `<ansibleDir>/playbooks/` when the source
   exists; a missing source is a logged no-op (does not fail the venv). The
   image does not yet COPY the playbooks (build context is `server/`; playbooks
   live in `client/ansible/playbooks/`, outside it) — so today the sync no-ops
   on the real image. That packaging gap is **out of scope here** and tracked
   in the follow-up **#260** (Dockerfile/build-context work); the sync code is
   complete and correct the moment the playbooks ship.

## Injectable seams (so tests never spawn `python3`)

`AnsibleVenvSupervisorDeps`: `runCommand(file, args)` (default
`promisify(execFile)`), `fileExists`, `readSentinel`/`writeSentinel`,
`syncPlaybooks` (default fs recursive copy), `now`.

## Phases

1. **Config + supervisor + tests.** Add `ansibleCoreVersion`
   (`PCT_ANSIBLE_CORE_VERSION`, pinned default) and `ansiblePlaybookSourceDir`
   (`PCT_ANSIBLE_PLAYBOOK_SRC`, default in-image path) to `config.ts`. Write
   `setup/ansible-venv.ts`. Unit-test the branch matrix (no-op when present +
   sentinel match; create+install when absent; reinstall on version drift;
   pip/venv failure → `unavailable`, never throws; playbook sync present/absent).
2. **Wire + API + tests.** Decorate `app.ansibleVenv` in `app.ts` (no auto-run),
   fire bootstrap in `main.ts`. Add `GET /api/system/ansible` DTO + route +
   barrel export; HTTP test (anon 401 + serialized snapshot). Config test for
   the new settings.
3. **Docs + finalize.** Update `docs/server-deployment.md` first-run step 2 and
   the `docker-entrypoint.sh` comment (Ansible venv is now an in-process boot
   step). File the playbook-packaging follow-up issue and link it.

## Acceptance criteria mapping (#39)

- Idempotent, guarded so a missing download (no network) leaves the dashboard
  starting with Ansible disabled + an error surfaced → `bootstrap()` catches
  all, sets `unavailable` + detail, `GET /api/system/ansible` surfaces it.
- No GPL binary added to the image → venv lives in `/data`; only subprocesses;
  `license-guard` untouched.
- Tests for the idempotency/branching logic → Phase 1 unit matrix.
