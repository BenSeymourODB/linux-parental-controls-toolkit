# Plan — #80 Client post-install self-test

Roadmap: `docs/roadmap.md` → Phase 3 ("Self-test that runs at the end of the
script"). Spec: `docs/client-install.md` → step 9.

## Goal

A standalone, read-only client-side self-test that reports a clear pass/fail
per component and exits non-zero if any check fails, so the installer
(`install-client.sh`, #76 / PR #158) surfaces a broken enrolment.

## Interface (matches the #158 orchestrator)

The orchestrator (`pct_orch_self_test`) runs, as a subprocess:

```
self_test="${PCT_SELF_TEST:-${PCT_INSTALL_DIR}/self-test.sh}"
PCT_SUPERVISED_LIST="${users[*]}" "$self_test"
```

So the deliverable is **`client/self-test.sh`** (executable), reading the
space-separated supervised users from `PCT_SUPERVISED_LIST` (also accepting
repeatable `--supervised-user` for standalone use, and `PCT_SUPERVISED_USERS`
for parity with `install-baseline-tools.sh`).

## House style (mirror existing client scripts)

- Source `lib/pct-common.sh` for `pct_log/ok/warn/err`, `pct_is_dry_run`,
  distro detection.
- Single script with `pct_selftest_*` functions + a CLI `main`, guarded by
  `if [ "${BASH_SOURCE[0]}" = "${0}" ]` so it is both runnable and sourceable
  (bats sources individual check functions).
- Every external binary / path is an overridable env var so bats can stub it
  without root, network, or the real tools (the established pattern:
  `PCT_VISUDO`, `PCT_TIMEKPRA_PATH`, `AW_HOST`/`AW_PORT`, …).
- Dry-run aware: `PCT_DRY_RUN=1` prints the intended probes as a
  side-effect-free preview and exits 0 (a self-test has nothing to check on a
  machine it must not touch).

## Checks (from #80 + docs step 9)

Each check is a function that calls `pct_selftest_pass`/`pct_selftest_fail`;
a global failure counter drives the exit code.

1. **pct-agent account** exists (`PCT_GETENT passwd $PCT_AGENT_USER`).
2. **Dashboard SSH key authorized** — `~pct-agent/.ssh/authorized_keys`
   present, non-empty, mode `0600`, `.ssh` mode `0700`. (A full loopback
   SSH-as-dashboard needs the dashboard's *private* key, which the client does
   not hold; the server-side round-trip is the #81 Clients-health job. We
   verify the client-side prerequisites and that sshd is up.)
3. **sshd active** (`PCT_SYSTEMCTL is-active $PCT_SSHD_SERVICE`).
4. **Scoped sudoers** — the `$PCT_SUDOERS_DIR/pct-agent` drop-in exists, is
   mode `0440`, grants exactly `NOPASSWD: $PCT_TIMEKPRA_PATH`, and grants
   nothing broader (no `NOPASSWD: ALL`, no bare `ALL=(ALL...) ALL`).
5. **Timekpr daemon** active (`is-active $PCT_TIMEKPR_SERVICE`).
6. **timekpra status** — `$PCT_TIMEKPRA --userinfo <user>` returns 0 for each
   supervised user (the verified admin-CLI grammar; the transport uses
   `--userinfo`).
7. **aw-server** — `$PCT_CURL` GETs `http://$AW_HOST:$AW_PORT/api/0/buckets/`
   with a 2xx and a JSON-object body (buckets).
8. **e2guardian** active (`is-active $PCT_E2GUARDIAN_SERVICE`).
9. **Enrolment record** — `$PCT_STATE_DIR/pct-client.env` exists, mode `0600`,
   carries non-empty `PCT_CLIENT_ID` and `PCT_CLIENT_BEARER_TOKEN` (what the
   #158 orchestrator persists).

Output: a non-punitive checklist (`[ok]` / `[error] … : reason`) plus a
summary line; exit `1` if any check failed, `0` otherwise.

## License / tamper notes

Pure bash read-only probes. No GPL linkage (timekpra/aw-server reached only as
a subprocess / over their loopback REST API). Nothing here hardens beyond the
documented ceiling — it only *verifies* the least-privilege baseline #78/#79
laid down.

## Tests — `client/tests/self-test.bats`

Drive the CLI under stubs in a tmpdir (fake `systemctl`/`curl`/`timekpra`/
`getent` whose behaviour is env-controlled) plus fixture files for the
sudoers / authorized_keys / enrolment checks. Cover: all-pass → exit 0; each
check failing independently → exit 1 with its reason; dry-run preview → exit 0
no side effects; supervised users from `PCT_SUPERVISED_LIST`; `--help`.
`shellcheck` clean; no regression in the existing client suites.
