# Issue #76 — `client/install-client.sh` one-command Mint enrolment (orchestrator)

Phase 3 anchor. The single command that turns a fresh Linux Mint (Cinnamon)
desktop into an enrolled, supervised client. It **sequences** the already-landed
Phase-3 sub-steps (it does not re-implement them):

- `client/lib/provision-agent-user.sh` (#78) — `pct_provision_agent_user`,
  `pct_authorize_ssh_key` (sourceable).
- `client/install-baseline-tools.sh` (#79) — `pct_install_baseline_tools`
  (sourceable, dry-run aware).
- The server enrolment endpoint `POST /api/clients/enrol` (#77) — returns the
  per-client `bearerToken` and the dashboard `sshPublicKey` (nullable).
- The post-install self-test (#80) — **not yet implemented**; invoked if present,
  skipped with a note otherwise (forward-compatible hook, tracked by #80).

Authoritative spec: `docs/client-install.md` (Usage + "What the script does"),
`docs/roadmap.md` → Phase 3.

## Hard constraints honoured

- **License boundary:** pure bash orchestration. GPL tools come from apt /
  upstream releases (handled by #79), never vendored or linked. No GPL binary
  added anywhere. `license-guard` unaffected.
- **Tamper resistance is bounded:** the orchestrator only lays down least-
  privilege baseline (the `pct-agent` NOPASSWD-`timekpra` rule from #78). No
  lockdown, no anti-tamper, no `/etc` hardening.

## CLI

```
sudo bash client/install-client.sh \
    --server-url https://parentalcontrols.lan \
    --enrolment-token <one-time token from dashboard> \
    --supervised-user alice [--supervised-user bob ...]
```

Env fallbacks: `PCT_SERVER_URL`, `PCT_ENROLMENT_TOKEN` (safer than the CLI flag,
which is visible in `ps`), `PCT_SUPERVISED_USERS` (space list, matching #79).
`--ssh-user` overrides the SSH principal (default `pct-agent`).

## Flow

1. **Arg/usage parsing** — required `--server-url`, `--enrolment-token`,
   ≥1 `--supervised-user`; `--help`.
2. **Pre-flight** — Debian-family (`pct_require_debian_family`); root unless
   dry-run; `curl` + `python3` present; server URL reachable (`curl` probe);
   each supervised user exists (resolve `linuxUid` via `id -u`).
3. **Provision `pct-agent`** — `pct_provision_agent_user` (account + scoped
   sudoers). The dashboard SSH key is authorized *after* enrol (the enrol
   response carries it).
4. **Install + baseline-configure tools** — `pct_install_baseline_tools <users>`.
5. **Enrol** — `POST {server}/api/clients/enrol` with
   `Authorization: Bearer <enrolment-token>` and
   `{hostname, sshUser, supervisedUsers:[{linuxUsername, linuxUid}]}`. Parse the
   JSON response (`python3`) for `clientId`, `bearerToken`, `sshPublicKey`.
6. **Authorize the dashboard key** — `pct_authorize_ssh_key "$sshPublicKey"` when
   non-null; warn + continue when null (Phase-4 keygen pending — graceful
   degrade, per #77).
7. **Persist client credentials** — write `${PCT_STATE_DIR:-/etc/pct}/pct-client.env`
   (0600 root): `PCT_SERVER_URL`, `PCT_CLIENT_ID`, `PCT_CLIENT_BEARER_TOKEN`. This
   is the hand-off artifact the Phase-8b `pct-client-bridge` will read; we only
   *persist* the credential the registration produced (bridge install is #101,
   out of scope here).
8. **Self-test** — run `${PCT_SELF_TEST:-<dir>/self-test.sh}` if executable;
   otherwise note it is pending (#80) and skip (non-fatal).

Idempotent + re-runnable: every sub-step is already idempotent; re-enrol needs a
fresh token (single-use) — the orchestrator surfaces the server's error cleanly.

## Testability (matches the repo's dry-run + PATH-stub conventions)

- The orchestrator is **dry-run aware** (`PCT_DRY_RUN=1`): network calls and the
  not-dry-run-aware provision/key-authorize calls print a plan line instead of
  executing, so a dry run has zero side effects and runs unprivileged anywhere.
- The baseline sub-step (already dry-run aware) is still invoked under dry-run so
  its detailed plan shows.
- The enrol **response parsing** runs in dry-run too, fed by
  `PCT_FAKE_ENROL_RESPONSE`, so the JSON extraction + null-key branch are tested
  without a server.
- `client/tests/install-client.bats` drives the CLI under `PCT_DRY_RUN=1` with a
  fixture `os-release` (as `install-baseline-tools.bats` does).

## CI gates

- `shellcheck` over `client/**/*.sh` (with `# shellcheck source=` directives).
- `bats client/tests/` — new `install-client.bats`.
- No TypeScript change (the enrol endpoint already shipped in #77).

## Out of scope (tracked)

- The post-install self-test script itself — #80.
- `pct-client-bridge` / `pct-client-agent` `.deb` install — Phase 8b (#101/#106).
- Per-distro adapters under `client/distros/` — future, per `docs/client-install.md`.
