/**
 * AdGuard mode router + external-mode startup preflight (#95).
 *
 * Wires `PCT_ADGUARD_MODE` into runtime behaviour on top of the validated
 * config (`src/config.ts`) and the REST client (`./client.ts`):
 *
 * - **`disabled`** (default) — inert. No client, no network, health is
 *   `not_applicable`.
 * - **`external`** — builds the {@link AdGuardHomeClient} (resolving credentials
 *   from the configured secret files) and runs a startup {@link runPreflight}
 *   that probes `GET /control/status`, records the health, and **logs loudly**
 *   on failure. Per `docs/server-deployment.md` → "First-run setup" the preflight
 *   does **not** exit the process: the dashboard "starts anyway with the affected
 *   feature disabled and surfaces an error in the admin UI", so "fail loudly" is
 *   a prominent error log plus the unhealthy {@link DnsStatus} surfaced on
 *   `GET /api/dns`.
 * - **`managed`** — mode routed only. Bringing the supervised instance up and
 *   health-checking it is the managed-mode supervisor's job (#96); until that
 *   lands there is no client and health is `unknown`.
 *
 * The active {@link DnsStatus} is read by the API surface so the admin UI can
 * display where DNS rules end up.
 *
 * License boundary: REST-only over HTTP, no AdGuard code linked in-process
 * (`CLAUDE.md` → "License boundaries" rule 4; `docs/licensing-analysis.md`).
 */
import type { Settings } from "../../config.js";
import { AdGuardHomeClient, type FetchLike } from "./client.js";
import { AdGuardAuthError, AdGuardUnreachableError } from "./errors.js";
import {
  resolveAdGuardAuth,
  type ExternalAdGuardSettings,
  type ReadSecretFile,
} from "./secrets.js";

/** The configured DNS-filtering mode. Mirrors `PCT_ADGUARD_MODE`. */
export type DnsMode = "disabled" | "external" | "managed";

/**
 * Health of the configured DNS integration, as last observed.
 *
 * - `not_applicable` — `disabled` mode; there is nothing to be healthy.
 * - `unknown` — not yet probed (`external` before its preflight) or not yet
 *   owned by code (`managed`, pending the #96 supervisor).
 * - `ok` — `external` instance reachable, authenticated, and running.
 * - `unreachable` — the request never produced a response (down / timeout).
 * - `auth_failed` — a 401/403; the dedicated account's credentials are wrong.
 * - `unhealthy` — reachable and authenticated, but AdGuard reports not running.
 * - `error` — any other failure (malformed response, non-2xx, or a credential
 *   file that could not be read).
 */
export type DnsHealth =
  | "not_applicable"
  | "unknown"
  | "ok"
  | "unreachable"
  | "auth_failed"
  | "unhealthy"
  | "error";

/** An immutable snapshot of the DNS integration's mode + last-observed health. */
export interface DnsStatus {
  /** The configured mode. */
  readonly mode: DnsMode;
  /** Whether a REST client is wired for this mode (true only for `external`). */
  readonly configured: boolean;
  /** Health as last observed (see {@link DnsHealth}). */
  readonly health: DnsHealth;
  /** Base URL the dashboard targets, or `null` when no client is wired. */
  readonly baseUrl: string | null;
  /** ISO-8601 timestamp of the last preflight, or `null` if never run. */
  readonly checkedAt: string | null;
  /** Human-readable reason when health is not `ok`, else `null`. */
  readonly detail: string | null;
}

/**
 * The minimal logger surface {@link AdGuardService.runPreflight} uses for its
 * loud-on-failure logging. Structural so Fastify's `app.log` (pino) satisfies
 * it without a cast, and a test can pass a recording fake.
 */
export interface PreflightLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Injectable seams for {@link AdGuardService} (tests supply fakes). */
export interface AdGuardServiceDeps {
  /** `fetch` for the REST client; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Credential-file reader; defaults to reading from disk. */
  readSecretFile?: ReadSecretFile;
  /** Clock for `checkedAt`; defaults to `() => new Date()`. */
  now?: () => Date;
}

function initialStatus(adguard: Settings["adguard"]): DnsStatus {
  switch (adguard.mode) {
    case "disabled":
      return {
        mode: "disabled",
        configured: false,
        health: "not_applicable",
        baseUrl: null,
        checkedAt: null,
        detail: null,
      };
    case "external":
      return {
        mode: "external",
        configured: true,
        health: "unknown",
        baseUrl: adguard.url,
        checkedAt: null,
        detail: "preflight not yet run",
      };
    case "managed":
      return {
        mode: "managed",
        configured: false,
        health: "unknown",
        baseUrl: null,
        checkedAt: null,
        detail: "managed-mode supervisor not yet available (#96)",
      };
  }
}

