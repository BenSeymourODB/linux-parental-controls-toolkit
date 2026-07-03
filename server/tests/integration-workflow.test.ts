/**
 * Guards the `molecule` job in `.github/workflows/integration.yml` (#219).
 *
 * The Molecule scenario is converged by a Docker daemon that the
 * scheduled-run sandbox does not provide, so this test cannot run
 * `molecule test` — the CI job itself does that on the PR. What it *can*
 * guard here is the harness's shape, which is the part that silently rots:
 * that the job exists, installs Molecule via pip (never the dashboard's npm
 * dependency tree, per docs/testing.md), actually runs `molecule test`, and
 * PR-gates the expensive converge on `client/ansible/` changes. It also
 * pins that the pre-existing integration jobs weren't disturbed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/integration.yml", import.meta.url),
);
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

// Validate the slice of the Actions workflow schema this test asserts on,
// rather than casting `parse()`'s `unknown` output — keeps the repo's
// "validate external input with zod / no unchecked `as`" convention.
const stepSchema = z.object({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  "working-directory": z.string().optional(),
});
const jobSchema = z.object({
  "runs-on": z.string(),
  steps: z.array(stepSchema),
});
const workflowSchema = z.object({
  jobs: z.record(z.string(), jobSchema),
});
type WorkflowStep = z.infer<typeof stepSchema>;

function loadWorkflow(): z.infer<typeof workflowSchema> {
  return workflowSchema.parse(parse(readFileSync(workflowPath, "utf8")));
}

function moleculeJob(): z.infer<typeof jobSchema> {
  const job = loadWorkflow().jobs.molecule;
  if (job === undefined) {
    throw new Error("integration.yml is missing the `molecule` job");
  }
  return job;
}

/** The step that pip-installs Molecule, found by its `run` body. */
function installStep(): WorkflowStep {
  const step = moleculeJob().steps.find((s) => (s.run ?? "").includes("pip install molecule"));
  if (step === undefined) {
    throw new Error("molecule job has no `pip install molecule` step");
  }
  return step;
}

/** The step that runs the Molecule test sequence. */
function testStep(): WorkflowStep {
  const step = moleculeJob().steps.find((s) => (s.run ?? "").includes("molecule test"));
  if (step === undefined) {
    throw new Error("molecule job has no `molecule test` step");
  }
  return step;
}

describe("integration.yml — Molecule job (#219)", () => {
  it("parses as valid YAML", () => {
    expect(() => loadWorkflow()).not.toThrow();
  });

  it("appends the molecule job without disturbing the existing integration jobs", () => {
    const jobs = Object.keys(loadWorkflow().jobs);
    // Regression guard: the change is append-only.
    expect(jobs).toEqual(
      expect.arrayContaining([
        "activitywatch",
        "adguard",
        "ssh-transport",
        "migrations",
        "client-install-dryrun",
        "molecule",
      ]),
    );
  });

  it("runs on a cgroup-v2 GitHub-hosted runner (systemd-in-Docker needs it)", () => {
    expect(moleculeJob()["runs-on"]).toBe("ubuntu-22.04");
  });

  it("installs Molecule + the Docker driver via pip, not the dashboard npm tree", () => {
    const run = installStep().run ?? "";
    expect(run).toContain("pip install");
    expect(run).toContain("molecule-plugins[docker]");
    expect(run).toContain("ansible-core");
    // The install must not leak into the Node dependency tree.
    expect(run).not.toContain("npm");
  });

  it("keeps Molecule out of the dashboard dependency tree", () => {
    const pkg = z
      .object({
        dependencies: z.record(z.string(), z.string()).optional(),
        devDependencies: z.record(z.string(), z.string()).optional(),
      })
      .parse(JSON.parse(readFileSync(packageJsonPath, "utf8")));
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(names.filter((n) => n.includes("molecule"))).toEqual([]);
  });

  it("runs `molecule test` for every scenario, from client/ansible", () => {
    const step = testStep();
    expect(step.run).toContain("molecule test --all");
    expect(step["working-directory"]).toBe("client/ansible");
  });

  it("PR-gates the expensive converge on client/ansible changes", () => {
    const decide = moleculeJob().steps.find((s) => s.name === "Decide whether to converge");
    expect(decide, "molecule job has no `Decide whether to converge` step").toBeDefined();
    const run = decide?.run ?? "";
    // The gate keys on the event being a PR and on client/ansible/ diffs.
    expect(run).toContain("pull_request");
    expect(run).toContain("client/ansible/");
    expect(run).toContain("github.base_ref");
  });

  it("guards the converge steps behind the decide gate", () => {
    // setup-python, install and test must all be skipped when run != true, so
    // a PR that doesn't touch client/ansible/ pays no converge cost.
    for (const step of [installStep(), testStep()]) {
      expect(step.if).toBe("steps.decide.outputs.run == 'true'");
    }
  });
});
