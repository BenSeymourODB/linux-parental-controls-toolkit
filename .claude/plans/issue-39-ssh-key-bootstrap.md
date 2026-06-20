# Issue #39 — SSH key bootstrap (first-run step, Phase 4 slice)

`#39` is a cross-phase tracker for the heavier first-run steps deferred from
`#6`'s entrypoint skeleton. This plan implements **only** its **SSH key
bootstrap** step (the Phase-4 step). The other steps stay deferred to their
phases:

- Schema migration — already done in-process (`#49`, `policy/db.ts`).
- Ansible venv bootstrap — Phase 6.
- AdGuard Home fetch — Phase 7.

## Problem

The SSH transport facade (`transport/ssh/facade.ts`) needs an OpenSSH-format
**private** key, and the `#77` enrol response reads the **public** key from
`settings.sshPublicKeyPath` (default `/data/secrets/ssh/id_ed25519.pub`) — but
**nothing generates the keypair**. The enrol response therefore always returns
`sshPublicKey: null`, and live SSH wiring (`#198`, `#84`, `#201`, `#196`) is
blocked on it.

## Approach

Generate the keypair **in-process at boot**, mirroring the migrate-on-boot
precedent (`#49`): no `ssh-keygen` binary added to the runtime image, no GPL
surface, no process/network boundary touched. Pure Node `crypto`
(`generateKeyPairSync('ed25519')`) plus a small OpenSSH serializer, since Node
emits PKCS#8/SPKI, not the `openssh-key-v1` format the facade/enrol path expect.

### Files

1. **`server/src/setup/ssh-keys.ts`** (new)
   - `generateOpenSshEd25519KeyPair(comment)` — pure: returns
     `{ privateKey, publicKey }` as OpenSSH-format strings. Uses Node `crypto`
     JWK export to get the raw 32-byte seed (`d`) + public (`x`), then
     serializes the `openssh-key-v1` private blob (cipher/kdf `none`) and the
     `ssh-ed25519 <base64> <comment>` public line.
   - `ensureServerSshKeyPair({ privateKeyPath, publicKeyPath, comment?, log? })`
     — idempotent fs writer. If the private key already exists → no-op
     (`generated: false`); never regenerate over an existing key (would break
     already-enrolled clients). Otherwise create the dir (`0700`), write the
     private key (`0600`) and public key (`0644`), return `generated: true`.
     Throws on a genuine fs error (misconfigured volume) — a real problem the
     operator must see, not a silent skip.

2. **`server/src/config.ts`**
   - Add `sshPrivateKeyPath` (`PCT_SSH_PRIVATE_KEY_PATH`, default
     `/data/secrets/ssh/id_ed25519`), symmetric with the existing
     `sshPublicKeyPath`. The bootstrap writes it; the facade's live wiring
     (deferred) reads it.

3. **`server/src/main.ts`**
   - After `buildApp`, before `listen`, call `ensureServerSshKeyPair` with
     `app.log` so a keygen failure degrades gracefully (log + continue serving;
     enrol returns `null` key) rather than crashing the dashboard — matching the
     "start anyway, surface the error" posture in `docs/server-deployment.md`.
     (`main.ts` is coverage-excluded; the logic lives in the tested module.)

4. **`server/docker-entrypoint.sh`** — update the comment block: SSH keygen is no
   longer "deferred", it runs in-process at boot (like migration).

5. **`docs/server-deployment.md`** — update First-run setup step 4 (keygen now
   lands / runs in-process) and document `PCT_SSH_PRIVATE_KEY_PATH`.

### Tests — `server/tests/setup/ssh-keys.test.ts`

- `generateOpenSshEd25519KeyPair`: output parses via `ssh2`'s `utils.parseKey`
  (strong validity proof, no live server), key type `ssh-ed25519`, the parsed
  public key matches the emitted `.pub` line, distinct keys per call, comment
  honoured.
- `ensureServerSshKeyPair`: generates when absent (`generated: true`, both files
  present + parseable, private `0600`, dir `0700`); idempotent when present
  (`generated: false`, bytes unchanged — no regeneration); creates a missing
  parent dir; throws on an unwritable target (parent is a file).

## License-boundary note

Pure TypeScript + Node `crypto` + `node:fs`. `ssh2` is used **only in tests** to
parse/validate (it's already a dep; MIT). No GPL code linked, no `ssh-keygen`
binary added to the image, no subprocess/REST boundary. `license-guard`
unaffected. No new dependency.

## Deferred (stays tracked on #39)

- Ansible venv bootstrap (Phase 6), AdGuard fetch (Phase 7).
- Live facade wiring that *reads* the private key (`#198`/#39 follow-up).
