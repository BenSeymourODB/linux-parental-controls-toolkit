/**
 * Unit tests for the SSH credential loader (#201): reading the dashboard's
 * private key from the data volume, the "absent ⇒ null" degrade (pre-#39
 * keygen), and surfacing genuine read errors.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSshCredentials } from "../../../src/transport/ssh/credentials.js";

describe("loadSshCredentials", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-ssh-creds-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the private key when the file is present", () => {
    const path = join(dir, "id_ed25519");
    writeFileSync(path, "PRIVATE-KEY-CONTENTS\n");
    expect(loadSshCredentials(path)).toEqual({ privateKey: "PRIVATE-KEY-CONTENTS\n" });
  });

  it("returns null when the key file does not exist (pre-keygen)", () => {
    expect(loadSshCredentials(join(dir, "absent"))).toBeNull();
  });

  it("returns null when the key file is empty/whitespace", () => {
    const path = join(dir, "empty");
    writeFileSync(path, "   \n");
    expect(loadSshCredentials(path)).toBeNull();
  });

  it("rethrows a non-ENOENT read error (e.g. a directory in the key's place)", () => {
    // Pointing at the directory itself yields EISDIR, not ENOENT — a real
    // misconfiguration the operator must see, not a silent skip.
    expect(() => loadSshCredentials(dir)).toThrow();
  });
});
