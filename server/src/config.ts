/**
 * Typed, validated application settings.
 *
 * One place parses `process.env` so transports, the Fastify app, and tests
 * never independently re-parse environment variables. Lands before any
 * transport code because Phase 7 (`PCT_ADGUARD_*`) and Phase 2
 * (`DATABASE_URL`) both depend on it.
 *
 * Variable names follow the authoritative deployment docs
 * (`docs/server-deployment.md` → "AdGuard Home deployment modes"): AdGuard
 * credentials use the Docker secret-file convention (`*_FILE`), and the
 * three documented modes (`disabled` / `external` / `managed`) are modelled
 * as a discriminated union so each mode only carries the fields it needs.
 */
import { z } from "zod";
import { isValidTimeZone } from "./policy/budget-window.js";

/** pino log levels, in increasing severity, plus `silent`. */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;

/**
 * Normalize a `DATABASE_URL` value to a bare filesystem path.
 *
 * `DATABASE_URL` is accepted in two interchangeable forms: a bare path
 * (`/data/policy.sqlite`, as `.env.example` and the deployment docs show)
 * and the libsql `file:` URL form (`file:/data/policy.sqlite`, as CI's
 * `migrations` job and `drizzle.config.ts` use). `better-sqlite3` only
 * understands bare paths, so we strip a leading `file:` here exactly the way
 * `drizzle.config.ts` does — keeping drizzle-kit (generate/migrate/check) and
 * the runtime connection pointed at the same file regardless of which form an
 * operator picked. See issue #34.
 */
function stripFileScheme(databaseUrl: string): string {
  return databaseUrl.replace(/^file:/, "");
}

/**
 * AdGuard Home integration, keyed on `PCT_ADGUARD_MODE`.
 *
 * The loader assembles a nested object from the flat `PCT_ADGUARD_*` env
 * vars before parsing, so each branch narrows to exactly the fields that
 * mode uses (see `docs/server-deployment.md`).
 */
const adguardSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }),
  z.object({
    mode: z.literal("external"),
    url: z.url(),
    username: z.string().min(1).optional(),
    passwordFile: z.string().min(1).optional(),
    apiTokenFile: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal("managed"),
    bindAddr: z.string().min(1).default("0.0.0.0:53"),
    adminPort: z.coerce.number().int().positive().default(3000),
  }),
]);

