/**
 * REST client for an AdGuard Home instance's `/control/*` API.
 *
 * The dashboard uses DNS filtering in one of three modes (`PCT_ADGUARD_MODE`):
 * `disabled`, `external` (an AdGuard the homelab already runs), or `managed`
 * (a sidecar the dashboard fetches and supervises). **This client is the single
 * code path for the two non-disabled modes** — the only difference is the base
 * URL and credentials it is constructed with; the mode plumbing/preflight (#95)
 * and the managed supervisor (#96) wire those in.
 *
 * Confinement: AdGuard Home is treated as a shared service. The dashboard owns
 * only the clients it names with a stable prefix (`pct:` by default) and never
 * touches anything else (`docs/server-deployment.md` → "What the dashboard
 * expects from an external instance"). Every client write therefore requires a
 * prefixed name and throws {@link AdGuardScopeError} *before* issuing a request
 * otherwise, so a household's own AdGuard config structurally cannot be
 * clobbered.
 *
 * License boundary: REST-only over HTTP. No AdGuard source is linked in process
 * and no GPL binary is added to the image — the integration is purely the
 * documented HTTP API (`CLAUDE.md` → "License boundaries" rule 4;
 * `docs/licensing-analysis.md`). Note that `managed` mode runs AdGuard as a
 * separate child process; the dashboard still only speaks to it over this REST
 * surface.
 */
import { z } from "zod";
import {
  AdGuardAuthError,
  AdGuardParseError,
  AdGuardRequestError,
  AdGuardScopeError,
  AdGuardUnreachableError,
} from "./errors.js";
import {
  adGuardClientsResponseSchema,
  adGuardFilteringStatusSchema,
  adGuardStatusSchema,
  type AdGuardClient,
  type AdGuardClientInput,
  type AdGuardStatus,
} from "./schemas.js";

/**
 * The minimal `fetch` surface this client uses. Deliberately structural rather
 * than the full global `typeof fetch`: the Node 22 global `fetch` satisfies it
 * in production, and a test can satisfy it with undici's `fetch` bound to a
 * `MockAgent` dispatcher — without an `as` cast on either side (`CLAUDE.md` →
 * "no unchecked `as` casts").
 */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

/**
 * Resolved credentials for the dedicated AdGuard account. The file reads that
 * produce these (`PCT_ADGUARD_PASSWORD_FILE` / `PCT_ADGUARD_API_TOKEN_FILE`)
 * stay in the config layer (#95); this client takes the resolved secret.
 *
 * - `basic` → `Authorization: Basic …`. AdGuard Home accepts HTTP Basic Auth on
 *   `/control/*`; this is the username/password the admin created in AdGuard's
 *   own UI for the dashboard.
 * - `bearer` → `Authorization: Bearer …`, for a reverse-proxy-fronted
 *   deployment or the `PCT_ADGUARD_API_TOKEN_FILE` path.
 *
 * (If a future AdGuard version drops Basic for cookie-session login, a session
 * strategy can be added here additively without changing call sites.)
 */
export type AdGuardAuth =
  | { kind: "basic"; username: string; password: string }
  | { kind: "bearer"; token: string };

/** The default namespace prefix for dashboard-owned AdGuard clients. */
export const DEFAULT_CLIENT_PREFIX = "pct:";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Options for constructing an {@link AdGuardHomeClient}. */
export interface AdGuardClientOptions {
  /** Base URL of the AdGuard Home instance, e.g. `https://adguard.lan`. A trailing slash is tolerated. */
  baseUrl: string;
  /** Credentials for the dedicated AdGuard account; omit for an unauthenticated instance. */
  auth?: AdGuardAuth;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /** `fetch` implementation to use. Defaults to the global `fetch`; injectable for tests. */
  fetch?: FetchLike;
  /** Namespace prefix every dashboard-managed client name must carry. Defaults to `pct:`. */
  clientPrefix?: string;
}

