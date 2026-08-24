/**
 * Static guard for the LIVE privesc assertion (#360) in the
 * `client/ansible/molecule/default` scenario.
 *
 * #351 fixed a child→root symlink-following privilege escalation in the
 * `ansible.builtin.file` `state: directory` tasks of `activitywatch.yml`
 * (`file.follow` defaults to TRUE, so a root-run directory task follows a
 * child-planted symlink and chowns its root-owned target to the child).
 * `activitywatch-privesc.test.ts` statically proves the `become_user` +
 * `follow: false` defences are present on the playbook's home-writing tasks.
 * #360 adds a *live* Molecule assertion that reproduces that exact directory-
 * task technique at converge time against isolated probe symlinks: a positive
 * control (root + `follow: true`) that must escalate into a root-owned canary,
 * and the fixed shape (`become_user` + `follow: false`) that must leave the
 * canary root-owned.
 *
 * Molecule itself only runs in the `client/ansible/**`-gated integration job,
 * not the fast `npm test` gate. This guard runs in the fast gate and asserts
 * the scenario keeps the probe planting + BOTH the positive control and the
 * fixed-shape ownership assertions, so the live check cannot silently regress
 * into something vacuous (e.g. dropping the positive control would let the
 * fixed-shape assertion pass without proving the vector is even reproducible).
 * Mirrors the static-analysis approach of `activitywatch-privesc.test.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const scenarioDir = new URL("../../../client/ansible/molecule/default/", import.meta.url);
const preparePath = fileURLToPath(new URL("prepare.yml", scenarioDir));
const verifyPath = fileURLToPath(new URL("verify.yml", scenarioDir));

// The canary path + marker the scenario pins; kept in one place so the guard
// tracks the same literals prepare.yml/verify.yml use.
const CANARY_DIR = "/opt/pct-privesc-canary";
const FIXED_MARKER = "PCT-PRIVESC-FIXED-CANARY-STILL-ROOT-OWNED";

// A permissive task shape: Ansible module invocations are arbitrary keys
// (`ansible.builtin.file`, …), and tasks nest under block/rescue/always. We
// validate the slice we read rather than casting `parse()`'s `unknown`, keeping
// the repo's "validate external input with zod / no unchecked `as`" convention.
interface PlaybookTask {
  name?: string | undefined;
  become?: boolean | undefined;
  become_user?: string | undefined;
  block?: PlaybookTask[] | undefined;
  rescue?: PlaybookTask[] | undefined;
  always?: PlaybookTask[] | undefined;
  [key: string]: unknown;
}

const taskSchema: z.ZodType<PlaybookTask> = z.lazy(() =>
  z
    .object({
      name: z.string().optional(),
      become: z.boolean().optional(),
      become_user: z.string().optional(),
      block: z.array(taskSchema).optional(),
      rescue: z.array(taskSchema).optional(),
      always: z.array(taskSchema).optional(),
    })
    .passthrough(),
);

const playSchema = z
  .object({
    tasks: z.array(taskSchema).optional(),
  })
  .passthrough();

const playbookSchema = z.array(playSchema);

const moduleParamsSchema = z.record(z.string(), z.unknown());

function loadTasks(path: string): PlaybookTask[] {
  const plays = playbookSchema.parse(parse(readFileSync(path, "utf8")));
  return plays.flatMap((play) => flattenTasks(play.tasks ?? []));
}

const prepareRaw = readFileSync(preparePath, "utf8");
const verifyRaw = readFileSync(verifyPath, "utf8");

/** Flatten a task list, descending into block/rescue/always groups. */
function flattenTasks(tasks: PlaybookTask[]): PlaybookTask[] {
  return tasks.flatMap((task) => [
    task,
    ...flattenTasks([...(task.block ?? []), ...(task.rescue ?? []), ...(task.always ?? [])]),
  ]);
}

/** The params of a given `ansible.builtin.<module>` on a task, if present. */
function moduleParams(task: PlaybookTask, module: string): Record<string, unknown> | undefined {
  const parsed = moduleParamsSchema.safeParse(task[`ansible.builtin.${module}`]);
  return parsed.success ? parsed.data : undefined;
}

