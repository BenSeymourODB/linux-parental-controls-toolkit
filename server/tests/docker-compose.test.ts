/**
 * Guards the repo-root `docker-compose.yml` (the local-dev bring-up, #7).
 *
 * This file is infrastructure, not TypeScript, so the invariants the README
 * Quick Start and the acceptance criteria depend on are asserted here: a
 * single `dashboard` service built from `./server`, the `/data` mount, the
 * `8000` port, and `.env` wiring — plus the explicit out-of-scope guarantee
 * that no AdGuard (Phase 7) sidecar has crept in.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const composePath = fileURLToPath(new URL("../../docker-compose.yml", import.meta.url));

// Validate the slice of the Compose schema this test asserts on, rather than
// casting `parse()`'s `unknown` output — keeps the repo's "validate external
// input with zod / no unchecked `as`" convention (CLAUDE.md → "Code conventions").
const envFileEntrySchema = z.union([
  z.string(),
  z.object({ path: z.string().optional(), required: z.boolean().optional() }),
]);
const serviceSchema = z.object({
  build: z.union([z.string(), z.object({ context: z.string().optional() })]).optional(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  env_file: z.union([z.array(envFileEntrySchema), z.string()]).optional(),
});
const composeSchema = z.object({
  services: z.record(z.string(), serviceSchema).optional(),
});
type ComposeService = z.infer<typeof serviceSchema>;

function loadCompose(): z.infer<typeof composeSchema> {
  return composeSchema.parse(parse(readFileSync(composePath, "utf8")));
}

/** The single `dashboard` service, with a clear failure if it is missing. */
function dashboardService(): ComposeService {
  const service = loadCompose().services?.dashboard;
  if (service === undefined) {
    throw new Error("docker-compose.yml is missing the `dashboard` service");
  }
  return service;
}

describe("docker-compose.yml (local dev)", () => {
  it("parses as valid YAML", () => {
    expect(() => loadCompose()).not.toThrow();
  });

  it("defines exactly one service: dashboard (no AdGuard sidecar — Phase 7)", () => {
    const compose = loadCompose();
    expect(Object.keys(compose.services ?? {})).toEqual(["dashboard"]);
  });

  it("builds the image from ./server", () => {
    const { build } = dashboardService();
    const context = typeof build === "string" ? build : build?.context;
    expect(context).toBe("./server");
  });

  it("publishes the dashboard HTTP port 8000", () => {
    expect(dashboardService().ports).toContain("8000:8000");
  });

  it("mounts a host directory at /data", () => {
    expect(dashboardService().volumes).toContain("./data:/data");
  });

  it("reads config from an optional .env file", () => {
    const { env_file } = dashboardService();
    const entries = Array.isArray(env_file) ? env_file : [env_file];
    const dotEnv = entries.find((e) => (typeof e === "string" ? e === ".env" : e?.path === ".env"));
    expect(dotEnv).toBeDefined();
    // Optional so `docker compose up` works before the user copies .env.example.
    if (typeof dotEnv === "object") {
      expect(dotEnv.required).toBe(false);
    }
  });
});