/**
 * Typed, REST-only client for AdGuard Home's status / clients / filtering
 * endpoints.
 *
 * Every JSON response is validated with a zod schema before it is returned.
 * Failures are distinguished by the error taxonomy in `./errors.ts`:
 * unreachable (feeds the external-mode preflight / retry), auth (401/403),
 * non-2xx request failure, and malformed response. Writes are confined to the
 * `pct:`-prefixed client namespace and rejected with {@link AdGuardScopeError}
 * before any request otherwise.
 */
export class AdGuardHomeClient {
  readonly #baseUrl: string;
  readonly #auth: AdGuardAuth | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #clientPrefix: string;

  constructor(options: AdGuardClientOptions) {
    // Normalize away any trailing slashes so `${baseUrl}${path}` (path starts
    // with `/control/...`) never produces a double slash.
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#auth = options.auth;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clientPrefix = options.clientPrefix ?? DEFAULT_CLIENT_PREFIX;
  }

  /** The normalized base URL this client targets. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** The namespace prefix dashboard-managed client names must carry. */
  get clientPrefix(): string {
    return this.#clientPrefix;
  }

  /** `GET /control/status` — instance identity and protection state. */
  async getStatus(): Promise<AdGuardStatus> {
    const body = await this.#getJson("/control/status");
    return this.#parse(adGuardStatusSchema, body, "/control/status");
  }

  /** `GET /control/clients` — every persistent client AdGuard has configured. */
  async listClients(): Promise<AdGuardClient[]> {
    const path = "/control/clients";
    const body = await this.#getJson(path);
    return this.#parse(adGuardClientsResponseSchema, body, path).clients;
  }