/** The `that:` conditions of an `assert` task, as strings (empty if none). */
function assertConditions(task: PlaybookTask): string[] {
  const that = moduleParams(task, "assert")?.that;
  return Array.isArray(that) ? that.map((line) => String(line)) : [];
}

describe("molecule default scenario — live privesc assertion (#360)", () => {
  const prepareTasks = loadTasks(preparePath);
  const verifyTasks = loadTasks(verifyPath);

  it("plants child-owned probe symlinks into the root-owned canary, as the child", () => {
    const linkTasks = prepareTasks.filter((task) => moduleParams(task, "file")?.state === "link");
    expect(linkTasks.length).toBeGreaterThanOrEqual(1);

    for (const task of linkTasks) {
      // The symlinks must be planted AS the child (an unprivileged user can
      // only create links they own) — mirrors the real attacker.
      expect(
        task.become_user,
        `symlink-planting task "${task.name ?? "<unnamed>"}" must run as the child (become_user)`,
      ).toBeDefined();
      // …and point into the root-owned canary (referenced via `canary_dir`).
      expect(JSON.stringify(task)).toContain("canary_dir");
    }

    // Both probe links + the canary path/marker are pinned (vars → raw text).
    expect(prepareRaw).toContain("fixed-link");
    expect(prepareRaw).toContain("vuln-link");
    expect(prepareRaw).toContain(CANARY_DIR);
    expect(prepareRaw).toContain(FIXED_MARKER);
  });

  it("creates the canary targets as root-owned directories", () => {
    const canaryDir = prepareTasks.find((task) => {
      const file = moduleParams(task, "file");
      return file?.state === "directory" && JSON.stringify(task).includes("canary_dir");
    });
    expect(canaryDir, "prepare.yml must create the root-owned canary targets").toBeDefined();
    const file = moduleParams(canaryDir ?? {}, "file");
    expect(file?.owner).toBe("root");
    expect(file?.group).toBe("root");
  });

  it("runs a VULNERABLE positive control (root + follow: true) that must escalate", () => {
    const controlTask = verifyTasks.find((task) => {
      const file = moduleParams(task, "file");
      return (
        file?.state === "directory" &&
        file.follow === true &&
        JSON.stringify(task).includes("vuln-link")
      );
    });
    expect(
      controlTask,
      "verify.yml must run the vulnerable directory-task shape (follow: true) as the positive control",
    ).toBeDefined();
    // The control must NOT drop to the child — it reproduces the root-run vuln.
    expect(controlTask?.become_user).toBeUndefined();

    // …and it must assert the escalation actually happened (vuln-target now
    // owned by the child), otherwise the whole assertion proves nothing.
    const controlAssert = verifyTasks.find((task) =>
      assertConditions(task).some((line) => line.includes("vuln_target.stat.pw_name")),
    );
    expect(
      controlAssert,
      "verify.yml must assert the positive control escalated (vuln-target owned by the child)",
    ).toBeDefined();
    expect(assertConditions(controlAssert ?? {}).join("\n")).toContain("poisoned_user");
  });

  it("runs the FIXED shape (become_user + follow: false) and asserts the target stays root", () => {
    const fixedTask = verifyTasks.find((task) => {
      const file = moduleParams(task, "file");
      return (
        file?.state === "directory" &&
        file.follow === false &&
        JSON.stringify(task).includes("fixed-link")
      );
    });
    expect(fixedTask, "verify.yml must run the fixed directory-task shape").toBeDefined();
    expect(
      fixedTask?.become_user,
      "the fixed shape must drop to the child (become_user), matching the #351 fix",
    ).toBeDefined();

    const fixedAssert = verifyTasks.find((task) => {
      const conds = assertConditions(task);
      return (
        conds.some((line) => line.includes("fixed_target.stat.uid == 0")) &&
        conds.some((line) => line.includes("fixed_target.stat.gid == 0"))
      );
    });
    expect(
      fixedAssert,
      "verify.yml must assert the fixed-target canary stays root-owned (uid/gid 0)",
    ).toBeDefined();
    // The content-unchanged belt-and-suspenders check is present too.
    expect(verifyRaw).toContain("fixed_canary_marker");
  });
});
