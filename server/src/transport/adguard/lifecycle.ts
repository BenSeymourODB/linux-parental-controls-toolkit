/**
 * Lifecycle state machine for the managed AdGuard Home supervisor (#96, #310).
 *
 * Makes the supervisor's implicit lifecycle explicit: the set of states, the
 * declared transitions between them, and a tiny machine that tracks the current
 * state. Extracted so the reachable states and valid transitions are obvious in
 * one place instead of being threaded through the supervisor's `#settle` calls.
 *
 * The machine is deliberately **advisory**: an undeclared transition invokes an
 * `onInvalid` callback (the supervisor logs it) but is still applied — it never
 * throws. The supervisor drives transitions from process-event callbacks
 * (`onExit` / `onError`) that run outside any `try/catch`, and `bootstrap()` is
 * contractually never-throwing, so a throw here would be unsafe.
 */

/**
 * Lifecycle state of the managed AdGuard Home process.
 *
 * - `idle` — built but not yet bootstrapped (a freshly constructed supervisor;
 *   building the app spawns nothing).
 * - `fetching` — `bootstrap()` is acquiring the binary / seeding config.
 * - `starting` — the child process is being spawned.
 * - `running` — the child is up.
 * - `stopped` — stopped on purpose (graceful shutdown).
 * - `failed` — acquisition failed, the process could not be spawned, or it
 *   exited unexpectedly too many times; `detail` says why.
 */
export type AdGuardManagedState =
  | "idle"
  | "fetching"
  | "starting"
  | "running"
  | "stopped"
  | "failed";

/**
 * Declared transitions: for each state, the states reachable from it.
 *
 * Derived from the supervisor's actual paths:
 * - `idle` → `fetching` (bootstrap) or `stopped` (stop before anything runs).
 * - `fetching` → `starting` (acquired, spawning), `failed` (acquisition failed),
 *   or `stopped` (stop landed during the fetch).
 * - `starting` → `running` (spawned) or `failed` (spawn threw synchronously).
 * - `running` → `starting` (restart after an unexpected exit), `failed` (spawn
 *   error, or the restart cap exceeded), or `stopped` (graceful stop).
 * - `stopped` → `fetching` (a later re-bootstrap).
 * - `failed` → `fetching` (re-bootstrap) or `stopped` (stop after a failure).
 */
export const STATE_TRANSITIONS: Readonly<
  Record<AdGuardManagedState, readonly AdGuardManagedState[]>
> = {
  idle: ["fetching", "stopped"],
  fetching: ["starting", "failed", "stopped"],
  starting: ["running", "failed"],
  running: ["starting", "failed", "stopped"],
  stopped: ["fetching"],
  failed: ["fetching", "stopped"],
};

/** Whether moving from `from` to `to` is a declared transition. */
export function isValidTransition(from: AdGuardManagedState, to: AdGuardManagedState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

/** Called when a transition is not in {@link STATE_TRANSITIONS}. */
export type OnInvalidTransition = (from: AdGuardManagedState, to: AdGuardManagedState) => void;

/**
 * Tracks the current lifecycle state and applies transitions.
 *
 * Advisory only (see the module doc): an undeclared transition notifies
 * `onInvalid` and is still applied; a self-transition (`from === to`) is a
 * silent no-op change. Never throws.
 */
export class LifecycleMachine {
  #state: AdGuardManagedState;

  constructor(initial: AdGuardManagedState = "idle") {
    this.#state = initial;
  }

  /** The current lifecycle state. */
  get state(): AdGuardManagedState {
    return this.#state;
  }

  /** Move to `next`, notifying `onInvalid` if the transition is undeclared. */
  transition(next: AdGuardManagedState, onInvalid?: OnInvalidTransition): void {
    const from = this.#state;
    if (from !== next && !isValidTransition(from, next)) {
      onInvalid?.(from, next);
    }
    this.#state = next;
  }
}
