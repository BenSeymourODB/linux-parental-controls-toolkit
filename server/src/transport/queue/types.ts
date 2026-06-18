/**
 * Shared types for the offline transport queue (#84).
 *
 * The queue persists per-client transport actions that couldn't be pushed
 * because the client was offline, and replays them on the next reachable
 * probe (`docs/architecture.md` → "Client offline at policy-change time").
 * These types are the contract between the durable {@link ./repository.ts}
 * store, the {@link ./drainer.ts} replay loop, and the {@link ./scheduler.ts}
 * croner job — plus the two injected seams (executor + probe) that keep the
 * queue decoupled from the concrete SSH/timekpra push, which lands later
 * (#83) once SSH credentials are plumbed (#39).
 *
 * License boundary: none touched — plain TypeScript over Drizzle (Apache-2.0).
 * The real action *execution* still execs over the `transport/ssh` facade
 * (subprocess boundary); this module only persists and replays the intent.
 */
import type { transportQueue } from "../../policy/schema.js";

/** A persisted `transport_queue` row (all bookkeeping columns). */
export type QueuedActionRow = typeof transportQueue.$inferSelect;

/**
 * The fields a caller supplies to enqueue (or coalesce) an action. `coalesceKey`
 * identifies the *target* a push is for: a newer action with the same
 * `(clientId, coalesceKey)` supersedes the older queued one, so the queue keeps
 * only the latest desired state per target. `kind` discriminates the payload
 * shape for the executor (e.g. `policy.push`).
 */
export interface NewQueuedAction {
  readonly clientId: number;
  readonly coalesceKey: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

/**
 * The narrowed view of a queued action handed to an {@link ActionExecutor} —
 * the identity and the replay content, without the queue's own bookkeeping
 * (status / attempts / timestamps).
 */
export type QueuedAction = Pick<
  QueuedActionRow,
  "id" | "clientId" | "coalesceKey" | "kind" | "payload"
>;

/**
 * Performs the real remote action for one queued item. Resolves on success;
 * **rejects** to signal failure. A rejection carrying a truthy `retriable`
 * property (the `transport/ssh` {@link SshError} taxonomy) means "host
 * unreachable / transient" → the item stays queued; any other rejection means
 * the command itself failed and replaying it unchanged won't help → the item
 * is dead-lettered. Injected so the queue is testable without a live client
 * and stays decoupled from the timekpra-over-SSH push (#83).
 */
export type ActionExecutor = (action: QueuedAction) => Promise<void>;

/**
 * Probes whether a client is currently reachable. The scheduler calls this
 * before draining so it doesn't attempt a push against a known-dead host (and
 * needlessly bump `attempts`). Injected for the same reason as
 * {@link ActionExecutor}.
 */
export type ReachabilityProbe = (clientId: number) => Promise<boolean>;

/** Outcome counts from draining one client's queue. */
export interface DrainSummary {
  /** Actions pushed successfully and removed from the queue. */
  readonly drained: number;
  /** Actions dead-lettered (non-retriable failure) into `failed`. */
  readonly failed: number;
  /**
   * Actions left `pending` for a later tick — the head hit a retriable error
   * (the host went offline mid-drain), so it and everything behind it wait.
   */
  readonly deferred: number;
}

/**
 * Whether a rejection from an {@link ActionExecutor} is the "retriable"
 * (host-unreachable / transient) signal. Reads the `retriable` boolean
 * structurally (via `Reflect.get`) so the queue recognises the `transport/ssh`
 * {@link SshError} taxonomy — `SshUnreachableError`/`SshExecTimeoutError` are
 * `retriable: true`; `SshCommandError`/`SshParseError` are `false` — **without**
 * importing it (no `instanceof`, no `as` cast). An error that doesn't expose
 * the flag is treated as non-retriable: replaying an unclassifiable failure
 * unchanged is unlikely to succeed, so it is dead-lettered (visible) rather
 * than retried forever (silent).
 */
export function isRetriable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return Reflect.get(error, "retriable") === true;
}

/** A human-readable, secret-free message for the queue's `last_error` column. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
