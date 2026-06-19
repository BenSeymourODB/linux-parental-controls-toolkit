/**
 * Server SSH key bootstrap (the Phase-4 first-run step of #39).
 *
 * The dashboard authenticates to every client over SSH with a single
 * key pair it owns (`docs/server-deployment.md` → "First-run setup" step 4).
 * The `transport/ssh` facade reads the OpenSSH-format **private** key, and the
 * enrol response (#77) hands clients the matching **public** key to authorize.
 * Something has to *generate* that pair on first run — this module does, and
 * it runs **in-process at boot** (`main.ts`), mirroring the migrate-on-boot
 * decision (#49) so the runtime image needs no `ssh-keygen` binary.
 *
 * Node's `crypto` emits PKCS#8 / SPKI, not the `openssh-key-v1` format the
 * facade and `ssh-ed25519 …` public line use, so this module serializes that
 * format itself (cipher/kdf `none` — the key lives behind the data-volume's
 * filesystem permissions, not a passphrase, matching how clients authorize a
 * single unencrypted server key).
 *
 * License boundary: none touched. Pure `node:crypto` + `node:fs`; no SSH
 * library is linked here (the facade's `ssh2` and the tests' parser are
 * elsewhere), no `ssh-keygen` binary is added to the image, no subprocess or
 * REST boundary is involved.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Default comment baked into the generated public key. */
const DEFAULT_KEY_COMMENT = "pct-dashboard";

/** OpenSSH key-type tag for Ed25519 keys. */
const ED25519_KEY_TYPE = "ssh-ed25519";

/** `openssh-key-v1\0` — the AUTH_MAGIC prefix of an OpenSSH private key. */
const OPENSSH_AUTH_MAGIC = Buffer.from("openssh-key-v1\0", "binary");

/** An unencrypted OpenSSH private key has block size 8 for padding. */
const UNENCRYPTED_BLOCK_SIZE = 8;

/** A generated OpenSSH-format Ed25519 key pair, as text ready to write. */
export interface OpenSshKeyPair {
  /** OpenSSH-format private key (`-----BEGIN OPENSSH PRIVATE KEY-----`). */
  privateKey: string;
  /** Single-line public key (`ssh-ed25519 <base64> <comment>`). */
  publicKey: string;
}

/** Encode `value` as an SSH wire `string`: a uint32-BE length, then the bytes. */
function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

/** Encode UTF-8 `text` as an SSH wire `string`. */
function sshText(text: string): Buffer {
  return sshString(Buffer.from(text, "utf8"));
}

/** The 32-byte raw value behind a base64url JWK field (`x` or `d`). */
function rawFromJwkField(field: string | undefined, name: string): Buffer {
  if (field === undefined) {
    throw new Error(`Ed25519 JWK is missing the "${name}" field`);
  }
  return Buffer.from(field, "base64url");
}

/** The public-key blob: `string "ssh-ed25519"` + `string pub(32)`. */
function publicKeyBlob(publicRaw: Buffer): Buffer {
  return Buffer.concat([sshText(ED25519_KEY_TYPE), sshString(publicRaw)]);
}

/** Wrap base64 `body` in OpenSSH PEM armor at 70 columns. */
function pemArmor(body: string): string {
  const lines = body.match(/.{1,70}/g) ?? [""];
  return [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    ...lines,
    "-----END OPENSSH PRIVATE KEY-----",
    "",
  ].join("\n");
}

/**
 * Serialize an Ed25519 key (raw 32-byte public + 32-byte seed) into the
 * `openssh-key-v1` private-key format, unencrypted (cipher/kdf `none`).
 */
function serializeOpenSshPrivateKey(publicRaw: Buffer, seed: Buffer, comment: string): string {
  const pubBlob = publicKeyBlob(publicRaw);
  // OpenSSH stores the Ed25519 private scalar as seed(32) || public(32).
  const privateScalar = Buffer.concat([seed, publicRaw]);

  // Two matching check ints let a decrypter detect a wrong passphrase; here
  // the key is unencrypted, so they only need to be equal (still randomized).
  const check = randomBytes(4);
  const privateSection = Buffer.concat([
    check,
    check,
    sshText(ED25519_KEY_TYPE),
    sshString(publicRaw),
    sshString(privateScalar),
    sshText(comment),
  ]);

  // Pad to the cipher block size with the running sequence 1, 2, 3, …
  const padLength =
    (UNENCRYPTED_BLOCK_SIZE - (privateSection.length % UNENCRYPTED_BLOCK_SIZE)) %
    UNENCRYPTED_BLOCK_SIZE;
  const padding = Buffer.from(Array.from({ length: padLength }, (_, i) => i + 1));

  const body = Buffer.concat([
    OPENSSH_AUTH_MAGIC,
    sshText("none"), // ciphername
    sshText("none"), // kdfname
    sshString(Buffer.alloc(0)), // kdfoptions (empty)
    (() => {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(1, 0); // number of keys
      return count;
    })(),
    sshString(pubBlob),
    sshString(Buffer.concat([privateSection, padding])),
  ]);

  return pemArmor(body.toString("base64"));
}