  /**
   * Persistent clients in the dashboard's `pct:` namespace only — the clients
   * this dashboard owns and may safely mutate. Foreign clients are filtered out.
   */
  async listManagedClients(): Promise<AdGuardClient[]> {
    const clients = await this.listClients();
    return clients.filter((client) => client.name.startsWith(this.#clientPrefix));
  }

  /**
   * `POST /control/clients/add` — create a dashboard-owned client. The name must
   * carry the `pct:` prefix or {@link AdGuardScopeError} is thrown before any
   * request. Returns once AdGuard answers 2xx (the body is empty).
   *
   * Not idempotent: AdGuard rejects a duplicate name with a 4xx, surfaced as
   * {@link AdGuardRequestError} (AdGuard does not use 409 for this, so the
   * generic "409 → idempotent no-op" REST convention in `docs/testing.md` does
   * not apply). The caller decides whether an "already exists" failure is benign
   * or should fall back to {@link updateClient}.
   */
  async addClient(client: AdGuardClientInput): Promise<void> {
    const path = "/control/clients/add";
    this.#assertManaged(client.name, path);
    await this.#postOk(path, client);
  }

  /**
   * `POST /control/clients/update` — replace a dashboard-owned client's config.
   * Both the existing `name` and the (possibly renamed) `data.name` must carry
   * the prefix, so neither a foreign client is edited nor a managed one is
   * renamed out of the namespace. The guard relies on AdGuard keying the target
   * by the top-level `name` (the existing client) and adopting `data.name` as
   * the new name — the only identity fields in the documented request shape.
   */
  async updateClient(name: string, data: AdGuardClientInput): Promise<void> {
    const path = "/control/clients/update";
    this.#assertManaged(name, path);
    this.#assertManaged(data.name, path);
    await this.#postOk(path, { name, data });
  }

  /**
   * `POST /control/clients/delete` — remove a dashboard-owned client. The name
   * must carry the prefix or {@link AdGuardScopeError} is thrown before any
   * request, so a household's own clients can never be deleted.
   */
  async deleteClient(name: string): Promise<void> {
    const path = "/control/clients/delete";
    this.#assertManaged(name, path);
    await this.#postOk(path, { name });
  }

  /**
   * `GET /control/filtering/status` → the global custom-rules list
   * (`user_rules`). The per-client blocklist composition that decides *which*
   * rules the dashboard owns (and preserves foreign rules on write) is #97; this
   * is the building block it reads.
   */
  async getUserRules(): Promise<string[]> {
    const path = "/control/filtering/status";
    const body = await this.#getJson(path);
    return this.#parse(adGuardFilteringStatusSchema, body, path).user_rules;
  }

  /**
   * `POST /control/filtering/set_rules` — replace the global custom-rules list.
   *
   * AdGuard has no per-client rule list, so this writes the **whole**
   * `user_rules` set and is **deliberately unconfined** — unlike the client
   * writes there is no `pct:` guard, because there is no per-rule owner to key
   * on. Callers must therefore only ever pass a list derived from a fresh
   * {@link getUserRules} read with the dashboard's own rules swapped in, so a
   * household's hand-written global rules are preserved. That read-modify-write
   * confinement (and the marker that identifies dashboard-owned rules) lands
   * with the per-client blocklist feature (#97); this is only the raw write.
   */
  async setUserRules(rules: readonly string[]): Promise<void> {
    await this.#postOk("/control/filtering/set_rules", { rules: [...rules] });
  }

  /** Throw {@link AdGuardScopeError} if `name` is outside the managed namespace. */
  #assertManaged(name: string, path: string): void {
    if (!name.startsWith(this.#clientPrefix)) {
      throw new AdGuardScopeError(this.#baseUrl, path, name, this.#clientPrefix);
    }
  }

  /** The `Authorization` header for the configured credentials, if any. */
  #authHeader(): Record<string, string> {
    if (this.#auth === undefined) return {};
    if (this.#auth.kind === "bearer") {
      return { authorization: `Bearer ${this.#auth.token}` };
    }
    const encoded = Buffer.from(`${this.#auth.username}:${this.#auth.password}`).toString("base64");
    return { authorization: `Basic ${encoded}` };
  }

  /**
   * Issue a GET and return the parsed JSON body, mapping every failure to the
   * error taxonomy: a thrown `fetch` (connection error / abort timeout) →
   * unreachable; 401/403 → auth; other non-2xx → request error; a non-JSON body
   * → parse error.
   */
  async #getJson(path: string): Promise<unknown> {
    const response = await this.#send(path, "GET");
    this.#assertOk(response, path);
    return this.#readJson(response, path);
  }

  /**
   * Issue a POST with a JSON body and assert a 2xx. AdGuard's mutating
   * `/control/*` endpoints answer 200 with an empty body, so there is nothing to
   * parse — we only classify failure.
   */
  async #postOk(path: string, body: unknown): Promise<void> {
    const response = await this.#send(path, "POST", JSON.stringify(body));
    this.#assertOk(response, path);
  }

  /** Perform the `fetch`, mapping a thrown request to {@link AdGuardUnreachableError}. */
  async #send(
    path: string,
    method: "GET" | "POST",
    body?: string,
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    const headers: Record<string, string> = { accept: "application/json", ...this.#authHeader() };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new AdGuardUnreachableError(this.#baseUrl, path, cause, isTimeout(cause));
    }
  }

  /** Map a non-2xx status to {@link AdGuardAuthError} (401/403) or {@link AdGuardRequestError}. */
  #assertOk(response: Awaited<ReturnType<FetchLike>>, path: string): void {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new AdGuardAuthError(this.#baseUrl, path, response.status, response.statusText);
    }
    throw new AdGuardRequestError(this.#baseUrl, path, response.status, response.statusText);
  }

  /** Parse a 2xx body as JSON, mapping a non-JSON body to {@link AdGuardParseError}. */
  async #readJson(response: Awaited<ReturnType<FetchLike>>, path: string): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch (cause) {
      throw new AdGuardParseError(
        this.#baseUrl,
        path,
        cause instanceof Error ? cause.message : "response body was not valid JSON",
      );
    }
  }

  /** Validate a body against `schema`, throwing a parse error on mismatch. */
  #parse<T>(schema: z.ZodType<T>, body: unknown, path: string): T {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new AdGuardParseError(this.#baseUrl, path, z.prettifyError(result.error), result.error);
    }
    return result.data;
  }
}

/**
 * Whether a thrown `fetch` error is the per-request abort timeout.
 * `AbortSignal.timeout` rejects with a `TimeoutError`; a manual abort yields an
 * `AbortError`. Both are name-tagged on the thrown `DOMException`/`Error`.
 */
function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}
