/**
 * Unit tests for the CI migration-collision auto-fix (issue #210, Slice 2 of
 * #199).
 *
 * The pure matchers / comment builders are exercised directly; the
 * {@link autofixMigrations} orchestrator runs against an in-memory
 * {@link FakeEnv} that fakes every injected seam (git, the `db:check` /
 * `db:rebase` scripts, PR comments), so the whole decision tree — loop guard,
 * the narrow collision trigger, and the push-vs-comment-vs-noop branches — is
 * covered without a live git, drizzle-kit, or `gh`.
 */
import { describe, expect, it } from "vitest";

import {
  MIGRATIONS_DIR,
  SKIP_MARKER,
  autofixMigrations,
  combinedOutputFromExecError,
  headHasSkipMarker,
  isParentCollisionFailure,
  pushFailedCommentBody,
  rebaseRefusalReason,
  refusalCommentBody,
  successCommentBody,
  type CiAutofixDeps,
} from "../../scripts/ci-autofix-migrations.js";

// --- Pure matchers / builders -----------------------------------------------

describe("isParentCollisionFailure", () => {
  it("matches the drizzle-kit parent-collision error, even when line-wrapped", () => {
    const wrapped =
      "[20260619_a_snapshot.json, 20260620_b_snapshot.json] are pointing to a parent\n" +
      "snapshot: 0003_snapshot.json which is a collision.";
    expect(isParentCollisionFailure(wrapped)).toBe(true);
    // Case-insensitive.
    expect(isParentCollisionFailure(wrapped.toUpperCase())).toBe(true);
  });

  it("does not match unrelated drizzle output", () => {
    expect(isParentCollisionFailure("")).toBe(false);
    expect(isParentCollisionFailure("Error: schema drift detected, run db:generate")).toBe(false);
    // Only one of the two required fragments present.
    expect(isParentCollisionFailure("pointing to a parent snapshot: x")).toBe(false);
    expect(isParentCollisionFailure("which is a collision in some other tool")).toBe(false);
  });
});

describe("headHasSkipMarker", () => {
  it("detects the regen marker in a commit message", () => {
    expect(headHasSkipMarker(`chore(db): auto-rebase ${SKIP_MARKER}\n\nbody`)).toBe(true);
  });

  it("ignores ordinary commit messages", () => {
    expect(headHasSkipMarker("feat(policy): add group budgets")).toBe(false);
    expect(headHasSkipMarker("")).toBe(false);
  });

  it("honours a custom marker", () => {
    expect(headHasSkipMarker("x [no-ci]", "[no-ci]")).toBe(true);
    expect(headHasSkipMarker("x [no-ci]", "[skip-regen]")).toBe(false);
  });
});

describe("rebaseRefusalReason", () => {
  it("extracts the reason after the CLI prefix", () => {
    expect(rebaseRefusalReason("db:rebase refused: 2 branch-only migrations found")).toBe(
      "2 branch-only migrations found",
    );
  });

  it("falls back to the raw output when the prefix is absent", () => {
    expect(rebaseRefusalReason("  some other failure  ")).toBe("some other failure");
  });

  it("never returns an empty string", () => {
    expect(rebaseRefusalReason("")).toMatch(/no reason reported/);
    expect(rebaseRefusalReason("db:rebase refused:   ")).toMatch(/no reason reported/);
  });
});

describe("comment bodies", () => {
  it("the success body names the base ref, asks for a re-run, and is self-skip-marked", () => {
    const body = successCommentBody("origin/main");
    expect(body).toContain("origin/main");
    expect(body).toContain("re-run");
    expect(body).toContain(SKIP_MARKER);
  });

  it("the refusal body quotes the reason and points at the local fix", () => {
    const body = refusalCommentBody("looks hand-edited");
    expect(body).toContain("> looks hand-edited");
    expect(body).toContain("npm run db:rebase");
  });

  it("the push-failed body names the branch and says nothing was overwritten", () => {
    const body = pushFailedCommentBody("claude/feature");
    expect(body).toContain("claude/feature");
    expect(body).toContain("could not push");
    expect(body).toContain("Nothing was");
  });
});

