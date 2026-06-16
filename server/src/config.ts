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

/** pino log levels, in increasing severity, plus `silent`. */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;

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
    /** Path to the SQLite policy store (better-sqlite3 / Drizzle). */
    databaseUrl: z.string().min(1).default("/data/policy.sqlite"),
    /** Drives pino's level (see #11). */
    logLevel: z.enum(LOG_LEVELS).default("info"),
    /**
     * Enable the human-readable `pino-pretty` transport for local dev (#11).
     * `z.stringbool()` parses the usual env truthy/falsy strings
     * (`true`/`false`, `1`/`0`, `yes`/`no`, …); defaults off so production
     * stays JSON.
     */
    logPretty: z.stringbool().default(false),
    /** Signs sessions / integration tokens (consumed in later phases). */
    secretKey: z.string().min(1).optional(),
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
    logLevel: env.PCT_LOG_LEVEL,
    logPretty: env.PCT_LOG_PRETTY,
    secretKey: env.PCT_SECRET_KEY,
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
