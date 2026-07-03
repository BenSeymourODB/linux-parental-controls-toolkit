/**
 * Structure guards for the e2guardian playbook + templates that render the
 * recurring time-window denies (#216). These parse the shipped Ansible/Jinja
 * assets — no `ansible-playbook` is run (live convergence is the Molecule
 * follow-up #215) — so the server-side plan contract and the client-side
 * rendering can't silently drift: the windowed-list task, its `subelements`
 * loop, and the time-tag slug must stay consistent with the filter group's
 * `#time:` `.Include`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const PLAYBOOKS = fileURLToPath(new URL("../../../../client/ansible/playbooks/", import.meta.url));

function readAsset(relativePath: string): string {
  return readFileSync(join(PLAYBOOKS, relativePath), "utf8");
}

interface PlaybookTask {
  name?: string;
  loop?: string;
  notify?: string | string[];
  "ansible.builtin.template"?: { dest?: string; src?: string };
}

function loadTasks(): PlaybookTask[] {
  const doc: unknown = parse(readAsset("e2guardian-filtering.yml"));
  expect(Array.isArray(doc)).toBe(true);
  const plays = doc as { tasks?: PlaybookTask[] }[];
  const tasks = plays[0]?.tasks;
  expect(Array.isArray(tasks)).toBe(true);
  return tasks ?? [];
}

describe("e2guardian-filtering.yml — windowed banned-site rendering (#216)", () => {
  const tasks = loadTasks();
  const windowedTask = tasks.find((task) => task.name?.includes("windowed banned-site"));

  it("has a task that renders per-(user, window) banned-site lists", () => {
    expect(windowedTask).toBeDefined();
    expect(windowedTask?.["ansible.builtin.template"]?.src).toContain(
      "pct-windowed-bannedsites.j2",
    );
  });

  it("iterates windows via subelements(..., skip_missing) so window-less users are skipped", () => {
    expect(windowedTask?.loop).toContain("subelements('windows', skip_missing=true)");
    expect(windowedTask?.loop).toContain("e2guardian.users");
  });

  it("names the list file by the same time-tag slug the filter group includes", () => {
    const dest = windowedTask?.["ansible.builtin.template"]?.dest ?? "";
    expect(dest).toContain("-win-");
    expect(dest).toContain("item.1.timeTag");
    expect(dest).toContain("replace(' ', '-')");
  });

  it("reloads e2guardian after writing a windowed list", () => {
    expect(windowedTask?.notify).toBe("Reload e2guardian");
  });
});

describe("pct-filtergroup.conf.j2 — time-tagged includes (#216)", () => {
  const template = readAsset("templates/pct-filtergroup.conf.j2");

  it("includes each window list with a matching -win- slug", () => {
    expect(template).toContain("item.windows");
    expect(template).toContain('"-win-"');
    expect(template).toContain('replace(" ", "-")');
  });

  it("applies the window via a trailing #time: tag on the include", () => {
    expect(template).toMatch(/\.Include<[^>]+>#time: \{\{ window\.timeTag \}\}/);
  });
});

describe("pct-windowed-bannedsites.j2 — window domain list (#216)", () => {
  const template = readAsset("templates/pct-windowed-bannedsites.j2");

  it("renders the window's sites, one per line", () => {
    expect(template).toContain("item.1.sites");
    expect(template).toContain("{{ site }}");
  });
});
