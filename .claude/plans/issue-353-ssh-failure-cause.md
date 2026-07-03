# Issue #353 — Classify & surface the SSH failure cause

Replace the single catch-all `"host unreachable"` string with a classified root
cause (DNS vs refused vs timeout vs auth vs handshake), from the error object up
through the prober, the health DTO, and the Clients card.

Incident driver: on v0.1.0-alpha.5 every client card showed "host unreachable"
for every component; `SshUnreachableError` collapses four distinct root causes
(each with a different fix) and the prober discards the underlying `ssh2` error.

## Design decisions

- **Retriable/queue semantics unchanged.** `reason` is *diagnostic metadata*
  only — no control-flow change. `SshUnreachableError.retriable` stays `true`
  for every reason. The issue's open question ("should `auth` skip the retry
  loop?") is **deferred and documented**, not decided here.
- **One taxonomy, one home.** The reason enum lives in
  `transport/ssh/errors.ts` beside the error it annotates, and is re-exported
  through `transport/health/index.ts` so the health DTO derives its enum from
  the same source (no drift) exactly as it already does for the component /
  reachability enums.
- **Classification is a pure function** (`classifySshUnreachableReason(cause)`)
  so it is unit-testable against representative `ssh2` error fixtures with no
  live socket. It walks the `cause` chain and matches `code` / `level` /
  `syscall` / `message` in priority order.

## Reason taxonomy

`"dns" | "connection_refused" | "timeout" | "auth" | "handshake" | "unknown"`

Priority match order (first hit wins), against a normalised signature built
from `code|level|syscall|message` across the whole `cause` chain:

1. `dns` — `ENOTFOUND`, `EAI_AGAIN`, `getaddrinfo`
2. `connection_refused` — `ECONNREFUSED`
3. `timeout` — `ETIMEDOUT`, `client-timeout`, `timed out` (covers ssh2's
   "Timed out while waiting for handshake", so it must precede `handshake`)
4. `auth` — `client-authentication`, `authentication methods failed`
5. `handshake` — `handshake`, `key exchange`/`kex`, `protocol` level
6. `unknown` — nothing matched / no cause

## Phase 1 — classify at the source (`transport/ssh`)

- `errors.ts`: add `sshUnreachableReasonValues` + `SshUnreachableReason`;
  add `classifySshUnreachableReason(cause: unknown): SshUnreachableReason`;
  add a `readonly reason` field to `SshUnreachableError`, computed from
  `options?.cause` in the constructor.
- `facade.ts`: no logic change — the three construction sites already pass
  `{ cause: err }` where an `ssh2` error exists (channel-close-without-exit
  passes none → `"unknown"`, correct: a mid-session drop carries no ssh2 error).
- Tests: `tests/transport/ssh/errors.test.ts` — the classifier against DNS /
  refused / timeout / auth / handshake / unknown fixtures, cause-chain
  traversal, and `new SshUnreachableError(ref, { cause }).reason`.

## Phase 2 — stop discarding it (`transport/health` + `api/clients`)

- `prober.ts`: `ClientProbeResult` gains `reachabilityReason: SshUnreachableReason | null`
  (`null` when online/unknown). The offline catch derives the reason
  (`SshUnreachableError.reason`; `SshExecTimeoutError` → `"timeout"`; else
  `"unknown"`), folds it into the component `detail`
  (`host unreachable (<reason>[: <cause>])`), and — via a new optional injected
  `log` — emits one structured `log.warn({ clientId?, host, reason, cause })`
  per failed probe.
- `health/index.ts`: re-export `sshUnreachableReasonValues` /
  `SshUnreachableReason`.
- `health-dtos.ts`: add `reachabilityReason: z.enum(...).nullable()` to
  `clientHealthSchema` (free-text `detail` already carries the human string;
  this is the structured field the card badges on).
- `health-service.ts`: thread `probe.reachabilityReason` into the DTO
  (`null` when no probe / online).
- `bootstrap.ts`: pass `log` into `new SshClientProber(...)`.
- Tests: extend `prober.test.ts` (reason captured, detail text, warn logged),
  `health-service.test.ts` / `health-dtos.test.ts` (DTO carries the field).

## Phase 3 — UI hint (`frontend`)

- `ClientsView.svelte`: map `reachabilityReason` → a one-line remediation hint
  shown under the reachability pill when a client is offline (DNS → enrol by IP
  / fix container DNS; refused → re-run installer `--skip-enrol`; auth → key not
  authorized; timeout → firewall / stale address; handshake → SSH version/config
  mismatch). No contract.ts change (only a new field on an already-exported DTO).
- Tests: extend the Clients view component test with an offline client carrying
  a `reachabilityReason` and assert the hint renders.

## Out of scope (tracked / deferred)

- Changing offline-queue retry behaviour for `auth` (documented as deferred; a
  focused follow-up can be filed if wanted).
- Post-enrol server-side SSH self-test that returns this classification to the
  installer (#354) — composes with this, separate issue.