const settingsSchema = z
  .object({
    /**
     * Path to the SQLite policy store (better-sqlite3 / Drizzle). Accepts a
     * bare path or a `file:` URL; both normalize to a bare filesystem path
     * (see {@link stripFileScheme}). The `.transform` runs after `.default`,
     * so the default and any `file:`-prefixed value are both normalized.
     */
    databaseUrl: z.string().min(1).default("/data/policy.sqlite").transform(stripFileScheme),
    /**
     * Filesystem root of the prerendered SvelteKit build served at `/admin`
     * and `/app` (#40). Defaults to the in-image path the Dockerfile copies
     * the `adapter-static` output into (`COPY … ./frontend` under WORKDIR
     * `/app`). Overridable via `PCT_FRONTEND_ROOT` so dev and tests can point
     * the mount at a different directory; if the path is absent the mount is
     * skipped (the surfaces 404) rather than failing startup.
     */
    frontendRoot: z.string().min(1).default("/app/frontend"),
    /**
     * Server-default IANA timezone for budget rollover (`PCT_DEFAULT_TZ`).
     *
     * A user's effective timezone is `User.tz ?? PCT_DEFAULT_TZ`; it defines
     * when daily/weekly/monthly budgets roll over (see
     * `docs/adr/0001-budget-timezone.md`). Validated against the runtime's
     * IANA database here so a typo fails fast at startup rather than skewing
     * every budget window. Defaults to `UTC` — always valid, and consistent
     * with the "UTC everywhere" storage rule — so an operator who never
     * crosses a timezone need not set it.
     */
    defaultTz: z.string().min(1).default("UTC").refine(isValidTimeZone, {
      message: "must be a valid IANA timezone (e.g. America/New_York)",
    }),
    /** Drives pino's level (see #11). */
    logLevel: z.enum(LOG_LEVELS).default("info"),
    /**
     * Enable the human-readable `pino-pretty` transport for local dev (#11).
     * `z.stringbool()` parses the usual env truthy/falsy strings
     * (`true`/`false`, `1`/`0`, `yes`/`no`, …); defaults off so production
     * stays JSON.
     */
    logPretty: z.stringbool().default(false),
    /**
     * Signs the admin session cookie (#52) and, later, integration tokens.
     * Optional so dev/CI can build the app without it; auth endpoints and the
     * admin guard return `503 auth_not_configured` until it is set, since a
     * session cannot be signed without it.
     */
    secretKey: z.string().min(1).optional(),
    /**
     * First-admin bootstrap (#52). On first run, if no admin row exists and
     * **both** of these are set, the admin credential is seeded from them: the
     * password is Argon2id-hashed immediately and the plaintext is never
     * persisted (see `auth/credentials.ts` and `docs/server-deployment.md` →
     * "Authentication"). Optional, and only read at bootstrap; once an admin
     * exists they are ignored, so they can be dropped from the environment
     * after the first successful start.
     */
    adminUsername: z.string().min(1).optional(),
    adminPassword: z.string().min(1).optional(),
    /**
     * Root of the data-volume Ansible directory (`PCT_ANSIBLE_DIR`). The
     * Phase-6 runner resolves `ansible-playbook` at `<dir>/venv/bin/` and
     * playbooks under `<dir>/playbooks/`; the venv itself is bootstrapped into
     * this directory on first run (#39). Defaults to the documented
     * `/data/ansible` layout (`docs/server-deployment.md` → "Volume layout").
     */
    ansibleDir: z.string().min(1).default("/data/ansible"),
    adguard: adguardSchema,
  })
  .superRefine((settings, ctx) => {
    if (settings.adguard.mode !== "external") return;

    if (
      settings.adguard.passwordFile === undefined &&
      settings.adguard.apiTokenFile === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["adguard", "passwordFile"],
        message:
          "external AdGuard mode needs PCT_ADGUARD_PASSWORD_FILE or PCT_ADGUARD_API_TOKEN_FILE",
      });
    }

    // AdGuard's REST API uses HTTP basic auth, so a password is only usable
    // alongside a username. (Token-only auth needs no username.)
    if (settings.adguard.passwordFile !== undefined && settings.adguard.username === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["adguard", "username"],
        message:
          "PCT_ADGUARD_PASSWORD_FILE requires PCT_ADGUARD_USERNAME (AdGuard uses HTTP basic auth)",
      });
    }
  });

/** Fully-validated settings; the single source of truth for env config. */
export type Settings = z.infer<typeof settingsSchema>;

/** Thrown when the environment fails validation, with a readable summary. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/**
 * Parse and validate settings from an environment map.
 *
 * Fails fast with a readable {@link SettingsError} (formatted zod issues,
 * not a stack trace) so a typo like `PCT_ADGUARD_MODE=enabled` is obvious.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const result = settingsSchema.safeParse({
    databaseUrl: env.DATABASE_URL,
    frontendRoot: env.PCT_FRONTEND_ROOT,
    defaultTz: env.PCT_DEFAULT_TZ,
    logLevel: env.PCT_LOG_LEVEL,
    logPretty: env.PCT_LOG_PRETTY,
    secretKey: env.PCT_SECRET_KEY,
    adminUsername: env.PCT_ADMIN_USERNAME,
    adminPassword: env.PCT_ADMIN_PASSWORD,
    ansibleDir: env.PCT_ANSIBLE_DIR,
    adguard: {
      mode: env.PCT_ADGUARD_MODE ?? "disabled",
      url: env.PCT_ADGUARD_URL,
      username: env.PCT_ADGUARD_USERNAME,
      passwordFile: env.PCT_ADGUARD_PASSWORD_FILE,
      apiTokenFile: env.PCT_ADGUARD_API_TOKEN_FILE,
      bindAddr: env.PCT_ADGUARD_BIND_ADDR,
      adminPort: env.PCT_ADGUARD_ADMIN_PORT,
    },
  });

  if (!result.success) {
    throw new SettingsError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}