describe("combinedOutputFromExecError", () => {
  it("coalesces Buffer stdout + stderr off a thrown execFileSync error", () => {
    const error = { stdout: Buffer.from("out line"), stderr: Buffer.from("err line") };
    expect(combinedOutputFromExecError(error)).toBe("out line\nerr line");
  });

  it("tolerates string streams and missing streams (spawn failure)", () => {
    expect(combinedOutputFromExecError({ stdout: "a", stderr: "b" })).toBe("a\nb");
    expect(combinedOutputFromExecError({})).toBe("\n");
    expect(combinedOutputFromExecError(new Error("ENOENT"))).toBe("\n");
  });
});

// --- Orchestrator (in-memory fakes) -----------------------------------------

const STAGED_ARGS = ["diff", "--cached", "--name-only", "--", MIGRATIONS_DIR];
const COLLISION_OUTPUT =
  "[a_snapshot.json, b_snapshot.json] are pointing to a parent snapshot: " +
  "c_snapshot.json which is a collision.";

/** An in-memory implementation of every {@link CiAutofixDeps} seam. */
class FakeEnv {
  readonly gitCalls: string[][] = [];
  readonly comments: string[] = [];
  readonly logs: string[] = [];

  /** HEAD commit message returned by `git log -1 --pretty=%B`. */
  headMessage = "feat: ordinary change";
  /** Staged migration paths returned by `git diff --cached … -- drizzle`. */
  stagedMigrations = "";
  /** Result of `db:check`. */
  checkResult: { ok: boolean; output: string } = { ok: true, output: "" };
  /** Result of `db:rebase`. */
  rebaseResult: { ok: boolean; output: string } = { ok: true, output: "" };
  /** True once runRebase has been invoked (to assert it did/didn't run). */
  rebaseRan = false;
  /** When set, `git push` throws (simulates a non-fast-forward rejection). */
  pushShouldFail = false;

  deps(): CiAutofixDeps {
    return {
      git: (args) => {
        this.gitCalls.push(args);
        if (args[0] === "log") {
          return this.headMessage;
        }
        if (sameArgs(args, STAGED_ARGS)) {
          return this.stagedMigrations;
        }
        if (args[0] === "push" && this.pushShouldFail) {
          throw new Error("! [rejected] (non-fast-forward)");
        }
        // commit / push and anything else: no stdout.
        return "";
      },
      checkMigrations: () => this.checkResult,
      runRebase: () => {
        this.rebaseRan = true;
        return this.rebaseResult;
      },
      comment: (body) => {
        this.comments.push(body);
      },
      log: (message) => {
        this.logs.push(message);
      },
    };
  }

