/**
 * Argon2id password hashing for the single admin login (#52).
 *
 * Thin, typed wrappers over the `argon2` library so the rest of the auth code
 * never touches its options directly. We use **Argon2id** — the variant the
 * OWASP Password Storage Cheat Sheet recommends as the default — at the
 * library's built-in memory/time/parallelism cost, which already matches the
 * OWASP baseline (m=64MiB, t=3, p=4).
 *
 * License boundary: `argon2` is MIT-licensed and linked in-process freely; no
 * GPL component is involved.
 */
import argon2 from "argon2";

/** Argon2id options shared by every hash we mint. */
const HASH_OPTIONS = { type: argon2.argon2id } as const;

/**
 * A pre-computed Argon2id hash of a throwaway string. {@link verifyPassword}
 * runs against this when the supplied username has no admin row, so a login
 * attempt for a non-existent user costs the same as one for the real admin —
 * denying an attacker a timing oracle for username enumeration. It is a hash of
 * a non-secret constant; its only job is to make the verify path do real work.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$IhDI7BiGvw/LNZ7+BcUvlQ$QhhS4JpF/r+NTZ/g1rhXDm2LA7Bxwg8X0AwMFT3zC74";

/** Hash a plaintext password with Argon2id. Returns the encoded hash string. */
export function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, HASH_OPTIONS);
}

/**
 * Verify a plaintext password against an encoded Argon2id hash. Returns `false`
 * (never throws) on a mismatch or a malformed/foreign hash string, so callers
 * can treat any non-`true` result as "wrong password".
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * Run a verify against {@link DUMMY_HASH} and discard the result. Called on the
 * unknown-username path so its timing matches a real verify; always resolves
 * (the dummy password never matches, and a throw is swallowed).
 */
export async function verifyDummy(plaintext: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, plaintext);
}
