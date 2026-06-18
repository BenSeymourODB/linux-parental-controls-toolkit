/**
 * Unit tests for the Argon2id password helpers (#52).
 */
import { describe, expect, it } from "vitest";

import { hashPassword, verifyDummy, verifyPassword } from "../../src/auth/passwords.js";

describe("password hashing", () => {
  it("produces an Argon2id encoded hash that verifies the original", async () => {
    const hash = await hashPassword("correct horse battery staple");
    // Argon2id encoded form, not the plaintext.
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("s3cret");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("returns false (never throws) on a malformed hash string", async () => {
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
  });

  it("verifyDummy resolves without throwing", async () => {
    await expect(verifyDummy("anything")).resolves.toBeUndefined();
  });

  it("salts: hashing the same password twice yields different hashes", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "same")).toBe(true);
    expect(await verifyPassword(b, "same")).toBe(true);
  });
});
