/**
 * Tests for the server SSH key bootstrap (#39, Phase-4 first-run step).
 *
 * Correctness of the hand-rolled OpenSSH serializer is proven by parsing the
 * generated key with `ssh2`'s own parser — the same library the transport
 * facade authenticates with — so we never assert against a live SSH server.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { utils } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureServerSshKeyPair, generateOpenSshEd25519KeyPair } from "../../src/setup/ssh-keys.js";

/** Parse a private key via ssh2, asserting it is valid (not an Error). */
function parseOrThrow(privateKey: string): ReturnType<typeof utils.parseKey> {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

describe("generateOpenSshEd25519KeyPair", () => {
  it("produces a private key ssh2 parses as a valid ed25519 key", () => {
    const { privateKey } = generateOpenSshEd25519KeyPair();
    const parsed = parseOrThrow(privateKey);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    expect(key.type).toBe("ssh-ed25519");
  });

  it("wraps the private key in OpenSSH PEM armor", () => {
    const { privateKey } = generateOpenSshEd25519KeyPair();
    expect(privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(privateKey.trimEnd().endsWith("-----END OPENSSH PRIVATE KEY-----")).toBe(true);
  });

  it("emits a single-line ssh-ed25519 public key whose blob matches the private key", () => {
    const { privateKey, publicKey } = generateOpenSshEd25519KeyPair();
    expect(publicKey.endsWith("\n")).toBe(true);

    const [type, blob, comment] = publicKey.trim().split(" ");
    expect(type).toBe("ssh-ed25519");
    expect(comment).toBe("pct-dashboard");

    // The public blob the private key derives must equal the one we wrote.
    const parsed = parseOrThrow(privateKey);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    const derivedBlob = key.getPublicSSH().toString("base64");
    expect(blob).toBe(derivedBlob);
  });

  it("honours a custom comment", () => {
    const { publicKey } = generateOpenSshEd25519KeyPair("admin@homelab");
    expect(publicKey.trim().endsWith(" admin@homelab")).toBe(true);
  });

  it("generates a distinct key on each call", () => {
    const a = generateOpenSshEd25519KeyPair();
    const b = generateOpenSshEd25519KeyPair();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe("ensureServerSshKeyPair", () => {
  let dir: string;
  let privateKeyPath: string;
  let publicKeyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-keygen-"));
    privateKeyPath = join(dir, "id_ed25519");
    publicKeyPath = join(dir, "id_ed25519.pub");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates and writes both files when absent", () => {
    const result = ensureServerSshKeyPair({ privateKeyPath, publicKeyPath });
    expect(result.generated).toBe(true);

    const priv = readFileSync(privateKeyPath, "utf8");
    const pub = readFileSync(publicKeyPath, "utf8");
    expect(parseOrThrow(priv)).toBeDefined();
    expect(pub.startsWith("ssh-ed25519 ")).toBe(true);
  });

  it("writes the private key 0600 and public key 0644", () => {
    ensureServerSshKeyPair({ privateKeyPath, publicKeyPath });
    expect(statSync(privateKeyPath).mode & 0o777).toBe(0o600);
    expect(statSync(publicKeyPath).mode & 0o777).toBe(0o644);
  });

  it("creates a missing parent directory 0700", () => {
    const nested = join(dir, "secrets", "ssh");
    const result = ensureServerSshKeyPair({
      privateKeyPath: join(nested, "id_ed25519"),
      publicKeyPath: join(nested, "id_ed25519.pub"),
    });
    expect(result.generated).toBe(true);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  it("is a no-op when the private key already exists (never regenerates)", () => {
    const first = ensureServerSshKeyPair({ privateKeyPath, publicKeyPath });
    expect(first.generated).toBe(true);
    const original = readFileSync(privateKeyPath, "utf8");

    const second = ensureServerSshKeyPair({ privateKeyPath, publicKeyPath });
    expect(second.generated).toBe(false);
    // The existing key must be untouched so enrolled clients keep working.
    expect(readFileSync(privateKeyPath, "utf8")).toBe(original);
  });

  it("logs the generate and skip outcomes via the supplied logger", () => {
    const messages: string[] = [];
    const log = {
      info: (_obj: unknown, msg?: string) => {
        if (msg !== undefined) messages.push(msg);
      },
    };
    ensureServerSshKeyPair({ privateKeyPath, publicKeyPath, log });
    ensureServerSshKeyPair({ privateKeyPath, publicKeyPath, log });
    expect(messages.some((m) => m.includes("generated"))).toBe(true);
    expect(messages.some((m) => m.includes("already present"))).toBe(true);
  });

  it("throws when the target path cannot be written (genuine misconfiguration)", () => {
    // A regular file where the key directory should be makes mkdir/write fail —
    // a real volume misconfiguration that must surface, not be skipped.
    const filePath = join(dir, "not-a-dir");
    writeFileSync(filePath, "x");
    expect(() =>
      ensureServerSshKeyPair({
        privateKeyPath: join(filePath, "id_ed25519"),
        publicKeyPath: join(filePath, "id_ed25519.pub"),
      }),
    ).toThrow();
  });
});
