/**
 * Regression guard for the child → root symlink-following privilege escalation
 * in `client/ansible/playbooks/activitywatch.yml` (#351).
 *
 * The per-user reconciliation block writes directories and templates INTO each
 * supervised (untrusted, child) user's home. `ansible.builtin.file`'s `follow`
 * defaults to `yes`, so a leaf symlink planted by the child (e.g.
 * `~/.config/systemd/user` → `/etc`) would have its TARGET chowned by the
 * root-run re-apply — a concrete privilege escalation.
 *
 * The fix pins two defences on every home-writing task:
 *   - `become_user: "{{ item }}"` (or `"{{ item.0 }}"`) — the write runs as the
 *     child, so a hostile symlink can only reach files they already own.
 *   - `follow: false` — neutralises the `follow: yes` default (the root cause).
 *
 * This static guard parses the playbook and asserts both defences are present
 * on every task that writes into a user home, so the vector cannot silently
 * reopen. The live symlink-planting assertion belongs to the Molecule harness
 * (#242). Mirrors the static-analysis approach of `dockerfile-playbooks.test.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const playbookPath = fileURLToPath(
  new URL("../../../client/ansible/playbooks/activitywatch.yml", import.meta.url),
);

// Validate the slice of the playbook schema this test asserts on, rather than
// casting `parse()`'s `unknown` output — keeps the repo's "validate external
// input with zod / no unchecked `as`" convention (CLAUDE.md → "Code conventions").
const moduleParamsSchema = z
  .object({
    path: z.string().optional(),
    dest: z.string().optional(),
    state: z.string().optional(),
    follow: z.boolean().optional(),
  })
  .passthrough();

// Fields spell out `| undefined` so this matches the shape zod's `.optional()`
// produces under `exactOptionalPropertyTypes` (a present-but-undefined property,
// not just an absent one), letting the recursive `z.lazy` annotation line up.
interface PlaybookTask {
  name?: string | undefined;
  block?: PlaybookTask[] | undefined;
  become_user?: string | undefined;
  "ansible.builtin.file"?: z.infer<typeof moduleParamsSchema> | undefined;
  "ansible.builtin.template"?: z.infer<typeof moduleParamsSchema> | undefined;
}

const taskSchema: z.ZodType<PlaybookTask> = z.lazy(() =>
  z
    .object({
      name: z.string().optional(),
      block: z.array(taskSchema).optional(),
      become_user: z.string().optional(),
      "ansible.builtin.file": moduleParamsSchema.optional(),
      "ansible.builtin.template": moduleParamsSchema.optional(),
    })
    .passthrough(),
);

const playSchema = z
  .object({
    name: z.string().optional(),
    tasks: z.array(taskSchema).optional(),
  })
  .passthrough();

const playbookSchema = z.array(playSchema);

function loadPlaybook(): z.infer<typeof playbookSchema> {
  return playbookSchema.parse(parse(readFileSync(playbookPath, "utf8")));
}

/** Flatten a play's task list, descending into `block:` groups. */
function flattenTasks(tasks: PlaybookTask[]): PlaybookTask[] {
  return tasks.flatMap((task) => [task, ...(task.block ? flattenTasks(task.block) : [])]);
}

/** The `file`/`template` module params on a task, whichever is present. */
function fileOrTemplateParams(task: PlaybookTask): z.infer<typeof moduleParamsSchema> | undefined {
  return task["ansible.builtin.file"] ?? task["ansible.builtin.template"];
}

/**
 * A task writes into a supervised user's home iff its `file`/`template` target
 * is derived from `getent_passwd[...]` — the child's real, writable home dir.
 */
function writesIntoUserHome(task: PlaybookTask): boolean {
  const params = fileOrTemplateParams(task);
  if (params === undefined) return false;
  const target = params.path ?? params.dest ?? "";
  return target.includes("getent_passwd");
}

describe("activitywatch.yml — child→root symlink privesc guard (#351)", () => {
  const allTasks = loadPlaybook().flatMap((play) => flattenTasks(play.tasks ?? []));
  const homeWritingTasks = allTasks.filter(writesIntoUserHome);

  it("still contains the per-user home-writing tasks this guard protects", () => {
    // If these tasks are renamed/removed the guard must not silently pass over
    // nothing. The block writes two directories + two templates per user.
    expect(homeWritingTasks.length).toBe(4);
  });

  it("runs every home-write as the target user (become_user), never as root", () => {
    for (const task of homeWritingTasks) {
      expect(
        task.become_user,
        `task "${task.name ?? "<unnamed>"}" writes into a user home but is missing become_user`,
      ).toBeDefined();
      // The loop var is the username: `{{ item }}` for the plain loops, or
      // `{{ item.0 }}` for the product() loop. Either localises the write to
      // the child, so a hostile symlink can only reach files they own.
      expect(task.become_user).toMatch(/^\{\{\s*item(\.0)?\s*\}\}$/);
    }
  });

  it("pins follow: false on every home-write (neutralises the follow: yes default)", () => {
    for (const task of homeWritingTasks) {
      const params = fileOrTemplateParams(task);
      expect(
        params?.follow,
        `task "${task.name ?? "<unnamed>"}" writes into a user home but does not pin follow: false`,
      ).toBe(false);
    }
  });
});
