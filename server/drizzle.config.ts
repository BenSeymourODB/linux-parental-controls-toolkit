import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration for the policy store.
 *
 * - `dialect: "sqlite"` with the better-sqlite3 driver (matches the runtime
 *   in `server/src/policy`).
 * - `schema` points at the (Phase-1-empty) policy schema; tables land in
 *   Phase 2 and each one is followed by `npm run db:generate`.
 * - `out` is the committed migrations folder consumed by CI's `migrations`
 *   job (`.github/workflows/integration.yml`) and by `testDb()` in the test
 *   helpers (#12).
 *
 * `DATABASE_URL` follows the libsql `file:` convention used across the
 * deployment docs and CI; better-sqlite3 wants a bare filesystem path, so the
 * scheme is stripped here. Phase 2's settings loader owns the runtime
 * connection; this config is a drizzle-kit-only concern (generate/migrate/
 * check), so it reads the env directly.
 */
const databaseUrl = process.env.DATABASE_URL ?? "file:./policy.sqlite";
const dbPath = databaseUrl.replace(/^file:/, "");

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/policy/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: dbPath,
  },
});