/**
 * Generate a fresh OpenSSH-format Ed25519 key pair.
 *
 * Pure (no filesystem). `comment` defaults to `pct-dashboard` and is embedded
 * in both the public line and the private blob, matching `ssh-keygen` output.
 */
export function generateOpenSshEd25519KeyPair(
  comment: string = DEFAULT_KEY_COMMENT,
): OpenSshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Node types `export({ format: "jwk" })` as `JsonWebKey`, so no cast needed.
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });

  const publicRaw = rawFromJwkField(pubJwk.x, "x");
  const seed = rawFromJwkField(privJwk.d, "d");

  const publicLine = `${ED25519_KEY_TYPE} ${publicKeyBlob(publicRaw).toString("base64")} ${comment}\n`;

  return {
    privateKey: serializeOpenSshPrivateKey(publicRaw, seed, comment),
    publicKey: publicLine,
  };
}

/** Minimal structural logger (Fastify's `app.log` satisfies it). */
export interface KeyBootstrapLogger {
  info: (obj: unknown, msg?: string) => void;
}

/** Options for {@link ensureServerSshKeyPair}. */
export interface EnsureSshKeyPairOptions {
  /** Where the OpenSSH-format private key is written (`0600`). */
  privateKeyPath: string;
  /** Where the matching public key is written (`0644`). */
  publicKeyPath: string;
  /** Comment embedded in the generated key. Defaults to `pct-dashboard`. */
  comment?: string;
  /** Optional logger for the generate/skip outcome. */
  log?: KeyBootstrapLogger;
}

/** Outcome of {@link ensureServerSshKeyPair}. */
export interface SshKeyBootstrapResult {
  /** True iff a new pair was generated and written on this call. */
  generated: boolean;
}

/**
 * Ensure the server SSH key pair exists, generating it if absent.
 *
 * Idempotent: once the **private** key file exists this is a no-op — the key is
 * never regenerated, because that would invalidate the public key already
 * authorized on every enrolled client. (Existence is keyed on the private key
 * alone; a lost-but-not-private `.pub` is not re-derived here, since the pair is
 * always written together.) A genuine filesystem error (e.g. an
 * unwritable data volume) is thrown rather than swallowed, since it is a real
 * misconfiguration the operator must fix; the caller (`main.ts`) decides
 * whether to degrade or crash.
 */
export function ensureServerSshKeyPair(options: EnsureSshKeyPairOptions): SshKeyBootstrapResult {
  const { privateKeyPath, publicKeyPath, comment, log } = options;

  if (existsSync(privateKeyPath)) {
    log?.info({ path: privateKeyPath }, "server SSH key already present; not regenerating");
    return { generated: false };
  }

  // The key directory holds private material; create it (and any parents)
  // owner-only. `mkdir`'s `mode` is ignored when the directory already exists —
  // and the entrypoint pre-creates it under the default umask (0755) — so chmod
  // afterwards to enforce 0700 in that common path too.
  const keyDir = dirname(privateKeyPath);
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  chmodSync(keyDir, 0o700);

  const pair = generateOpenSshEd25519KeyPair(comment);

  // Write then chmod: writeFileSync's mode is masked by umask, so set the
  // intended permissions explicitly (0600 private, 0644 public).
  writeFileSync(privateKeyPath, pair.privateKey, { mode: 0o600 });
  chmodSync(privateKeyPath, 0o600);
  writeFileSync(publicKeyPath, pair.publicKey, { mode: 0o644 });
  chmodSync(publicKeyPath, 0o644);

  log?.info({ privateKeyPath, publicKeyPath }, "generated server SSH key pair (first run)");
  return { generated: true };
}
