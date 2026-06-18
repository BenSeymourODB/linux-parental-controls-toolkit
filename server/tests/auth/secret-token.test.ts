/**
 * Tests for the high-entropy bearer-secret helpers (#77).
 */
import { describe, expect, it } from "vitest";

import { generateToken, hashToken, timingSafeEqualHex } from "../../src/auth/secret-token.js";

describe("generateToken", () => {
  it("mints distinct, URL-safe, high-entropy tokens", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    // base64url of 32 bytes → 43 chars, no '+', '/' or '=' padding.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("hashToken", () => {
  it("is deterministic for the same input", () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("differs for different inputs and never echoes the plaintext", () => {
    const token = generateToken();
    const hash = hashToken(token);
    expect(hash).not.toBe(token);
    expect(hashToken(generateToken())).not.toBe(hash);
    // SHA-256 hex digest.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("timingSafeEqualHex", () => {
  it("returns true for equal digests and false otherwise", () => {
    const hash = hashToken("a-token");
    expect(timingSafeEqualHex(hash, hash)).toBe(true);
    expect(timingSafeEqualHex(hash, hashToken("other"))).toBe(false);
  });

  it("returns false (not throw) for mismatched lengths or empty input", () => {
    expect(timingSafeEqualHex("ab", "abcd")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(false);
  });
});
