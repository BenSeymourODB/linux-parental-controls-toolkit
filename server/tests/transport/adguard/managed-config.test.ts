/**
 * Tests for the managed-mode seed `AdGuardHome.yaml` (#96): rendering and the
 * no-clobber write. Filesystem seams are injected.
 */
import { describe, expect, it } from "vitest";

import {
  renderSeedConfig,
  writeSeedConfigIfAbsent,
} from "../../../src/transport/adguard/managed-config.js";

describe("renderSeedConfig", () => {
  it("binds the web UI to localhost and DNS to the bind address", () => {
    const yaml = renderSeedConfig({ adminPort: 3000, bindAddr: "0.0.0.0:53" });
    expect(yaml).toContain("address: 127.0.0.1:3000");
    expect(yaml).toContain("- 0.0.0.0");
    expect(yaml).toContain("port: 53");
    expect(yaml).toContain("users: []");
  });

  it("splits a host:port bind address on the final colon", () => {
    const yaml = renderSeedConfig({ adminPort: 8080, bindAddr: "192.168.1.2:5353" });
    expect(yaml).toContain("- 192.168.1.2");
    expect(yaml).toContain("port: 5353");
  });

  it("defaults the DNS port to 53 when the bind address has no port", () => {
    const yaml = renderSeedConfig({ adminPort: 3000, bindAddr: "0.0.0.0" });
    expect(yaml).toContain("port: 53");
  });
});

describe("writeSeedConfigIfAbsent", () => {
  it("writes the seed config when absent", () => {
    const writes: { path: string; contents: string }[] = [];
    const written = writeSeedConfigIfAbsent(
      "/data/adguard/conf/AdGuardHome.yaml",
      { adminPort: 3000, bindAddr: "0.0.0.0:53" },
      {
        fileExists: () => false,
        makeDir: () => undefined,
        writeFile: (path, contents) => void writes.push({ path, contents }),
      },
    );
    expect(written).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/data/adguard/conf/AdGuardHome.yaml");
  });

  it("does not clobber an existing config", () => {
    const writes: string[] = [];
    const written = writeSeedConfigIfAbsent(
      "/data/adguard/conf/AdGuardHome.yaml",
      { adminPort: 3000, bindAddr: "0.0.0.0:53" },
      { fileExists: () => true, makeDir: () => undefined, writeFile: (p) => void writes.push(p) },
    );
    expect(written).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