  /** Did a git subcommand starting with `head` run? */
  ranGit(head: string): boolean {
    return this.gitCalls.some((call) => call[0] === head);
  }
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

const OPTIONS = { baseRef: "origin/main", branch: "claude/feature", skipMarker: SKIP_MARKER };

describe("autofixMigrations", () => {
  it("skips when HEAD is its own regen commit (loop guard)", () => {
    const env = new FakeEnv();
    env.headMessage = `chore(db): auto-rebase ${SKIP_MARKER}`;

    const result = autofixMigrations(env.deps(), OPTIONS);

    expect(result.action).toBe("skipped");
    // It must not even run the check once it knows it's looking at its own commit.
    expect(env.rebaseRan).toBe(false);
    expect(env.gitCalls).toHaveLength(1); // only the `git log` probe
  });

  it("is a no-op when the migration round-trip is green", () => {
    const env = new FakeEnv();
    env.checkResult = { ok: true, output: "" };

    const result = autofixMigrations(env.deps(), OPTIONS);

    expect(result.action).toBe("noop");
    expect(result.reason).toMatch(/green/);
    expect(env.rebaseRan).toBe(false);
    expect(env.ranGit("push")).toBe(false);
  });

  it("is a no-op when the check fails for an unrelated reason (left to normal CI)", () => {
    const env = new FakeEnv();
    env.checkResult = { ok: false, output: "Error: genuine schema drift" };

    const result = autofixMigrations(env.deps(), OPTIONS);

    expect(result.action).toBe("noop");
    expect(result.reason).toMatch(/unrelated/);
    expect(env.rebaseRan).toBe(false);
    expect(env.comments).toEqual([]);
    expect(env.ranGit("push")).toBe(false);
  });

  it("comments without pushing when db:rebase refuses (honours the Slice-1 guard)", () => {
    const env = new FakeEnv();
    env.checkResult = { ok: false, output: COLLISION_OUTPUT };
    env.rebaseResult = {
      ok: false,
      output: "db:rebase refused: the branch-only migration was not reproduced by regen",
    };

    const result = autofixMigrations(env.deps(), OPTIONS);

    expect(result.action).toBe("commented");
    expect(env.rebaseRan).toBe(true);
    expect(env.comments).toHaveLength(1);
    expect(env.comments[0]).toContain("not reproduced by regen");
    // No commit, no push on a refusal.
    expect(env.ranGit("commit")).toBe(false);
    expect(env.ranGit("push")).toBe(false);
  });

  it("is a no-op when db:rebase succeeds but stages nothing", () => {
    const env = new FakeEnv();
    env.checkResult = { ok: false, output: COLLISION_OUTPUT };
    env.rebaseResult = { ok: true, output: "db:rebase: no branch-only migrations to rebase." };
    env.stagedMigrations = "";

    const result = autofixMigrations(env.deps(), OPTIONS);

    expect(result.action).toBe("noop");
    expect(result.reason).toMatch(/nothing branch-only/);
    expect(env.ranGit("commit")).toBe(false);
    expect(env.ranGit("push")).toBe(false);
    expect(env.comments).toEqual([]);
  });

  it("commits, pushes, and comments on a successful collision rebase", () => {
    const env = new FakeEnv();
    env.checkResult = { ok: false, output: COLLISION_OUTPUT };
    env.rebaseResult = { ok: true, output: "Rebased onto origin/main. … staged …" };
    env.stagedMigrations = "drizzle/20260620_x.sql\ndrizzle/meta/20260620_snapshot.json";

    const result = autofixMigrations(env.deps(), OPTIONS);

    expect(result.action).toBe("pushed");
    // Commit carries the loop-guard marker; push targets the PR branch.
    const commit = env.gitCalls.find((c) => c[0] === "commit");
    expect(commit?.[2]).toContain(SKIP_MARKER);
    expect(commit?.[2]).toContain("origin/main");
    expect(env.gitCalls).toContainEqual(["push", "origin", "HEAD:refs/heads/claude/feature"]);
    expect(env.comments).toHaveLength(1);
    expect(env.comments[0]).toContain("re-run");
  });

  it("comments (without crashing) when the push is rejected non-fast-forward", () => {
    const env = new FakeEnv();
    env.checkResult = { ok: false, output: COLLISION_OUTPUT };
    env.rebaseResult = { ok: true, output: "Rebased onto origin/main. … staged …" };
    env.stagedMigrations = "drizzle/20260620_x.sql";
    env.pushShouldFail = true;

    const result = autofixMigrations(env.deps(), OPTIONS);

    expect(result.action).toBe("push-failed");
    // It attempted the push, then commented for a human — no success comment.
    expect(env.ranGit("push")).toBe(true);
    expect(env.comments).toHaveLength(1);
    expect(env.comments[0]).toContain("could not push");
    // Not the success comment.
    expect(env.comments[0]).not.toContain("structurally equivalent");
  });
});
