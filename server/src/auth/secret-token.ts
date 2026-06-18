/**
 * High-entropy bearer-secret helpers (issue #77).
 *
 * Enrolment tokens and per-client bearer tokens are **random 256-bit secrets**,
 * not user-chosen passwords. The right primitive for those is a fast
 * cryptographic hash (SHA-256) of the raw token, stored at rest so a database
 * leak never exposes a usable credential — deliberately distinct from
 * {@link ../auth/passwords.ts}'s Argon2id, which exists to slow down brute
 * force against *low*-entropy passwords. A 256-bit random token has no brute
 * force to slow down, so a salted slow hash would buy nothing and only add
 * per-request cost.
 *
 * Reusable for any opaque bearer secret the dashboard issues (the future
 * `integration_tokens` secret can share it).
 *
 * License boundary: none touched — `node:crypto` only.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Bytes of entropy in a minted token (256 bits). */
const TOKEN_BYTES = 32;

/**
 * Mint a new opaque token: URL-safe base64 of {@link TOKEN_BYTES} random bytes.
 * The plaintext is shown to the caller exactly once; only its {@link hashToken}
 * digest is persisted.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256 of a token, hex-encoded — the form stored and looked up by. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex digests. Lookups are by hash (so the DB
 * index does the matching), but this is exported for any path that compares a
 * presented hash against a stored one without leaking timing.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  // timingSafeEqual throws on length mismatch; guard so a wrong-length input is
  // a plain `false` rather than an exception.
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}
