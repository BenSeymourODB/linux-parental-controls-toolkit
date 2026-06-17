/**
 * The admin credential store and first-admin bootstrap (#52).
 *
 * Reads and writes the singleton {@link adminCredentials} row through the
 * shared `app.db` handle. The bootstrap is the answer to the gap the issue
 * flags — the docs promised single-admin login but never said how the first
 * password is set: on first run, `PCT_ADMIN_USERNAME` + `PCT_ADMIN_PASSWORD`
 * seed the row (hashed immediately), and that path is documented in
 * `docs/server-deployment.md` → "Authentication".
 *
 * License boundary: none touched — Drizzle + better-sqlite3 are permissive.
 */
import type { FastifyBaseLogger } from "fastify";

import type { Settings } from "../config.js";
import type { PolicyDb } from "../policy/db.js";
import { adminCredentials } from "../policy/schema.js";
import { hashPassword } from "./passwords.js";

/** The stored admin credential (the singleton `id = 1` row). */
export interface AdminCredential {
  id: number;
  username: string;
  passwordHash: string;
}

/** Outcome of {@link bootstrapAdmin}, returned so callers/tests need not parse logs. */
export type BootstrapResult = "already-exists" | "seeded" | "unconfigured";

/** Fetch the single admin credential row, or `undefined` if none is seeded yet. */
export function getAdmin(db: PolicyDb): AdminCredential | undefined {
  return db
    .select({
      id: adminCredentials.id,
      username: adminCredentials.username,
      passwordHash: adminCredentials.passwordHash,
    })
    .from(adminCredentials)
    .limit(1)
    .get();
}

/**
 * Seed the first admin from the environment, idempotently.
 *
 * - If an admin row already exists, do nothing (so a restart never reseeds and
 *   `PCT_ADMIN_PASSWORD` can be dropped from the environment after first run).
 * - Else, if both `PCT_ADMIN_USERNAME` and `PCT_ADMIN_PASSWORD` are set, hash
 *   the password with Argon2id and insert the singleton row.
 * - Else, log a warning and leave login disabled until an admin is configured.
 */
export async function bootstrapAdmin(
  db: PolicyDb,
  settings: Pick<Settings, "adminUsername" | "adminPassword">,
  logger: FastifyBaseLogger,
): Promise<BootstrapResult> {
  if (getAdmin(db) !== undefined) {
    logger.debug("admin credential already present; skipping bootstrap");
    return "already-exists";
  }

  const { adminUsername, adminPassword } = settings;
  if (adminUsername === undefined || adminPassword === undefined) {
    logger.warn(
      "no admin credential and PCT_ADMIN_USERNAME/PCT_ADMIN_PASSWORD not both set; " +
        "login is disabled until an admin is configured",
    );
    return "unconfigured";
  }

  const passwordHash = await hashPassword(adminPassword);
  db.insert(adminCredentials).values({ id: 1, username: adminUsername, passwordHash }).run();
  logger.info({ username: adminUsername }, "seeded initial admin credential");
  return "seeded";
}
