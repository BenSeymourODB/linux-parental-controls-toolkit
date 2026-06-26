# Issue #226 — Promote inline security/transport magic numbers to named constants

**Roadmap:** cross-cutting code-review polish (no phase milestone).
**Severity:** Medium · **Effort:** S · **Category:** readability.

## Finding (from the automated review, 2026-06-20)

Three security-/transport-critical defaults were flagged as inline literals
that deserve a name + one-line rationale:

- `server/src/auth/rate-limit.ts:46-47` — `maxAttempts ?? 5`,
  `windowMs ?? 15 * 60 * 1000` (login-throttling control).
- `server/src/transport/ssh/facade.ts:158,164` — `10_000` ready timeout,
  `30_000` exec timeout (hung-command protection).
- `server/src/transport/ansible/index.ts:49` — `10 * 1024 * 1024` max
  subprocess buffer (memory safety).

## What the code actually shows (the review was partly stale)

- `facade.ts` **already** hoists both timeouts to module constants
  (`DEFAULT_READY_TIMEOUT_MS`, `DEFAULT_EXEC_TIMEOUT_MS`). The exec one carries
  a rationale comment; the ready-timeout one does not.
- `ansible/index.ts` **already** hoists the buffer cap to `DEFAULT_MAX_BUFFER`
  with a one-line `//` comment.
- Only `auth/rate-limit.ts` has genuinely inline `?? 5` / `?? 15 * 60 * 1000`
  literals in the constructor.

So the substantive change is the rate-limit hoist; the SSH/Ansible work is
adding/normalising the rationale JSDoc so all three reads the same way.

## Changes

1. **`auth/rate-limit.ts`** — add module-level
   `DEFAULT_MAX_FAILED_ATTEMPTS = 5` and
   `DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000`, each with a JSDoc rationale,
   and reference them in the constructor `??` defaults. No behaviour change.
2. **`transport/ssh/facade.ts`** — give `DEFAULT_READY_TIMEOUT_MS` a one-line
   JSDoc rationale; convert the existing exec-timeout block comment to a JSDoc
   so the two constants are documented consistently. Values unchanged.
3. **`transport/ansible/index.ts`** — convert the `DEFAULT_MAX_BUFFER` `//`
   comment to a JSDoc that states the memory-safety rationale. Value unchanged.

## Tests

- `tests/auth/rate-limit.test.ts` already pins the default of 5 attempts. Add a
  test pinning the **default 15-minute window** (blocked just before
  `900_000ms`, reset at/after it) so the documented value can't silently drift.
- SSH facade / Ansible changes are comment-only (no behaviour, no coverage
  delta); the existing suites continue to pass.

## License-boundary note

N/A — pure TypeScript, comment/const refactor. No GPL linkage, no
subprocess/REST boundary touched, no Docker-image change. No new dependency.
