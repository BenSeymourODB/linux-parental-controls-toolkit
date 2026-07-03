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
import { z } from "zod";

const PLAYBOOKS = fileURLToPath(new URL("../../../../client/ansible/playbooks/", import.meta.url));

function readAsset(relativePath: string): string {
  return readFileSync(join(PLAYBOOKS, relativePath), "utf8");
}

/**
 * Just enough of the playbook shape to guard the windowed-list wiring — parsed
 * with zod rather than an `as` cast, matching the repo's "validate external
 * input" idiom (the on-disk YAML is external to the type program).
 */
const taskSchema = z
  .object({
    name: z.string().optional(),
    loop: z.string().optional(),
    notify: z.union([z.string(), z.array(z.string())]).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    "ansible.builtin.template": z
      .object({ src: z.string().optional(), dest: z.string().optional() })
      .optional(),
  })
  .passthrough();
type PlaybookTask = z.infer<typeof taskSchema>;

const playbookSchema = z.array(
  z.object({ vars: z.record(z.string(), z.unknown()).optional(), tasks: z.array(taskSchema) }),
);

function loadPlaybook(): { vars: Record<string, unknown>; tasks: PlaybookTask[] } {
  const plays = playbookSchema.parse(parse(readAsset("e2guardian-filtering.yml")));
  const play = plays[0];
  expect(play).toBeDefined();
  return { vars: play?.vars ?? {}, tasks: play?.tasks ?? [] };
}

describe("e2guardian-filtering.yml — windowed banned-site rendering (#216)", () => {
  const { vars, tasks } = loadPlaybook();
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

  it("writes the list into the same managed dir the filter group includes from", () => {
    // The playbook dest uses `pct_e2g_managed_dir`; the filter-group template
    // hardcodes the same path in its `.Include`. Lock the coupling so moving one
    // without the other (which would make every windowed `.Include` dangle) is
    // caught here rather than only at live convergence (#215).
    const managedDir = vars.pct_e2g_managed_dir;
    expect(managedDir).toBe("/etc/e2guardian/pct.d");
    const dest = windowedTask?.["ansible.builtin.template"]?.dest ?? "";
    expect(dest).toContain("{{ pct_e2g_managed_dir }}/");
    expect(readAsset("templates/pct-filtergroup.conf.j2")).toContain(`${String(managedDir)}/`);
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
