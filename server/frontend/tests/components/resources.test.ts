/**
 * Unit tests for the shared list-resource helper (`$lib/data/resources`).
 *
 * This is the single reactive owner that lets composed views share a list
 * without each re-fetching it (groundwork for #343). The behaviour that matters
 * for that — concurrent loads coalescing onto one request, a single
 * data/loading/error surface, optimistic `set`, and `reset` — is exercised here
 * directly against the factory, independent of any component.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createListResource } from "../../src/lib/data/resources.svelte.js";
import { ApiError } from "../../src/lib/api/client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Resolve only when the test says so, to hold two loads in flight at once. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createListResource", () => {
  it("starts empty and loading, then populates on load", async () => {
    const loader = vi.fn().mockResolvedValue([1, 2, 3]);
    const r = createListResource(loader);

    expect(r.items).toEqual([]);
    expect(r.loading).toBe(true);
    expect(r.error).toBeNull();

    await r.load();

    expect(r.items).toEqual([1, 2, 3]);
    expect(r.loading).toBe(false);
    expect(loader).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent loads onto a single request", async () => {
    const d = deferred<number[]>();
    const loader = vi.fn().mockReturnValue(d.promise);
    const r = createListResource(loader);

    const a = r.load();
    const b = r.load();
    expect(loader).toHaveBeenCalledOnce();

    d.resolve([7]);
    await Promise.all([a, b]);

    expect(r.items).toEqual([7]);
    expect(loader).toHaveBeenCalledOnce();
  });

  it("re-fetches on a fresh load once the previous one has settled", async () => {
    const loader = vi.fn().mockResolvedValueOnce([1]).mockResolvedValueOnce([1, 2]);
    const r = createListResource(loader);

    await r.load();
    await r.load();

    expect(loader).toHaveBeenCalledTimes(2);
    expect(r.items).toEqual([1, 2]);
  });

  it("captures a load error as a UI-safe message and stops loading", async () => {
    const loader = vi.fn().mockRejectedValue(new ApiError(500, "internal", "Boom."));
    const r = createListResource(loader);

    await r.load();

    expect(r.error).toBe("Boom.");
    expect(r.items).toEqual([]);
    expect(r.loading).toBe(false);
  });

  it("set() replaces the list and clears a prior error (optimistic update)", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("offline"));
    const r = createListResource(loader);
    await r.load();
    expect(r.error).toBe("offline");

    r.set([42]);

    expect(r.items).toEqual([42]);
    expect(r.error).toBeNull();
  });

  it("reset() returns to the initial empty/loading state", async () => {
    const loader = vi.fn().mockResolvedValue([1]);
    const r = createListResource(loader);
    await r.load();
    expect(r.items).toEqual([1]);

    r.reset();

    expect(r.items).toEqual([]);
    expect(r.loading).toBe(true);
    expect(r.error).toBeNull();
  });
});
