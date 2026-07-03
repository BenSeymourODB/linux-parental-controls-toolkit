/**
 * Local usage source for the per-user agent (#103, Phase 8b).
 *
 * `docs/client-notifications.md` → Components/2: the agent "Polls `aw-server` on
 * `localhost:5600` for current usage so it can render warnings locally without
 * round-tripping the server", combining that with the server-pushed budget
 * totals to compute time remaining even while briefly offline. This module is
 * the poll side: a {@link UsageSource} the tick loop reads used-seconds from.
 *
 * ActivityWatch is reached **over its REST API only** (`CLAUDE.md` → rule 4) —
 * here the query2 endpoint (`POST /api/0/query/`) summing the not-afk durations
 * of the local afk watcher for the current day. The response is zod-validated
 * before it crosses into typed code. An unreachable/erroring `aw-server` yields
 * an empty map (a documented degraded mode: the agent keeps warning on the last
 * cached figures), never a throw.
 *
 * **Overall only, for now.** This returns used-seconds for the `overall`
 * screen-time budget (whole-session active time). Per-activity usage needs the
 * activity matchers the server pushes to the client, which is not yet built —
 * so per-activity budgets have no local usage here and read as full until that
 * lands (the same follow-up that wires force-close PID resolution).
 *
 * License boundary: none touched — `aw-server` REST via an injected `fetch`.
 */
import { z } from "zod";

import type { Logger } from "../bridge/logger.js";
import { OVERALL_BUDGET_KEY } from "./budget.js";

/** Used-seconds per {@link ../agent/budget.js budgetKey}, read each tick. */
export interface UsageSource {
  usedSeconds(): Promise<Map<string, number>>;
}

/** The minimal slice of `fetch` this module uses (injectable in tests). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The query2 response: one summed-duration number per requested timeperiod. */
const queryResponseSchema = z.array(z.number());

/** Options for an {@link AwUsageSource}. */
export interface AwUsageSourceOptions {
  /** `aw-server` REST base, e.g. `http://127.0.0.1:5600`. */
  baseUrl: string;
  /** Injectable `fetch` (defaults to the global). */
  fetchFn?: FetchLike;
  /** Injectable clock for the day window (defaults to `() => new Date()`). */
  now?: () => Date;
  logger?: Logger;
}

/**
 * A {@link UsageSource} backed by `aw-server`'s query2 API: it sums the local
 * afk watcher's `not-afk` durations for the current local day into the
 * `overall` budget's used-seconds.
 */
export class AwUsageSource implements UsageSource {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #logger: Logger | undefined;

  constructor(options: AwUsageSourceOptions) {
    this.#baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl.slice(0, -1) : options.baseUrl;
    this.#fetch = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
  }

  async usedSeconds(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/0/query/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeperiods: [dayTimeperiod(this.#now())],
          query: [OVERALL_ACTIVE_QUERY],
        }),
      });
      if (!response.ok) {
        this.#logger?.warn({ status: response.status }, "aw-server query returned non-2xx");
        return result;
      }
      const parsed = queryResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        this.#logger?.warn({ err: parsed.error }, "aw-server query response failed validation");
        return result;
      }
      const seconds = parsed.data[0];
      if (seconds !== undefined) result.set(OVERALL_BUDGET_KEY, Math.max(0, Math.floor(seconds)));
    } catch (err) {
      // Unreachable aw-server is a normal transient (boot ordering, restart):
      // keep the agent on its last cached figures rather than throwing.
      this.#logger?.warn({ err }, "aw-server unreachable; using cached usage");
    }
    return result;
  }
}

/**
 * The query2 program summing today's not-afk durations. `find_bucket` matches
 * the local afk watcher by prefix so no hostname discovery is needed.
 */
const OVERALL_ACTIVE_QUERY = [
  "afk = query_bucket(find_bucket('aw-watcher-afk_'));",
  "not_afk = filter_keyvals(afk, 'status', ['not-afk']);",
  "RETURN = sum_durations(not_afk);",
].join(" ");

/** The `start/end` ISO timeperiod for the local calendar day containing `at`. */
export function dayTimeperiod(at: Date): string {
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return `${start.toISOString()}/${end.toISOString()}`;
}
