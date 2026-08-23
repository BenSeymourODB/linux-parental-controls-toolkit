/**
 * DNS-filtering routes (#95 status + #97 per-client blocklists): `GET /api/dns`,
 * `GET /api/dns/blocklist`, `POST /api/dns/blocklist/apply`.
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so they
 * inherit the zod validator + shared error envelope and sit behind
 * `requireAdmin` — where DNS rules end up, and pushing them, is admin-only
 * (`CLAUDE.md` → "no privileged in-process shortcuts"). Handlers stay thin: read
 * the active {@link DnsStatus}/REST client off the `app.adguard` decoration,
 * compose the plan from `app.db`, and (on apply) push it.
 *
 * License boundary: none touched here — plain TypeScript + zod + Fastify; the
 * push reaches AdGuard only through its REST client (rule 4).
 */
import type { FastifyInstance } from "fastify";

import {
  AdGuardError,
  applyDnsBlocklist,
  buildDnsBlocklistPlan,
  DEFAULT_CLIENT_PREFIX,
} from "../../transport/adguard/index.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  notApplyableDetail,
  toDnsBlocklistApplyResponse,
  toDnsBlocklistPreviewResponse,
  toDnsStatusResponse,
  type DnsBlocklistApplyResponse,
  type DnsBlocklistPreviewResponse,
  type DnsStatusResponse,
} from "./dtos.js";

/**
 * Register the DNS routes on an already-`/api`-prefixed scope. Call after
 * {@link registerAuth} so `scope.requireAdmin` is decorated; reads the `adguard`
 * service and `db` decorated onto the app in `buildApp`.
 */
export function registerDnsRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/dns",
    { preHandler: scope.requireAdmin },
    async (): Promise<DnsStatusResponse> => toDnsStatusResponse(scope.adguard.status),
  );

  typed.get(
    "/dns/blocklist",
    { preHandler: scope.requireAdmin },
    async (): Promise<DnsBlocklistPreviewResponse> => {
      // The prefix comes from the wired client when there is one; otherwise the
      // default, so a preview in `disabled` mode still shows the intended names.
      const client = scope.adguard.getClient();
      const status = scope.adguard.status;
      const clientPrefix = client?.clientPrefix ?? DEFAULT_CLIENT_PREFIX;
      const plan = buildDnsBlocklistPlan(scope.db, { clientPrefix });
      // Applyable = a REST client is wired *and* the instance is healthy; an
      // unreachable/unhealthy instance would only fail mid-push, so surface it
      // as not-applyable here rather than letting apply 500 later.
      return toDnsBlocklistPreviewResponse(status, plan, client !== null && status.health === "ok");
    },
  );

  typed.post(
    "/dns/blocklist/apply",
    { preHandler: scope.requireAdmin },
    async (): Promise<DnsBlocklistApplyResponse> => {
      const client = scope.adguard.getClient();
      const status = scope.adguard.status;
      if (client === null || status.health !== "ok") {
        throw new ApiError(
          409,
          "dns_not_applyable",
          `Cannot apply DNS blocklists: ${notApplyableDetail(status)}`,
        );
      }
      try {
        return toDnsBlocklistApplyResponse(await applyDnsBlocklist(client, scope.db));
      } catch (err) {
        // The instance was healthy at last probe but the push still failed
        // (it went away mid-apply, auth rotated, …). Map the transport error to
        // a clean 502 rather than an opaque 500.
        if (err instanceof AdGuardError) {
          throw new ApiError(
            502,
            "dns_push_failed",
            `AdGuard rejected the blocklist push: ${err.message}`,
          );
        }
        throw err;
      }
    },
  );
}
