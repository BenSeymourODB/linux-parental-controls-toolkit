/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * Service worker for the `/app` PWA surface (#109).
 *
 * Gives `/app` an **offline-friendly app shell**: the hashed build chunks, the
 * chosen static files, and the prerendered `/app` entry page are precached on
 * install, so a launched/installed app paints instantly and survives going
 * offline. Strategy:
 *
 * - immutable assets (`build` + `files`) → **cache-first** (their URLs are
 *   content-hashed, so a cache hit is always correct);
 * - `/app` navigations → **network-first**, falling back to the cached shell
 *   when the network is unreachable;
 * - `/api/*` → **never** intercepted, so the app always sees fresh policy/state;
 * - everything else (`/`, `/admin`, …) → passed straight through to the network.
 *
 * The worker's scope is `/` (it must be, so the root-level `/_app/…` chunks
 * shared by both surfaces are cacheable), but it is only ever *registered* from
 * the `/app` layout, so visiting `/admin` alone never installs it. License
 * boundary: none — this is plain Cache/Fetch API over our own static assets.
 */
import { build, files, prerendered, version } from "$service-worker";

// `self` is a ServiceWorkerGlobalScope here; the DOM `self` typing doesn't
// apply in a worker, so narrow it once.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `pct-app-shell-${version}`;

// The prerendered `/app` shell page(s). `/admin` is deliberately excluded — it
// is not a PWA and is left to the network.
const APP_SHELL = prerendered.filter((path) => path === "/app" || path.startsWith("/app/"));

// Immutable, content-hashed assets plus the static files we want available
// offline. Stored as a Set for O(1) membership checks in the fetch handler.
const PRECACHE = [...build, ...files, ...APP_SHELL];
const PRECACHE_PATHS = new Set(PRECACHE);

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  // Drop caches from previous versions, then take control of open clients.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;

  // Never cache the JSON API — the app must always read live policy/state.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  if (PRECACHE_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirst(url.pathname, request));
    return;
  }

  const isAppNavigation =
    request.mode === "navigate" && (url.pathname === "/app" || url.pathname.startsWith("/app/"));
  if (isAppNavigation) {
    event.respondWith(networkFirstShell(request));
    return;
  }

  // Anything else (`/`, `/admin`, non-precached assets) goes to the network.
});

/** Serve an immutable asset from the cache, falling back to the network once. */
async function cacheFirst(pathname: string, request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(pathname);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(pathname, response.clone());
  return response;
}

/** Prefer the network for `/app` navigations; fall back to the cached shell. */
async function networkFirstShell(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await cache.match("/app");
    if (cached) return cached;
    throw error;
  }
}
