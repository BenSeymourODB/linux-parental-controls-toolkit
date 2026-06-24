/**
 * Bridge configuration + validation (#101, Phase 8b).
 *
 * Everything the `pct-client-bridge` needs to run: where the dashboard is, the
 * per-client bearer token issued at enrolment, the directory it owns its
 * per-user sockets under, and the `policy User.id → local Linux uid` map it
 * routes events by. The config is validated with zod at startup — a daemon that
 * starts with a malformed token or user map should fail loudly, not stream into
 * the void (`CLAUDE.md` → "Validate all external input").
 *
 * The `userId → uid` map is taken as input here; **populating** it from the
 * enrolment exchange is client-install work and is intentionally out of this
 * slice (see the issue's deferred list). {@link loadConfigFromEnv} is the
 * bootstrap reader; the schema is exported so a future config-file loader can
 * reuse it.
 *
 * License boundary: none touched — plain TypeScript + zod (MIT).
 */
import { z } from "zod";

import { DEFAULT_BACKOFF } from "./backoff.js";

/** Default directory the bridge owns its per-user AF_UNIX sockets under. */
export const DEFAULT_SOCKET_DIR = "/run/pct";

/** Default mode for a per-user socket (owner read/write only). */
export const DEFAULT_SOCKET_MODE = 0o600;

/**
 * One supervised user on this client: the dashboard's policy `User.id` mapped
 * to the local Linux account the bridge forwards that user's events to.
 */
export const userMappingSchema = z.object({
  /** The dashboard policy `User.id` events are addressed to. */
  userId: z.number().int().positive(),
  /** The local Linux uid whose `pct-client-agent` receives the events. */
  linuxUid: z.number().int().nonnegative(),
});

/** A single `userId → linuxUid` mapping entry. */
export type UserMapping = z.infer<typeof userMappingSchema>;

/** Backoff bounds, mirrored from {@link DEFAULT_BACKOFF} with the same defaults. */
const backoffSchema = z
  .object({
    baseMs: z.number().int().positive(),
    maxMs: z.number().int().positive(),
  })
  .refine((b) => b.maxMs >= b.baseMs, { message: "backoff.maxMs must be >= backoff.baseMs" });

/** The validated bridge configuration. */
export const bridgeConfigSchema = z.object({
  /** Dashboard event-stream URL, e.g. `wss://dash.example/api/events/stream`. */
  serverUrl: z.url({ protocol: /^wss?$/ }),
  /** The per-client bearer token from enrolment (#77). */
  token: z.string().min(1),
  /** Directory the bridge creates its per-user sockets in. */
  socketDir: z.string().min(1).default(DEFAULT_SOCKET_DIR),
  /** Filesystem mode applied to each per-user socket. */
  socketMode: z.number().int().nonnegative().default(DEFAULT_SOCKET_MODE),
  /** The supervised users on this client (must be non-empty and uid-unique). */
  users: z
    .array(userMappingSchema)
    .min(1)
    .superRefine((users, ctx) => {
      const seenUserIds = new Set<number>();
      const seenUids = new Set<number>();
      for (const u of users) {
        if (seenUserIds.has(u.userId)) {
          ctx.addIssue({ code: "custom", message: `duplicate userId ${u.userId}` });
        }
        if (seenUids.has(u.linuxUid)) {
          ctx.addIssue({ code: "custom", message: `duplicate linuxUid ${u.linuxUid}` });
        }
        seenUserIds.add(u.userId);
        seenUids.add(u.linuxUid);
      }
    }),
  /** Reconnect backoff bounds. */
  backoff: backoffSchema.default(DEFAULT_BACKOFF),
});

/** The validated bridge configuration. */
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;

/** Raised when the environment does not yield a valid {@link BridgeConfig}. */
export class ConfigError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The AF_UNIX path the bridge listens on for a given local uid. */
export function socketPathForUid(config: BridgeConfig, linuxUid: number): string {
  // Match the documented layout: /run/pct/<linux-uid>.sock.
  const dir = config.socketDir.endsWith("/") ? config.socketDir.slice(0, -1) : config.socketDir;
  return `${dir}/${linuxUid}.sock`;
}

/** Environment variables {@link loadConfigFromEnv} reads. */
export interface BridgeEnv {
  PCT_BRIDGE_SERVER_URL?: string;
  PCT_BRIDGE_TOKEN?: string;
  PCT_BRIDGE_SOCKET_DIR?: string;
  PCT_BRIDGE_SOCKET_MODE?: string;
  /** JSON array of `{ userId, linuxUid }` objects. */
  PCT_BRIDGE_USERS?: string;
  PCT_BRIDGE_BACKOFF_BASE_MS?: string;
  PCT_BRIDGE_BACKOFF_MAX_MS?: string;
}

/**
 * Build a {@link BridgeConfig} from environment variables (the bootstrap path).
 *
 * Throws {@link ConfigError} with a readable message on any missing/invalid
 * value, including a malformed `PCT_BRIDGE_USERS` JSON document, so a
 * misconfigured unit fails its first start instead of silently doing nothing.
 */
export function loadConfigFromEnv(env: BridgeEnv = process.env): BridgeConfig {
  let users: unknown = undefined;
  if (env.PCT_BRIDGE_USERS !== undefined) {
    try {
      users = JSON.parse(env.PCT_BRIDGE_USERS);
    } catch (err) {
      throw new ConfigError("PCT_BRIDGE_USERS is not valid JSON", err);
    }
  }

  const raw = {
    serverUrl: env.PCT_BRIDGE_SERVER_URL,
    token: env.PCT_BRIDGE_TOKEN,
    socketDir: env.PCT_BRIDGE_SOCKET_DIR,
    socketMode: parseOptionalInt(env.PCT_BRIDGE_SOCKET_MODE, "PCT_BRIDGE_SOCKET_MODE"),
    users,
    backoff:
      env.PCT_BRIDGE_BACKOFF_BASE_MS !== undefined || env.PCT_BRIDGE_BACKOFF_MAX_MS !== undefined
        ? {
            baseMs: parseOptionalInt(env.PCT_BRIDGE_BACKOFF_BASE_MS, "PCT_BRIDGE_BACKOFF_BASE_MS"),
            maxMs: parseOptionalInt(env.PCT_BRIDGE_BACKOFF_MAX_MS, "PCT_BRIDGE_BACKOFF_MAX_MS"),
          }
        : undefined,
  };

  const parsed = bridgeConfigSchema.safeParse(stripUndefined(raw));
  if (!parsed.success) {
    throw new ConfigError(`invalid bridge configuration: ${parsed.error.message}`, parsed.error);
  }
  return parsed.data;
}

/** Parse an optional base-10 / 0o-prefixed integer env var, or `undefined`. */
function parseOptionalInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  // Reject empty/whitespace explicitly: `Number("")` and `Number(" ")` are 0,
  // which would silently yield an unusable socket mode (0o000) etc.
  if (value.trim() === "") {
    throw new ConfigError(`${name} is empty`);
  }
  // `Number` handles "0o600" (octal mode) and plain decimals; reject the rest.
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${name} is not a number: ${value}`);
  }
  return n;
}

/** Drop keys whose value is `undefined` so zod `.default()`s apply. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj) as [keyof T, T[keyof T]][]) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
