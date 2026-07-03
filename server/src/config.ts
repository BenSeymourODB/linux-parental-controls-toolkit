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
import { DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS } from "./policy/retention.js";
import { isValidCronPattern } from "./transport/activitywatch/telemetry.js";
import { DEFAULT_COMPAT_WINDOW } from "./events/protocol.js";

/** pino log levels, in increasing severity, plus `silent`. */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;

/**
 * A bare playbook file name — letters, digits, `.`, `_`, `-`, no path
 * separators — matching the Ansible runner's own `assertSafePlaybookName`
 * guard (`transport/ansible/index.ts`). Validating the re-apply playbook list
 * here fails a typo fast at startup; the runner re-checks defensively at run
 * time.
 */
const PLAYBOOK_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Split a comma-separated `PCT_REAPPLY_PLAYBOOKS` value into trimmed names. */
function splitPlaybookList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Boolean word-forms accepted for `PCT_TRUST_PROXY` (case-insensitive). */
const TRUST_PROXY_TRUE = new Set(["true", "yes", "on"]);
const TRUST_PROXY_FALSE = new Set(["false", "no", "off"]);

/**
 * Parse `PCT_TRUST_PROXY` into the shape Fastify's `trustProxy` option takes
 * (Fastify hands it to `proxy-addr`): a boolean, a hop count, or an
 * IP/CIDR/keyword allowlist.
 *
 * Precedence is deliberate and documented (`docs/reverse-proxy-tls.md`):
 *
 * - boolean **words** (`true`/`false`/`yes`/`no`/`on`/`off`, case-insensitive)
 *   → `true` / `false`;
 * - a bare non-negative integer → a **hop count** (so `"1"`/`"0"` mean one/zero
 *   hops, not true/false);
 * - anything else → a comma-separated **allowlist** (`127.0.0.1,10.0.0.0/8`,
 *   or a keyword like `loopback`) → `string[]`;
 * - unset / empty / whitespace-only → `false`, preserving the safe LAN default
 *   of never trusting `X-Forwarded-*` from an untrusted direct caller.
 *
 * An allowlist that is empty after trimming (e.g. `","`) also falls back to
 * `false`.
 */
