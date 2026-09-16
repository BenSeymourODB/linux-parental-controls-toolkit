/**
 * Client capability vocabulary and the frame → capability gate (ADR 0007 §4).
 *
 * Additive evolution of the event stream rides on `capabilities`, not on the
 * `eventProtocol` version window: the server "only sends a frame type a client
 * advertised support for; an older client simply never receives a frame it
 * couldn't handle, and is **not** refused for it." A client advertises which
 * enforcement primitives it supports in its `hello` (`events/protocol.ts`), and
 * this module answers the one question the {@link ../events/hub.ts EventHub}
 * asks on every publish: *does this event require a capability, and if so which
 * one?*
 *
 * Isolated here — pure, I/O-free, mirroring `events/protocol.ts` — so the gate
 * is a single, exhaustively-typed decision the fan-out routes through, and so a
 * new frame type cannot be added without declaring whether it is gated.
 *
 * License boundary: none touched — plain TypeScript.
 */
import type { ServerEvent } from "./taxonomy.js";

/**
 * The capability flags a client can advertise in its `hello` (ADR 0007 §4).
 * These are the additive feature flags naming the optional enforcement
 * primitives a client supports; adding one is never a breaking change.
 *
 * Only the two primitives with frame producers today are named. The ADR also
 * anticipates `applocker_deny` (AppArmor per-app deny, Phase 6) and
 * `dns_filter` (Phase 7); they gain a constant here the moment their frame
 * types join the taxonomy — the exhaustiveness check in
 * {@link capabilityForEvent} forces exactly that.
 */
export const CLIENT_CAPABILITIES = {
  /** Per-app / app-group process force-close (`enforce.force_close`). */
  perAppClose: "per_app_close",
  /**
   * Overall session-budget enforcement — lock on exhaustion
   * (`enforce.session_lock`) and unlock on a restoring grant
   * (`lockout.cleared`).
   */
  sessionBudget: "session_budget",
} as const;

/** A capability string the server knows how to gate on. */
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[keyof typeof CLIENT_CAPABILITIES];

/**
 * One entry in the admin-facing capability catalogue: a known capability, its
 * human label, and a one-line description of the enforcement primitive it
 * names.
 */
export interface ClientCapabilityDescriptor {
  /** The capability id a client advertises in its `hello` (a {@link ClientCapability}). */
  capability: ClientCapability;
  /** Short admin-facing label for the Clients view. */
  label: string;
  /** One-line explanation of the primitive the capability gates. */
  description: string;
}

/**
 * The ordered, admin-facing catalogue of every capability the server knows
 * about — the single source of the UI labels for the per-client capability
 * matrix (#400). The server owns these labels (the same "server classifies,
 * frontend renders" split as {@link ../api/clients/version-status.ts}) so the
 * vocabulary stays single-sourced with {@link CLIENT_CAPABILITIES}, and a
 * future Windows client's greyed-out controls come straight from here rather
 * than a hand-mirrored frontend list (`docs/windows-client-support.md` →
 * "Modularity tweaks").
 *
 * Every {@link CLIENT_CAPABILITIES} value must appear exactly once; a unit test
 * (`tests/events/capabilities.test.ts`) pins that so a new capability can't be
 * added to the vocabulary without giving it a catalogue label.
 */
export const CLIENT_CAPABILITY_CATALOG: readonly ClientCapabilityDescriptor[] = [
  {
    capability: CLIENT_CAPABILITIES.perAppClose,
    label: "Per-app force-close",
    description: "Kills an app or app-group's processes when its per-activity quota is exhausted.",
  },
  {
    capability: CLIENT_CAPABILITIES.sessionBudget,
    label: "Session budget",
    description:
      "Locks the session when the overall screen-time budget runs out, and unlocks on a restoring grant.",
  },
];

/**
 * The capability a client must have advertised to be sent `event`, or `null`
 * for a **baseline** frame every client receives.
 *
 * Exhaustive over the event taxonomy: the `default` branch narrows `event` to
 * `never`, so adding a new `ServerEvent` type is a compile error until its gate
 * is declared here — a frame can never silently reach clients that can't honour
 * it, nor be silently withheld from ones that can.
 *
 * - `enforce.force_close` → `per_app_close` (the agent kills the app's
 *   processes; a client without per-app close can't act on it).
 * - `enforce.session_lock` / `lockout.cleared` → `session_budget` (both concern
 *   the overall-screen-time lock a session-budget client owns).
 * - `grant.applied` / `policy.changed` → `null`: informational nudges every
 *   client re-renders regardless of its enforcement primitives.
 */
export function capabilityForEvent(event: ServerEvent): ClientCapability | null {
  switch (event.type) {
    case "enforce.force_close":
      return CLIENT_CAPABILITIES.perAppClose;
    case "enforce.session_lock":
    case "lockout.cleared":
      return CLIENT_CAPABILITIES.sessionBudget;
    case "grant.applied":
    case "policy.changed":
      return null;
    default:
      return assertExhaustive(event);
  }
}

/**
 * Compile-time exhaustiveness guard: reachable only if a `ServerEvent` variant
 * is left unhandled above, which is then a type error. Throws defensively if a
 * value outside the (zod-validated) taxonomy ever reaches it at runtime.
 */
function assertExhaustive(event: never): never {
  throw new Error(`unhandled server event: ${JSON.stringify(event)}`);
}
