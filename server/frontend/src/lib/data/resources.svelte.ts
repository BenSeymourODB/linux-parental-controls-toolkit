/**
 * Shared, reactive list resources (groundwork for #343).
 *
 * Several admin views read the same lists — users, clients, activities — and
 * since the UI consolidation (#342) some of those views are composed together
 * (User Groups under Users, Activity Groups under Activities), so they each
 * used to fetch the same list on mount: a duplicate request, and a duplicate
 * loading/error surface that meant a single failure rendered the error twice.
 *
 * A `ListResource` is the single reactive owner of one list. Concurrent
 * `load()` calls coalesce onto one in-flight request, so two components
 * mounting together fetch once; they then read the same reactive `items` /
 * `loading` / `error`, so there is one source of truth instead of N diverging
 * copies. This also lets nested components share data without threading
 * `onchanged` callbacks up through their parents — the reason for doing it now,
 * ahead of the more deeply nested `/app` surface.
 *
 * Freshness model: `load()` re-fetches on each call unless a request is already
 * in flight — it deliberately does *not* cache indefinitely. So navigating back
 * to a view re-reads the server exactly as the old per-mount fetch did, and
 * there is no cross-view staleness to invalidate (e.g. a client created in the
 * Clients view shows up when the Links view re-mounts and reloads). Within a
 * single view, a mutation should call `set()` so sibling consumers reflect the
 * change immediately without a round-trip.
 */
import { ApiError } from "$lib/api/client.js";

export interface ListResource<T> {
  /** The loaded list, or an empty array before the first successful load. */
  readonly items: T[];
  /** True until the first load settles (resolves or fails). */
  readonly loading: boolean;
  /** The last load error as a UI-safe message, or `null`. */
  readonly error: string | null;
  /** Fetch the list, coalescing onto any in-flight request. */
  load(): Promise<void>;
  /** Replace the list in place — an optimistic update from a mutating consumer. */
  set(items: T[]): void;
  /** Drop all state (logout / test isolation). */
  reset(): void;
}

/** Render any thrown value as a UI-safe message. */
function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : "Something went wrong";
}

/**
 * Create a reactive owner for one list, fetched via `loader`. The returned
 * object exposes runes-backed getters, so any component that reads `items` /
 * `loading` / `error` updates when the shared state changes.
 */
export function createListResource<T>(loader: () => Promise<T[]>): ListResource<T> {
  let data = $state<T[] | null>(null);
  let error = $state<string | null>(null);
  // Plain (non-reactive) handle used only to coalesce concurrent loads; the
  // observable state above is what components react to.
  let inflight: Promise<void> | null = null;

  return {
    get items() {
      return data ?? [];
    },
    get loading() {
      // Purely state-derived (not tied to `inflight`) so it stays reactive: it
      // is true only until the first load settles, then false even while a
      // later refresh is in flight (stale-while-revalidate, no spinner flash).
      return data === null && error === null;
    },
    get error() {
      return error;
    },
    load() {
      if (inflight !== null) return inflight;
      error = null;
      inflight = loader()
        .then((items) => {
          data = items;
        })
        .catch((err) => {
          error = messageOf(err);
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    set(items: T[]) {
      data = items;
      error = null;
    },
    reset() {
      data = null;
      error = null;
      inflight = null;
    },
  };
}

import { listUsers } from "$lib/api/users.js";
import { listClients } from "$lib/api/clients.js";
import { listActivities } from "$lib/api/activities.js";
import type { ActivityResponse, ClientResponse, UserResponse } from "$lib/api/contract.js";

/** Supervised users — read by the Users, User Groups, Links and Add-time views. */
export const usersResource: ListResource<UserResponse> = createListResource(listUsers);
/** Enrolled clients — read by the Links and Add-time views. */
export const clientsResource: ListResource<ClientResponse> = createListResource(listClients);
/** Activities — read by the Activities and Activity Groups views. */
export const activitiesResource: ListResource<ActivityResponse> = createListResource(listActivities);

/** Reset every shared resource (call on logout, and in test `beforeEach`). */
export function resetResources(): void {
  usersResource.reset();
  clientsResource.reset();
  activitiesResource.reset();
}
