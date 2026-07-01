/**
 * Guards that the Phase-6 Ansible playbooks are packaged into the dashboard
 * image (#260).
 *
 * The first-run bootstrap (#259) syncs playbooks from an in-image read-only
 * source (`PCT_ANSIBLE_PLAYBOOK_SRC`, default `/app/ansible/playbooks`) into
 * the `/data` venv. That sync is a no-op unless the image actually ships the
 * playbooks. The image can't be built in unit tests, so these invariants
 * stand in for the build:
 *
 * - the `server/Dockerfile` `COPY`s `client/ansible/playbooks` to the exact
 *   path the runtime config defaults to (coupling packaging ↔ runtime),
 * - the playbook source dir ships the expected playbooks (the `COPY` source
 *   can't silently empty out),
 * - every non-stage `COPY` source resolves against the **repo root** build
 *   context (catches a context/path regression — the build context moved from
 *   `server/` to the repo root so the playbooks, which live outside `server/`,
 *   are reachable),
 * - the build sites (CI `docker-build`, nightly `license-guard`, `release`)
 *   build with the repo-root context and `-f server/Dockerfile`, so no single
 *   site can revert and silently drop the playbooks.
 *
 * The image-level "playbooks present" assertion runs per-PR in the CI
 * `docker-build` job (`docker run … test -f …/playbooks/activitywatch.yml`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";

const repoRoot = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const dockerfile = readFileSync(repoRoot("server/Dockerfile"), "utf8");

/** Playbooks the source dir is expected to ship (their absence breaks the COPY). */
const EXPECTED_PLAYBOOKS = [
  "activitywatch.yml",
  "apparmor-profiles.yml",
  "e2guardian-filtering.yml",
] as const;

/**
 * Parse `COPY <src...> <dest>` instructions, skipping `COPY --from=<stage>`
 * (those copy from a build stage, not the build context). Returns
 * `{ srcs, dest }` per instruction. Assumes single-line COPY instructions
 * (no backslash continuations) — true of server/Dockerfile today; revisit
 * this parser if a multi-line COPY is ever added.
 */
function copyInstructions(): { srcs: string[]; dest: string }[] {
  return dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("COPY ") && !line.includes("--from="))
    .map((line) => {
      const parts = line.slice("COPY ".length).trim().split(/\s+/);
      const dest = parts.at(-1) ?? "";
      return { srcs: parts.slice(0, -1), dest };
    });
}

describe("Phase-6 playbooks packaged into the image (#260)", () => {
  it("ships the expected playbooks at the COPY source dir", () => {
    const src = repoRoot("client/ansible/playbooks");
    expect(existsSync(src)).toBe(true);
    for (const pb of EXPECTED_PLAYBOOKS) {
      expect(existsSync(`${src}/${pb}`)).toBe(true);
    }
  });

  it("COPYs the playbooks to the path the runtime config defaults to", () => {
    const dest = loadSettings({}).ansiblePlaybookSourceDir;
    expect(dest).toBe("/app/ansible/playbooks");
    const copy = copyInstructions().find((c) => c.srcs.includes("client/ansible/playbooks"));
    expect(copy, "Dockerfile must COPY client/ansible/playbooks into the image").toBeDefined();
    expect(copy?.dest).toBe(dest);
  });

  it("resolves every build-context COPY source against the repo root", () => {
    // The build context is the repo root (-f server/Dockerfile), so sources are
    // repo-relative (e.g. `server/src`, `client/ansible/playbooks`). A leftover
    // `server/`-relative path (e.g. `src`) would not exist here and would break
    // the build — this catches that before CI does.
    for (const { srcs } of copyInstructions()) {
      for (const src of srcs) {
        expect(existsSync(repoRoot(src)), `COPY source not found at repo root: ${src}`).toBe(true);
      }
    }
  });

  it("builds every image site from the repo root with -f server/Dockerfile", () => {
    // Every site that builds the image — a single one left on the old `server/`
    // context would build an image WITHOUT the playbooks.
    const sites = [
      ".github/workflows/ci.yml",
      ".github/workflows/license-guard.yml",
      ".github/workflows/release.yml",
      "docker-compose.yml",
      "scripts/screenshots/run.sh",
    ];
    for (const site of sites) {
      const text = readFileSync(repoRoot(site), "utf8");
      // An explicit `server/Dockerfile` reference only appears once the context
      // moved off `server/` (the old form used `server/` as the context with an
      // implicit Dockerfile), so this proves the site was migrated.
      expect(text, `${site} must build with -f server/Dockerfile`).toContain("server/Dockerfile");
      // The legacy `server/`-only build context must be gone in any of its
      // forms (`context: server`, `context: ./server`, `context: /server`).
      expect(text, `${site} still uses the legacy server/ build context`).not.toMatch(
        /context:\s*\.?\/?server\b/,
      );
    }
  });
});
