/**
 * Drizzle schema for the policy store (SQLite).
 *
 * Intentionally empty in Phase 1: this module exists so `drizzle.config.ts`
 * has a schema target and the migrations pipeline (`drizzle-kit generate` /
 * `migrate` / `check`) is wired and exercised by CI before any tables exist.
 *
 * The policy tables — `User`, `Client`, `UserOnClient`, `Activity`,
 * `ActivityGroup`, `Budget`, `Schedule`, `Exception`, `Grant`,
 * `IntegrationToken` (see `docs/architecture.md` → "Policy model") — land in
 * Phase 2 on top of this scaffold. Each table added here is followed by
 * `npm run db:generate` to emit the next migration under `server/drizzle/`.
 */

// No table definitions yet. Phase 2 adds `sqliteTable(...)` exports here.
export {};
