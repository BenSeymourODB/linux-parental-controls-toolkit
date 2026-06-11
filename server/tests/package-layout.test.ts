/**
 * Smoke test: every scaffolded module resolves and identifies itself.
 *
 * This is the only test the scaffold ships with; it exists so the
 * coverage gate has something to bite on while the real modules are
 * still empty. As real code lands per phase, this file can shrink.
 */
import { describe, expect, it } from "vitest";

const modules = [
  ["../src/index.js", "dashboard"],
  ["../src/web/index.js", "web"],
  ["../src/api/index.js", "api"],
  ["../src/policy/index.js", "policy"],
  ["../src/events/index.js", "events"],
  ["../src/integrations/index.js", "integrations"],
  ["../src/transport/index.js", "transport"],
  ["../src/transport/ssh/index.js", "transport/ssh"],
  ["../src/transport/ansible/index.js", "transport/ansible"],
  ["../src/transport/activitywatch/index.js", "transport/activitywatch"],
  ["../src/transport/adguard/index.js", "transport/adguard"],
] as const;

describe("package layout", () => {
  it.each(modules)("%s is importable", async (path, expectedName) => {
    const mod: Record<string, unknown> = await import(path);
    expect(mod.moduleName ?? mod.packageName).toBe(expectedName);
  });
});