function parseTrustProxy(value: unknown): boolean | number | string[] {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;

  const lower = trimmed.toLowerCase();
  if (TRUST_PROXY_TRUE.has(lower)) return true;
  if (TRUST_PROXY_FALSE.has(lower)) return false;

  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const entries = trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : false;
}

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
    /**
     * Data-volume directory the managed AdGuard Home binary, seed config, and
     * work dir live under (`PCT_ADGUARD_DATA_DIR`). Defaults to the documented
     * `/data/adguard` layout (`docs/server-deployment.md` → "Volume layout").
     */
    dataDir: z.string().min(1).default("/data/adguard"),
    /**
     * Optional pinned AdGuard Home release tag (`PCT_ADGUARD_VERSION`, e.g.
     * `v0.107.65`). When unset, the managed supervisor fetches the latest stable
     * release on first run and then leaves the installed binary in place (#96).
     */
    version: z.string().min(1).optional(),
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
    /**
     * The dashboard's own release version (`PCT_SERVER_VERSION`, e.g.
     * `0.1.0-alpha.5`), injected at image-build time from the release tag
     * (`server/Dockerfile` build arg, set by `release.yml`). Optional: a local
     * dev/test build leaves it unset, in which case the admin Clients page shows
     * each client's reported agent version without a drift verdict (there is
     * nothing authoritative to compare against). Used only for display/drift
     * classification — never for behaviour — so an absent value degrades safely.
     *
     * The `preprocess` maps an empty/whitespace-only value to `undefined` before
     * validation: the `server/Dockerfile` sets `ENV PCT_SERVER_VERSION=` from an
     * empty build arg on a plain `docker build` (no `--build-arg`), so the var is
     * *present but empty* rather than unset. Without this, `.min(1)` would reject
     * `""` and crash startup — the opposite of the "degrade safely" contract.
     */
    serverVersion: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    /**
     * How many event-protocol versions below the server's own the handshake
     * still accepts (`PCT_PROTOCOL_COMPAT_WINDOW`, ADR 0007 §3). `1` is the
     * historical N-1 window. This is the single source of truth for the window:
     * it threads into {@link negotiate} via the event-stream route, so widening
     * it both stops refusing older clients *and* moves the threshold that flags
     * `update_required` on the Clients page. A positive integer.
     */
    protocolCompatWindow: z.coerce.number().int().positive().default(DEFAULT_COMPAT_WINDOW),
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
     * Fastify's `trustProxy` setting (`PCT_TRUST_PROXY`, #235), default off.
     *
     * When the dashboard runs behind a reverse proxy (the recommended non-LAN
     * topology, `docs/reverse-proxy-tls.md`), every request arrives from the
     * proxy's address, so the per-IP failed-attempt limiter on admin login and
     * `POST /api/clients/enrol` collapses into one global bucket. Enabling this
     * lets Fastify derive `request.ip` from a trusted `X-Forwarded-For` so the
     * limiter keys on the real client IP again. Default **off** never trusts
     * `X-Forwarded-*` from an untrusted direct caller (safe LAN behaviour). See
     * {@link parseTrustProxy} for the accepted forms (boolean / hop count /
     * IP-CIDR allowlist).
     */
    trustProxy: z
      .preprocess(
        parseTrustProxy,
        z.union([z.boolean(), z.number().int().nonnegative(), z.array(z.string().min(1)).min(1)]),
      )
      .default(false),
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
    /**
     * Pinned `ansible-core` version installed into the first-run venv
     * (`PCT_ANSIBLE_CORE_VERSION`). The boot-time bootstrap (#39) runs
     * `pip install ansible-core==<version>` and records it in a sentinel under
     * the venv so an image upgrade that bumps this default reconciles the venv
     * (`docs/server-deployment.md` → "Upgrade path"). A bare version string so
     * the install is reproducible; validated here so a typo fails fast.
     */
    ansibleCoreVersion: z
      .string()
      .regex(/^[0-9][0-9A-Za-z.-]*$/, {
        message: "must be a bare version like 2.18.1",
      })
      .default("2.18.1"),
    /**
     * Path to the bundled `install-client.sh` served at `GET /install-client.sh`
     * (`PCT_INSTALL_CLIENT_SCRIPT_PATH`). Defaults to the in-image path the
     * Dockerfile copies the script into. Overridable so dev and tests can point
     * at a different path; if absent the route 404s with a startup warning rather
     * than blocking startup.
     */
    installClientScriptPath: z.string().min(1).default("/app/client-scripts/install-client.sh"),
    /**
     * Read-only, in-image source directory the first-run bootstrap (#39) syncs
     * playbooks from into `<ansibleDir>/playbooks/` (`PCT_ANSIBLE_PLAYBOOK_SRC`).
     * Defaults to the path the image is expected to ship them at. A missing
     * source is a logged no-op (the venv still bootstraps), so the dashboard
     * starts cleanly before the playbooks are packaged into the image.
     */
    ansiblePlaybookSourceDir: z.string().min(1).default("/app/ansible/playbooks"),
    /**
     * Path to the dashboard's SSH **public** key (`PCT_SSH_PUBLIC_KEY_PATH`).
     * The client-enrolment response (#77) returns this so the client can
     * authorize the dashboard in `pct-agent`'s `authorized_keys`. The key pair
     * is generated server-side as a Phase-4 first-run step (#39); until then
     * the file is legitimately absent and the enrol response carries
     * `sshPublicKey: null`. Defaults to the documented `/data/secrets/ssh`
     * layout (`docs/server-deployment.md` → "Volume layout").
     */
    sshPublicKeyPath: z.string().min(1).default("/data/secrets/ssh/id_ed25519.pub"),
    /**
     * Path to the dashboard's SSH **private** key (`PCT_SSH_PRIVATE_KEY_PATH`).
     * The key pair is generated server-side on first run (#39, the Phase-4
     * step) if absent; the `transport/ssh` facade authenticates to clients with
     * it. Defaults to the documented `/data/secrets/ssh` layout, paired with
     * {@link settingsSchema}'s `sshPublicKeyPath` (`docs/server-deployment.md`
     * → "Volume layout").
     */
    sshPrivateKeyPath: z.string().min(1).default("/data/secrets/ssh/id_ed25519"),
    /**
     * Phase-5 telemetry pull (#86): the croner schedule and per-pass
     * concurrency for opening SSH port-forwards to each client's `aw-server`.
     */
    telemetry: z.object({
      /**
       * croner pattern for the pull pass (`PCT_TELEMETRY_PULL_CRON`). Validated
       * here so a typo fails fast at startup rather than silently never
       * running. Defaults to every five minutes.
       */
      pullCron: z
        .string()
        .min(1)
        .default("*/5 * * * *")
        .refine(isValidCronPattern, { message: "must be a valid cron pattern (e.g. */5 * * * *)" }),
      /**
       * Max clients tunnelled concurrently per pass
       * (`PCT_TELEMETRY_PULL_CONCURRENCY`). Defaults to 4.
       */
      pullConcurrency: z.coerce.number().int().positive().default(4),
    }),
    /**
     * Phase-8 per-activity enforcement sweep (#292/#327). The sweep runs right
     * after each telemetry rollup (one timer — `telemetry.pullCron` — so
     * enforcement reads fresh usage), so it has no cadence of its own here.
     */
    enforcement: z.object({
      /**
       * Cool-down seconds threaded to the decision core (#98) so a near-boundary
       * budget doesn't re-fire a force-close every rollup
       * (`PCT_ENFORCEMENT_COOLDOWN_SECONDS`). Mirrors the sweep's
       * `DEFAULT_COOLDOWN_SECONDS`; defaults to 300 (five minutes).
       */
      cooldownSeconds: z.coerce.number().int().positive().default(300),
      /**
       * How far back the first telemetry pull for a client reaches when there is
       * no in-memory cursor yet — at boot or after a restart
       * (`PCT_ENFORCEMENT_INITIAL_LOOKBACK_SECONDS`). Bounds the re-pull window
       * so a restart can't sweep in an unbounded backlog; defaults to 900 (15
       * minutes). Missing telemetry credits no consumption (#88), so a gap here
       * is non-punitive.
       */
      initialLookbackSeconds: z.coerce.number().int().positive().default(900),
    }),
    /**
     * Data retention (#136, epic #135). `defaultDays` is the global default
     * window applied to every dated-data category that has no per-category
     * override in the policy store (`PCT_RETENTION_DEFAULT_DAYS`, default 365).
     * Per-category overrides (custom window or "keep forever") are persisted in
     * `retention_overrides` and managed via `/api/retention`; only the default
     * lives in the environment. Bounded by {@link MAX_RETENTION_DAYS} so an
     * absurd value is rejected at startup — "effectively forever" is the
     * explicit per-category keep-forever mode, not a giant day count.
     */
    retention: z.object({
      defaultDays: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_RETENTION_DAYS)
        .default(DEFAULT_RETENTION_DAYS),
    }),
    /**
     * Phase-6 periodic re-apply / tamper-reversion scheduler (#93): the croner
     * cadence and the ordered list of playbooks re-run against the fleet to
     * revert local config drift. Consumed by the activation wiring once the
     * first-run venv (#39) and the playbooks (#90/#91/#92) land — like the
     * `telemetry` block above, it is parsed-and-ready ahead of that wiring.
     */
    reapply: z.object({
      /**
       * croner pattern for the re-apply pass (`PCT_REAPPLY_CRON`). Validated
       * here so a typo fails fast. Defaults to hourly — drift reversion is not
       * latency-critical.
       */
      cron: z
        .string()
        .min(1)
        .default("0 * * * *")
        .refine(isValidCronPattern, { message: "must be a valid cron pattern (e.g. 0 * * * *)" }),
      /**
       * Comma-separated playbook names to re-apply (`PCT_REAPPLY_PLAYBOOKS`,
       * e.g. `e2guardian.yml,activitywatch.yml`). Defaults to empty — every
       * pass is a no-op until the Phase-6 playbooks exist.
       */
      playbooks: z.preprocess(
        splitPlaybookList,
        z
          .array(
            z.string().regex(PLAYBOOK_NAME_PATTERN, {
              message: "must be a bare playbook file name (letters, digits, '.', '_', '-')",
            }),
          )
          .default([]),
      ),
    }),
    /**
     * Automatic pre-migration policy-store snapshot (#166). Before the
     * in-process migrator runs on boot (`policy/db.ts`), an existing
     * `policy.sqlite` with pending migrations is snapshotted via `VACUUM INTO`
     * so a regretted upgrade is recoverable — the automatic counterpart to the
     * manual `scripts/pct-data-backup.sh` (#120). A fresh DB (nothing yet to
     * protect) is skipped regardless.
     */
    preMigrationBackup: z.object({
      /**
       * Master switch (`PCT_PRE_MIGRATION_BACKUP`). Defaults on; an operator who
       * snapshots `/data` externally (e.g. dataset snapshots) can disable it.
       */
      enabled: z.stringbool().default(true),
      /**
       * Where snapshots are written (`PCT_PRE_MIGRATION_BACKUP_DIR`). Optional;
       * when unset, `createDb` derives `<dirname(DATABASE_URL)>/backups` (i.e.
       * the documented `/data/backups`).
       */
      dir: z.string().min(1).optional(),
      /**
       * How many snapshots to retain (`PCT_PRE_MIGRATION_BACKUP_RETAIN`); older
       * ones are pruned after each new snapshot. Defaults to 5.
       */
      retain: z.coerce.number().int().positive().default(5),
    }),
    /**
     * Phase-3 client health probe (#198): how the `GET /api/clients/health`
     * list walk bounds its live SSH fan-out (the prober is wired from buildApp
     * once the SSH key exists, #39) — like the `telemetry`/`reapply` blocks
     * above — so the page can't take ~N×`readyTimeout` once a fleet of offline
     * hosts is probed.
     */
    clientHealth: z.object({
      /**
       * Max clients probed concurrently per list pass
       * (`PCT_CLIENT_HEALTH_PROBE_CONCURRENCY`). Mirrors
       * `telemetry.pullConcurrency`; defaults to 4.
       */
      probeConcurrency: z.coerce.number().int().positive().default(4),
      /**
       * Per-list probe deadline in ms (`PCT_CLIENT_HEALTH_PROBE_DEADLINE_MS`): a
       * client that hasn't answered by then is reported un-probed so one wedged
       * host can't stall the page. `0` disables it. Defaults to 15000 (≈1.5× the
       * SSH `readyTimeout`).
       */
      probeDeadlineMs: z.coerce.number().int().nonnegative().default(15_000),
    }),
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
    serverVersion: env.PCT_SERVER_VERSION,
    protocolCompatWindow: env.PCT_PROTOCOL_COMPAT_WINDOW,
    logLevel: env.PCT_LOG_LEVEL,
    logPretty: env.PCT_LOG_PRETTY,
    trustProxy: env.PCT_TRUST_PROXY,
    secretKey: env.PCT_SECRET_KEY,
    adminUsername: env.PCT_ADMIN_USERNAME,
    adminPassword: env.PCT_ADMIN_PASSWORD,
    ansibleDir: env.PCT_ANSIBLE_DIR,
    ansibleCoreVersion: env.PCT_ANSIBLE_CORE_VERSION,
    installClientScriptPath: env.PCT_INSTALL_CLIENT_SCRIPT_PATH,
    ansiblePlaybookSourceDir: env.PCT_ANSIBLE_PLAYBOOK_SRC,
    sshPublicKeyPath: env.PCT_SSH_PUBLIC_KEY_PATH,
    sshPrivateKeyPath: env.PCT_SSH_PRIVATE_KEY_PATH,
    telemetry: {
      pullCron: env.PCT_TELEMETRY_PULL_CRON,
      pullConcurrency: env.PCT_TELEMETRY_PULL_CONCURRENCY,
    },
    enforcement: {
      cooldownSeconds: env.PCT_ENFORCEMENT_COOLDOWN_SECONDS,
      initialLookbackSeconds: env.PCT_ENFORCEMENT_INITIAL_LOOKBACK_SECONDS,
    },
    retention: {
      defaultDays: env.PCT_RETENTION_DEFAULT_DAYS,
    },
    reapply: {
      cron: env.PCT_REAPPLY_CRON,
      playbooks: env.PCT_REAPPLY_PLAYBOOKS,
    },
    preMigrationBackup: {
      enabled: env.PCT_PRE_MIGRATION_BACKUP,
      dir: env.PCT_PRE_MIGRATION_BACKUP_DIR,
      retain: env.PCT_PRE_MIGRATION_BACKUP_RETAIN,
    },
    clientHealth: {
      probeConcurrency: env.PCT_CLIENT_HEALTH_PROBE_CONCURRENCY,
      probeDeadlineMs: env.PCT_CLIENT_HEALTH_PROBE_DEADLINE_MS,
    },
    adguard: {
      mode: env.PCT_ADGUARD_MODE ?? "disabled",
      url: env.PCT_ADGUARD_URL,
      username: env.PCT_ADGUARD_USERNAME,
      passwordFile: env.PCT_ADGUARD_PASSWORD_FILE,
      apiTokenFile: env.PCT_ADGUARD_API_TOKEN_FILE,
      bindAddr: env.PCT_ADGUARD_BIND_ADDR,
      adminPort: env.PCT_ADGUARD_ADMIN_PORT,
      dataDir: env.PCT_ADGUARD_DATA_DIR,
      version: env.PCT_ADGUARD_VERSION,
    },
  });

  if (!result.success) {
    throw new SettingsError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}
