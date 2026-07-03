/**
 * Configuration for the per-user agent (#103, Phase 8b).
 *
 * The agent is one `systemd --user` process per supervised user; its config is
 * provisioned by the install script (#106) and read from the environment at
 * start. Everything external is zod-validated before it crosses into typed code
 * (`CLAUDE.md` → "Validate all external input"), the same posture as
 * `bridge/config.ts`.
 *
 * The {@link NotificationPrefs} block mirrors the server's
 * `NotificationPolicyValues` (`server/src/policy/notification.ts` /
 * `enums.ts` — `enabled`, `soundProfile` `off`/`subtle`/`prominent`,
 * `graceSeconds` 0–60, loose `cadenceOverrides`). It is redeclared here rather
 * than imported because the agent ships in the `.deb` with its own bundled Node
 * runtime and no workspace to reach `server/src` across — the same
 * generated-client shape the bridge uses for the event contract. The
 * authoritative per-user values are pushed with policy; the config carries the
 * documented defaults so the agent has a sane policy before the first pull.
 *
 * License boundary: none touched — plain TypeScript + zod (MIT).
 */
import { z } from "zod";

/** Sound themes, mirroring `server/src/policy/enums.ts` `SoundProfile`. */
export const SOUND_PROFILES = ["off", "subtle", "prominent"] as const;
export type SoundProfile = (typeof SOUND_PROFILES)[number];

/** Grace-period bounds, mirroring `server/src/policy/notification.ts`. */
export const GRACE_SECONDS_MIN = 0;
export const GRACE_SECONDS_MAX = 60;
export const DEFAULT_GRACE_SECONDS = 15;
export const DEFAULT_SOUND_PROFILE: SoundProfile = "subtle";
export const DEFAULT_NOTIFICATION_ENABLED = true;

/** How long to wait after `SIGTERM` before escalating to `SIGKILL` (doc: 5 s). */
export const DEFAULT_SIGKILL_ESCALATION_MS = 5_000;
/** Cadence tick interval — how often the agent recomputes remaining time. */
export const DEFAULT_TICK_INTERVAL_MS = 1_000;
/** Default `aw-server` REST base (loopback only; never network-exposed). */
export const DEFAULT_AW_BASE_URL = "http://127.0.0.1:5600";

/** The per-user notification preferences the agent renders under. */
export const notificationPrefsSchema = z.object({
  enabled: z.boolean().default(DEFAULT_NOTIFICATION_ENABLED),
  soundProfile: z.enum(SOUND_PROFILES).default(DEFAULT_SOUND_PROFILE),
  graceSeconds: z
    .number()
    .int()
    .min(GRACE_SECONDS_MIN)
    .max(GRACE_SECONDS_MAX)
    .default(DEFAULT_GRACE_SECONDS),
  /** Loose per-budget overrides (structured shape is #302); `null` ⇒ defaults. */
  cadenceOverrides: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

/** The documented default preferences (used until policy is pulled). */
export function defaultNotificationPrefs(): NotificationPrefs {
  return notificationPrefsSchema.parse({});
}

/** Reconnect-backoff knobs for the socket reader (mirrors `bridge/backoff.ts`). */
const backoffSchema = z.object({
  baseMs: z.number().int().positive().default(1_000),
  maxMs: z.number().int().positive().default(60_000),
});

/** The validated agent configuration. */
export const agentConfigSchema = z
  .object({
    /** The policy `User.id` this agent serves — events are addressed to it. */
    userId: z.number().int().positive(),
    /** AF_UNIX path the bridge listens on for this user (`/run/pct/<uid>.sock`). */
    socketPath: z.string().min(1),
    /** `aw-server` REST base for local usage polling. */
    awBaseUrl: z.url().default(DEFAULT_AW_BASE_URL),
    backoff: backoffSchema.default({ baseMs: 1_000, maxMs: 60_000 }),
    tickIntervalMs: z.number().int().positive().default(DEFAULT_TICK_INTERVAL_MS),
    sigkillEscalationMs: z.number().int().positive().default(DEFAULT_SIGKILL_ESCALATION_MS),
    notifications: notificationPrefsSchema.default({
      enabled: DEFAULT_NOTIFICATION_ENABLED,
      soundProfile: DEFAULT_SOUND_PROFILE,
      graceSeconds: DEFAULT_GRACE_SECONDS,
      cadenceOverrides: null,
    }),
  })
  .refine((c) => c.backoff.maxMs >= c.backoff.baseMs, {
    message: "backoff.maxMs must be >= backoff.baseMs",
    path: ["backoff", "maxMs"],
  });
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** Raised when the environment does not describe a valid {@link AgentConfig}. */
export class AgentConfigError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentConfigError";
  }
}

/**
 * Build an {@link AgentConfig} from environment variables. Required:
 * `PCT_AGENT_USER_ID` and `PCT_AGENT_SOCKET`. Optional overrides:
 * `PCT_AGENT_AW_URL`, `PCT_AGENT_TICK_MS`, `PCT_AGENT_BACKOFF_BASE_MS`,
 * `PCT_AGENT_BACKOFF_MAX_MS`, `PCT_AGENT_SIGKILL_MS`. Notification prefs default
 * to the documented values; the authoritative per-user policy is pushed later.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = agentConfigSchema.safeParse({
    userId: numberOrUndefined(env.PCT_AGENT_USER_ID),
    socketPath: env.PCT_AGENT_SOCKET,
    ...optional("awBaseUrl", env.PCT_AGENT_AW_URL),
    ...optional("tickIntervalMs", numberOrUndefined(env.PCT_AGENT_TICK_MS)),
    ...optional("sigkillEscalationMs", numberOrUndefined(env.PCT_AGENT_SIGKILL_MS)),
    backoff: {
      ...optional("baseMs", numberOrUndefined(env.PCT_AGENT_BACKOFF_BASE_MS)),
      ...optional("maxMs", numberOrUndefined(env.PCT_AGENT_BACKOFF_MAX_MS)),
    },
  });
  if (!parsed.success) {
    throw new AgentConfigError("invalid agent configuration from environment", parsed.error);
  }
  return parsed.data;
}

/** Parse a decimal env var to a number, or `undefined` if unset/blank. */
function numberOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN; // NaN → zod rejects with a clear path
}

/** Spread helper: include `{ [key]: value }` only when `value` is defined. */
function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<never, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
