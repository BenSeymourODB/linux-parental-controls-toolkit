/**
 * Static guard for the LIVE symlink-planting privesc assertion (#360) in the
 * `client/ansible/molecule/default` scenario.
 *
 * #351 fixed a child→root symlink-following privilege escalation in
 * `activitywatch.yml`; `activitywatch-privesc.test.ts` statically proves the
 * `become_user` + `follow: false` defences are present on the playbook's
 * home-writing tasks. #360 adds a *live* Molecule assertion: `prepare.yml`
 * plants hostile leaf symlinks (`config.toml`, `aw-server.service`) pointing at
 * a root-owned canary, and `verify.yml` asserts the converge did not follow
 * them (the canary stays root-owned and unmodified; the child's dests are real
 * child-owned files).
 *
 * Molecule itself only runs in the `client/ansible/**`-gated integration job,
 * not the fast `npm test` gate. This guard runs in the fast gate and asserts
 * the scenario keeps the canary planting + the root-ownership / content-
 * unchanged assertions, so the live check cannot silently regress (e.g. a
 * refactor that drops the symlink planting would make the live test pass
 * vacuously). Mirrors the static-analysis approach of
 * `activitywatch-privesc.test.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const scenarioDir = new URL("../../../client/ansible/molecule/default/", import.meta.url);
const preparePath = fileURLToPath(new URL("prepare.yml", scenarioDir));
const verifyPath = fileURLToPath(new URL("verify.yml", scenarioDir));

// The canary path + markers the scenario pins; kept in one place so the guard
// tracks the same literals prepare.yml/verify.yml use.
const CANARY_DIR = "/opt/pct-privesc-canary";
const CONFIG_MARKER = "PCT-PRIVESC-CANARY-CONFIG-DO-NOT-OVERWRITE";
const UNIT_MARKER = "PCT-PRIVESC-CANARY-UNIT-DO-NOT-OVERWRITE";

// A permissive task shape: Ansible module invocations are arbitrary keys
// (`ansible.builtin.file`, …), and tasks nest under block/rescue/always. We
// validate the slice we read rather than casting `parse()`'s `unknown`, keeping
// the repo's "validate external input with zod / no unchecked `as`" convention.
interface PlaybookTask {
  name?: string | undefined;
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

const moduleParamsSchema = z.record(z.string(), z.unknown());

/** The params of a given `ansible.builtin.<module>` on a task, if present. */
function moduleParams(task: PlaybookTask, module: string): Record<string, unknown> | undefined {
  const parsed = moduleParamsSchema.safeParse(task[`ansible.builtin.${module}`]);
  return parsed.success ? parsed.data : undefined;
}

/** The full serialised text of a task's module params (for substring probes). */
function taskText(task: PlaybookTask): string {
  return JSON.stringify(task);
}

describe("molecule default scenario — live symlink privesc assertion (#360)", () => {
  const prepareTasks = loadTasks(preparePath);
  const verifyTasks = loadTasks(verifyPath);

  it("plants hostile leaf symlinks into the child home as the child user", () => {
    const linkTasks = prepareTasks.filter((task) => {
      const file = moduleParams(task, "file");
      return file?.state === "link";
    });

    // Two dests are poisoned: the aw-server config.toml and an aw-server unit.
    expect(linkTasks.length).toBeGreaterThanOrEqual(1);

    for (const task of linkTasks) {
      // The write must run AS the child (never root) — a hostile symlink can
      // then only reach files the child already owns.
      expect(
        task.become_user,
        `symlink-planting task "${task.name ?? "<unnamed>"}" must run as the child (become_user)`,
      ).toBeDefined();
      // …and point at the root-owned canary, so a followed write would be a
      // real child→root escalation the fix must prevent. The task references
      // the canary via the `canary_dir` play var.
      expect(taskText(task)).toContain("canary_dir");
    }

    // Both concrete dests the converge templates into are covered, and the
    // canary path/markers are pinned (in the play `vars` block → raw text).
    expect(prepareRaw).toContain("config.toml");
    expect(prepareRaw).toContain("aw-server.service");
    expect(prepareRaw).toContain(CANARY_DIR);
  });

  it("creates the canary as root-owned, mode 0600, with the pinned markers", () => {
    const canaryCopy = prepareTasks.find((task) => {
      const copy = moduleParams(task, "copy");
      return copy !== undefined && taskText(task).includes("canary");
    });
    expect(canaryCopy, "prepare.yml must write the root-owned canary sentinel files").toBeDefined();
    const copy = moduleParams(canaryCopy ?? {}, "copy");
    expect(copy?.owner).toBe("root");
    expect(copy?.group).toBe("root");
    expect(copy?.mode).toBe("0600");

    // The marker literals live in the play `vars` block.
    expect(prepareRaw).toContain(CONFIG_MARKER);
    expect(prepareRaw).toContain(UNIT_MARKER);
    expect(verifyRaw).toContain(CONFIG_MARKER);
    expect(verifyRaw).toContain(UNIT_MARKER);
  });

  it("asserts in verify.yml that the canary stayed root-owned", () => {
    const rootAssert = verifyTasks.find((task) => {
      const assertParams = moduleParams(task, "assert");
      const that = assertParams?.that;
      return Array.isArray(that) && that.some((line) => String(line).includes("uid == 0"));
    });
    expect(
      rootAssert,
      "verify.yml must assert the canary files are still uid 0 (root-owned)",
    ).toBeDefined();
  });

  it("asserts in verify.yml that the canary content was not overwritten", () => {
    // A slurp of the canary + an assert that decodes and compares its content.
    const slurpsCanary = verifyTasks.some((task) => {
      const slurp = moduleParams(task, "slurp");
      return slurp !== undefined && String(slurp.src).includes("canary_dir");
    });
    expect(slurpsCanary, "verify.yml must read the canary content back").toBe(true);

    const contentAssert = verifyTasks.find((task) => {
      const assertParams = moduleParams(task, "assert");
      const that = assertParams?.that;
      return Array.isArray(that) && that.some((line) => String(line).includes("b64decode"));
    });
    expect(
      contentAssert,
      "verify.yml must assert the decoded canary content equals the pinned marker",
    ).toBeDefined();
  });

  it("asserts in verify.yml that the child dests are real child-owned files", () => {
    const notLinkAssert = verifyTasks.find((task) => {
      const assertParams = moduleParams(task, "assert");
      const that = assertParams?.that;
      return (
        Array.isArray(that) &&
        that.some((line) => String(line).includes("isreg")) &&
        that.some((line) => String(line).includes("islnk"))
      );
    });
    expect(
      notLinkAssert,
      "verify.yml must assert the poisoned dests are regular files, not symlinks",
    ).toBeDefined();
  });
});
