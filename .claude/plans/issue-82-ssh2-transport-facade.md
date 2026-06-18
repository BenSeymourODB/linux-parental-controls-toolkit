# Plan — #82 ssh2-based transport facade (connection mgmt + exec wrapper)

Roadmap: `docs/roadmap.md` → Phase 4 ("ssh2-based transport facade").
Module: `server/src/transport/ssh/`.

## Goal

The structural license boundary for all Phase 4+ remote work: open
key-authenticated `ssh2` connections to a `Client` (as `pct-agent`), run a
command, capture `{ stdout, stderr, code }`, and tear down cleanly. We only
ever **exec subprocesses** over SSH — never link GPL code in-process
(`docs/licensing-analysis.md`, `docs/architecture.md` → "Process boundaries").

## Scope (this PR)

- Connection lifecycle: connect (key-auth), pool/reuse keyed on the target,
  `readyTimeout`, `dispose`/`disposeAll`. Eviction on `close`/`error`.
- `exec(target, argv, opts)` → typed `ExecResult { stdout, stderr, code, signal }`.
  Arguments are a **vector**, shell-quoted into the SSH command string (no raw
  interpolation) — SSH's exec request carries a single command string that the
  remote shell interprets, so safe single-quote escaping is the only correct
  way to honour "args as a vector".
- `execChecked` — throws `SshCommandError` on non-zero exit.
- `execAndParse(target, argv, schema, opts)` — `execChecked` then zod-validate
  stdout (throws `SshParseError` on mismatch). Satisfies "zod validation of any
  parsed stdout before it crosses into typed code".
- Error taxonomy distinguishing **unreachable** (connect failure / connect
  timeout → `SshUnreachableError`, feeds the Phase-4 offline-queue #84) from
  **command failed** (`SshCommandError`). Plus `SshParseError`,
  `SshExecTimeoutError`.
- `targetFromClient(client, credentials)` — derive an `SshTarget` from a
  `clients` row (`hostname`, `sshUser`) + injected SSH credentials. Key loading
  / SSH keygen stays in the entrypoint (#39, Phase 4) — out of scope here.

## Out of scope

- timekpra command builders (#83) — they will sit on top of `execAndParse`.
- Port-forwarding for the AW telemetry pull (Phase 5 / #86) — the pooled
  connection is built so it can be added later without reshaping.
- Offline-queue persistence (#84) — this PR only emits the error type it keys on.

## Files

- `src/transport/ssh/shell-quote.ts` — POSIX single-quote escaping of an argv
  vector into one safe command string. Tiny, pure, separately tested.
- `src/transport/ssh/errors.ts` — `SshError` base + `SshUnreachableError`,
  `SshCommandError`, `SshParseError`, `SshExecTimeoutError`.
- `src/transport/ssh/facade.ts` — `SshTransport` class (pool + exec methods),
  `SshTarget`/`SshCredentials`/`ExecResult` types, `targetFromClient`.
- `src/transport/ssh/index.ts` — keep `moduleName = "transport/ssh"`; re-export
  the public surface.

## Tests (Vitest, `tests/transport/ssh/`)

Unit tests mock `ssh2` at the module level (mirrors the repo's
`vi.mock("node:child_process")` pattern) with a fully-typed fake `Client`
(EventEmitter) whose `exec` yields a fake channel (data/stderr/close):

- `shell-quote.test.ts` — empty argv, plain args, spaces, single quotes,
  metacharacters (`;`, `$()`, backticks, newlines) all neutralised.
- `facade.test.ts` — connect success; connect refused → `SshUnreachableError`;
  connect timeout → `SshUnreachableError`; pooled reuse (one connect for two
  execs); eviction + reconnect after `close`; `exec` returns non-zero code
  without throwing; `execChecked` throws `SshCommandError` (carries argv/code/
  stderr); stderr capture; `exec` callback error rejects; exec timeout →
  `SshExecTimeoutError`; `execAndParse` happy path; parse failure →
  `SshParseError`; `dispose` / `disposeAll` end connections;
  `targetFromClient` maps fields + default port 22.

Integration test (`ssh.int.test.ts`, excluded from the unit run) deferred to a
follow-up unless cheap: connects to the `openssh-server` container from
`docs/testing.md`, runs the stub, asserts a real round-trip. Will gate on
`SSH_TARGET_HOST`/`SSH_TARGET_PORT` env so it no-ops when unset.

## License-boundary note

Pure exec-over-SSH; `ssh2` (MIT) is already a dependency. No GPL code linked,
no GPL binaries added to the image.
