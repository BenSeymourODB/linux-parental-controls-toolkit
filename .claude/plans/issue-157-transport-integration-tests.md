# Issue #157 — Transport integration tests: live SSH round-trip

Roadmap: `docs/roadmap.md` → Phase 4 (SSH + `timekpra` transport).

## Goal

Add the repo's **first** `*.int.test.ts` tests, exercising the Phase-4 SSH
transport against a real OpenSSH server (the boundary the in-process fake
transport in the unit tests cannot reach), and a `TimekprClient` round-trip
over that real SSH connection against the existing stub `timekpra`.

## Why a slice (deferred work)

#157 ultimately wants a round-trip against the **real `timekpra` binary** to
confirm the upstream CLI grammar (`--setallowedhours` weekday-list day
position, `[mm-60]` minute-window upper bound). That needs a Timekpr-nExT
D-Bus/systemd daemon container — distinct, heavier infra that cannot be stood
up in the scheduled-run sandbox (no Docker daemon here). It is deferred to a
new follow-up issue and linked from the PR. This PR therefore **addresses**,
not closes, #157.

The CI `integration.yml` `ssh-transport` job already starts
`lscr.io/linuxserver/openssh-server` with the stub `timekpra` mounted and runs
`tests/transport/ssh/*.int.test.ts` — it merely skips today because no such
test exists. Adding the tests activates real CI verification.

## Deliverables

1. `server/tests/helpers/ssh-live.ts` — reads `SSH_TARGET_HOST` /
   `SSH_TARGET_PORT` / `SSH_TARGET_USER` / `SSH_TARGET_KEY[_FILE]`, exposes
   `liveSshEnabled`, `liveSshTarget()`, and a `waitForSshReady()` readiness
   probe (so container-startup races don't flake the suite).
2. `server/tests/transport/ssh/ssh.int.test.ts` — `SshTransport` live:
   `exec`/`execChecked`/`execAndParse`, the error taxonomy
   (`SshUnreachableError`/`SshCommandError`/`SshParseError`), shell-quote
   integrity over the wire, connection pooling + dispose.
3. `server/tests/transport/timekpr/timekpr.int.test.ts` — `TimekprClient` over
   real SSH against the stub: setters → read `/tmp/timekpra-invocations.log`
   back over SSH, assert exact argv (incl. weekday-list day + `[mm-60]` +
   unaccounted hour); `getUserInfo()` exercises the `--userinfo` parser.
4. `server/tests/stubs/timekpra` — POSIX-sh / busybox-safe; add a canned
   `--userinfo` `KEY: VALUE` block.
5. `.github/workflows/integration.yml` — complete the `ssh-transport` job's
   key-auth wiring (generate a keypair, inject `PUBLIC_KEY` + `USER_NAME`,
   pass key/user to the test) and run both `ssh/` and `timekpr/` int dirs.
6. `docs/testing.md` — mirror the key-auth wiring in the local reproduction
   snippet.

## Tests are env-gated

All three are `describe.skipIf(!liveSshEnabled)` and the integration vitest
config only collects `*.int.test.ts`, so `npm test` (unit) and any env without
the container stay green. Local quality gate (format/lint/typecheck/unit+cov)
is fully verifiable here; the live SSH job is verified by the PR's
`integration.yml` run.

## License boundary

Unchanged — pure exec-over-SSH (`ssh2`), no GPL linkage, no GPL binary added to
any image (the stub is a tiny shell script, the OpenSSH container is a test
fixture only). `CLAUDE.md` → "License boundaries"; `docs/licensing-analysis.md`.
