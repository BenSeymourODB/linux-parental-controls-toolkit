/**
 * Tests for the server SSH-public-key reader used by the enrol response (#77).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadServerSshPublicKey } from "../../../src/api/clients/ssh-identity.js";

describe("loadServerSshPublicKey", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-ssh-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the trimmed key when the file is present", () => {
    const path = join(dir, "id_ed25519.pub");
    writeFileSync(path, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 dashboard@pct\n");
    expect(loadServerSshPublicKey(path)).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 dashboard@pct");
  });

  it("returns null when the file is absent (key not yet generated — Phase 4)", () => {
    expect(loadServerSshPublicKey(join(dir, "does-not-exist.pub"))).toBeNull();
  });

  it("returns null when the file is present but empty/whitespace", () => {
    const path = join(dir, "empty.pub");
    writeFileSync(path, "   \n");
    expect(loadServerSshPublicKey(path)).toBeNull();
  });

  it("rethrows an unexpected read error that isn't 'file absent'", () => {
    // Reading a directory throws EISDIR — a real misconfiguration, not the
    // expected "key not generated yet" ENOENT, so it must surface.
    expect(() => loadServerSshPublicKey(dir)).toThrow();
  });
});
