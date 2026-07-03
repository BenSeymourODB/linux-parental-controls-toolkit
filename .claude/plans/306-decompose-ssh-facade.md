# Issue #306 — Decompose the `SshTransport` facade

Roadmap: code-review complexity cleanup under the tracking epic #308.
`server/src/transport/ssh/facade.ts` (~511 lines) concentrates four
responsibilities in one class: connection pooling, command execution, port
forwarding, and (historically) error translation. Two methods carry most of the
weight — `withPortForward` (nested socket/channel setup + leak-free teardown)
and `#exec` (stream capture + timeout + error translation). This decomposes the
two heavy methods into focused, independently-testable units, leaving
`SshTransport` as a thin **pool + dispatch** facade.

## Scope taken vs. the finding's three bullets

The finding suggested three extractions:

1. `SshPortForwarder` — **this PR.**
2. `ExecBuffer` — **this PR.**
3. Move the SSH error taxonomy into `transport/ssh/errors.ts` — **already landed
   on `main`** (`errors.ts` is a populated module today: `SshError`,
   `SshUnreachableError`, `SshCommandError`, `SshParseError`,
   `SshExecTimeoutError`, `classifySshUnreachableReason`, …). Nothing to do.

So this run implements bullets 1 & 2.

## Design

Behaviour-preserving. The public surface of `SshTransport`
(`exec` / `execChecked` / `execAndParse` / `withPortForward` / `dispose` /
`disposeAll` / `connectionCount`) and every exported type
(`SshTarget`, `ExecResult`, `PortForwardTarget`, …) stay **identical**, so
`index.ts`'s re-exports and every caller are untouched. The existing
`facade.test.ts` suite (604 lines) is the regression guard and stays green
unchanged; new focused unit tests exercise the extracted units in isolation.

### `exec-buffer.ts` — `ExecBuffer`

Owns the `#exec` promise body: run `client.exec(command, …)`, buffer stdout/
stderr, translate the terminal states into the SSH error taxonomy, and enforce
the per-exec timeout.

- `new ExecBuffer({ ref, argv, timeoutMs })` then `.run(client, command)
  : Promise<ExecResult>`.
- Terminal states preserved exactly:
  - clean `exit` + `close` → resolve `{ stdout, stderr, code, signal }`.
  - exec-request `err` → reject `SshUnreachableError(ref, { cause })`.
  - `close` with no preceding `exit` (mid-command drop) → reject
    `SshUnreachableError(ref)`.
  - `timeoutMs > 0` elapsed → `channel.destroy()` + reject
    `SshExecTimeoutError(ref, argv, timeoutMs)`. `timeoutMs <= 0` disables it.
  - settle-once guard + `clearTimeout` unchanged.
- **Connection-pool eviction stays in the transport.** `ExecBuffer` knows
  nothing about the pool. `SshTransport.#exec` wraps the call and evicts the
  pooled connection **iff** the thrown error is an `SshUnreachableError` — which
  is exactly the two cases (`exec` err, close-without-exit) that evicted before,
  and *not* the timeout case (an `SshExecTimeoutError` leaves the connection
  pooled, as today, since the host is reachable and only the command hung).

### `port-forward.ts` — `SshPortForwarder`

Owns the `withPortForward` body: open a `127.0.0.1` TCP listener, forward each
inbound socket over the pooled SSH session (`client.forwardOut`), track open
sockets/channels, run the caller's `fn`, and tear everything down in a
`finally`.

- `new SshPortForwarder({ client, remote, ref })` then
  `.run(fn, localPort): Promise<T>`.
- The private module helpers `addressPort`, `listenLoopback`, `closeServer`, and
  the `LOOPBACK_HOST` constant move here with it (they are used only by the
  forward path).
- Semantics preserved: loopback-only bind; a single forwarded connection that
  fails is dropped without sinking the window; channels are destroyed on
  teardown (no half-open leak); `fn`'s result returns and its rejection
  propagates after teardown. The connect step (which can reject
  `SshUnreachableError` before `fn` ever runs) stays in `SshTransport` — the
  forwarder receives an already-connected `Client`.

### `facade.ts` after

`withPortForward` → resolve + `#connect`, then
`new SshPortForwarder({ client, remote, ref }).run(fn, options.localPort ?? 0)`.
`#exec` → shell-quote + `#connect`, then `new ExecBuffer({ ref, argv,
timeoutMs }).run(client, command)` inside a `try/catch` that evicts on
`SshUnreachableError`. Pooling (`#connect`, `#resolve`, `dispose*`,
`connectionCount`) stays put.

## License boundary

Unaffected (`CLAUDE.md`). Pure internal restructuring of the SSH facade —
everything remains subprocess/SSH-only over `ssh2`; no GPL code linked, no
subprocess/REST boundary collapsed, no new dependency, no image change.

## Phases

1. **`ExecBuffer`** — add `exec-buffer.ts`, rewire `#exec`, add
   `exec-buffer.test.ts`. Gate green → commit/push (opens draft PR).
2. **`SshPortForwarder`** — add `port-forward.ts`, rewire `withPortForward`,
   move the listener helpers, add `port-forward.test.ts`. Gate green →
   commit/push.

## Quality gate (from `server/`)

`npm run format && npm run lint:fix && npm run typecheck && npm test`
(coverage gate 80%).
