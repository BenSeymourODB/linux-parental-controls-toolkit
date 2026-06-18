/**
 * Unit tests for the pure Ansible inventory generator.
 *
 * No subprocess, no filesystem — just the string the runner hands to
 * `ansible-playbook -i`. The injection-rejection cases matter most: a hostile
 * or corrupt `Client` row must never be able to inject extra inventory tokens.
 */
import { describe, expect, it } from "vitest";

import { AnsibleInventoryError } from "../../../src/transport/ansible/errors.js";
import {
  buildInventory,
  INVENTORY_GROUP,
  type AnsibleHost,
} from "../../../src/transport/ansible/inventory.js";

describe("buildInventory", () => {
  it("renders one INI line per host under the supervised group", () => {
    const hosts: AnsibleHost[] = [
      { hostname: "mint-01.lan", sshUser: "pct-agent" },
      { hostname: "192.168.1.50", sshUser: "pct-agent" },
    ];

    expect(buildInventory(hosts)).toBe(
      `[${INVENTORY_GROUP}]\n` +
        "mint-01.lan ansible_user=pct-agent\n" +
        "192.168.1.50 ansible_user=pct-agent\n",
    );
  });

  it("carries each host's own ssh user", () => {
    const inventory = buildInventory([{ hostname: "box", sshUser: "pct_agent" }]);
    expect(inventory).toContain("box ansible_user=pct_agent");
  });

  it("produces a valid empty group for zero hosts (a clean no-op run)", () => {
    expect(buildInventory([])).toBe(`[${INVENTORY_GROUP}]\n`);
  });

  it("always ends with a trailing newline", () => {
    expect(buildInventory([{ hostname: "a", sshUser: "pct-agent" }]).endsWith("\n")).toBe(true);
  });

  it.each([
    ["a space", "evil host"],
    ["a newline + injected entry", "host\n[all]\nrogue"],
    ["an equals sign", "host=ansible_user=root"],
    ["a leading hyphen", "-host"],
    ["an empty hostname", ""],
  ])("rejects a hostname with %s", (_label, hostname) => {
    expect(() => buildInventory([{ hostname, sshUser: "pct-agent" }])).toThrow(
      AnsibleInventoryError,
    );
  });

  it.each([
    ["a space", "pct agent"],
    ["a shell metacharacter", "pct;agent"],
    ["an uppercase start", "Agent"],
  ])("rejects an ssh user with %s", (_label, sshUser) => {
    expect(() => buildInventory([{ hostname: "box", sshUser }])).toThrow(AnsibleInventoryError);
  });
});