/** Map a thrown preflight error to the health it represents. */
function classifyError(err: unknown): DnsHealth {
  // AdGuardAuthError extends AdGuardRequestError, so test it first.
  if (err instanceof AdGuardAuthError) return "auth_failed";
  if (err instanceof AdGuardUnreachableError) return "unreachable";
  // Request failure (non-2xx), malformed response, or a credential-file read
  // failure (AdGuardConfigError) — all "the integration is misconfigured/broken".
  return "error";
}

/**
 * Routes the active AdGuard mode and holds the last-observed {@link DnsStatus}.
 * Construct via {@link createAdGuardService}; build once per app and decorate it
 * onto Fastify so routes and (later) producers read the same instance.
 */
export class AdGuardService {
  readonly #adguard: Settings["adguard"];
  readonly #deps: AdGuardServiceDeps;
  #client: AdGuardHomeClient | null = null;
  #status: DnsStatus;

  constructor(adguard: Settings["adguard"], deps: AdGuardServiceDeps = {}) {
    this.#adguard = adguard;
    this.#deps = deps;
    this.#status = initialStatus(adguard);
  }

  /** The configured mode. */
  get mode(): DnsMode {
    return this.#adguard.mode;
  }

  /** An immutable snapshot of the current status. */
  get status(): DnsStatus {
    return { ...this.#status };
  }

  /**
   * The REST client for this mode, or `null` when none is wired (`disabled`
   * always; `managed` until #96; `external` before the first {@link runPreflight}
   * builds it). The per-client blocklist feature (#97) consumes this.
   */
  getClient(): AdGuardHomeClient | null {
    return this.#client;
  }

  /**
   * Probe the configured external instance and record the result. A no-op
   * (returns the current status unchanged) for `disabled`/`managed`, so it is
   * safe to call unconditionally on startup.
   *
   * Never throws: every failure is caught, mapped to a {@link DnsHealth}, logged
   * at `error` level, and surfaced via {@link status} — startup is not blocked.
   */
  async runPreflight(logger?: PreflightLogger): Promise<DnsStatus> {
    const adguard = this.#adguard;
    if (adguard.mode !== "external") return this.status;

    const now = this.#deps.now ?? (() => new Date());
    const at = now().toISOString();
    try {
      const client = await this.#ensureClient(adguard);
      const { running } = await client.getStatus();
      if (running) {
        this.#status = {
          mode: "external",
          configured: true,
          health: "ok",
          baseUrl: adguard.url,
          checkedAt: at,
          detail: null,
        };
        logger?.info(
          { event: "adguard_preflight", health: "ok", baseUrl: adguard.url },
          "AdGuard Home preflight: reachable and running",
        );
      } else {
        const detail = "AdGuard Home is reachable but reports it is not running";
        this.#status = {
          mode: "external",
          configured: true,
          health: "unhealthy",
          baseUrl: adguard.url,
          checkedAt: at,
          detail,
        };
        logger?.error(
          { event: "adguard_preflight", health: "unhealthy", baseUrl: adguard.url },
          detail,
        );
      }
    } catch (err) {
      const health = classifyError(err);
      const detail = err instanceof Error ? err.message : String(err);
      this.#status = {
        mode: "external",
        configured: true,
        health,
        baseUrl: adguard.url,
        checkedAt: at,
        detail,
      };
      logger?.error(
        { event: "adguard_preflight", health, baseUrl: adguard.url, err },
        `AdGuard Home preflight failed (${health}): ${detail}`,
      );
    }
    return this.status;
  }

  /**
   * Build the REST client once (lazily), resolving credentials on first use.
   *
   * Credentials are captured at first successful build and cached for the
   * service's lifetime, so a rotated `PCT_ADGUARD_*_FILE` is only picked up on
   * process restart — there is no live secret reload here. (A *failed*
   * resolution is not cached: the throw precedes the assignment, so the next
   * preflight retries the read.) The ongoing-use consumer (#97) inherits this.
   */
  async #ensureClient(adguard: ExternalAdGuardSettings): Promise<AdGuardHomeClient> {
    if (this.#client !== null) return this.#client;
    const auth = await resolveAdGuardAuth(adguard, {
      ...(this.#deps.readSecretFile !== undefined
        ? { readSecretFile: this.#deps.readSecretFile }
        : {}),
    });
    this.#client = new AdGuardHomeClient({
      baseUrl: adguard.url,
      ...(auth !== undefined ? { auth } : {}),
      ...(this.#deps.fetch !== undefined ? { fetch: this.#deps.fetch } : {}),
    });
    return this.#client;
  }
}

/** Build the {@link AdGuardService} for the configured mode. */
export function createAdGuardService(
  adguard: Settings["adguard"],
  deps: AdGuardServiceDeps = {},
): AdGuardService {
  return new AdGuardService(adguard, deps);
}
