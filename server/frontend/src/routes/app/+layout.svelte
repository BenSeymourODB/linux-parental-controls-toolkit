<script lang="ts">
  // The /app PWA app shell (#109): mobile-first chrome (header + bottom tab
  // bar) that the per-child status (#110) and parent screens (#111) render
  // into. It owns the PWA wiring — manifest link, theme colour, iOS meta tags,
  // and the scoped, prod-only service-worker registration — so `/admin` (which
  // shares the root layout) stays a plain web page.
  import { onMount } from "svelte";
  import { dev } from "$app/environment";

  let { children } = $props();

  // Live connectivity, surfaced as a small banner so the shell is honest when
  // it is showing cached data offline. Defaults to `true` for the prerendered
  // HTML; corrected on mount.
  let online = $state(true);

  // The bottom tab bar is shell chrome only — the real destinations land with
  // #110 (My time) / #111 (parent). Tabs other than the active one are inert
  // until then, rather than linking to routes that don't exist yet.
  const tabs = [
    { id: "time", label: "My time", icon: "📊", active: true },
    { id: "schedule", label: "Schedule", icon: "📅", active: false },
    { id: "rewards", label: "Rewards", icon: "🎁", active: false },
  ];

  onMount(() => {
    online = navigator.onLine;
    const update = () => {
      online = navigator.onLine;
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);

    // Register the PWA service worker. Prod-only: in `vite dev` there is no
    // built worker at /service-worker.js. A failed registration must never
    // break the page — the app still works online without offline caching.
    if (!dev && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").catch(() => {
        /* offline caching unavailable; app continues online */
      });
    }

    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  });
</script>

<svelte:head>
  <title>My Time · Parental Controls</title>
  <meta
    name="description"
    content="See your screen-time limits, what you've used today, and the time you've earned."
  />
  <link rel="manifest" href="/app.webmanifest" />
  <meta name="theme-color" content="#4f46e5" />
  <link rel="apple-touch-icon" href="/app-icons/apple-touch-icon.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="My Time" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
</svelte:head>

<div class="app-shell">
  <header class="app-header">
    <span class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      My Time
    </span>
    {#if !online}
      <span class="offline" role="status">Offline · showing saved data</span>
    {/if}
  </header>

  <main class="app-main">
    {@render children()}
  </main>

  <nav class="tabbar" aria-label="Sections">
    {#each tabs as tab (tab.id)}
      {#if tab.active}
        <span class="tab active" aria-current="page">
          <span class="tab-icon" aria-hidden="true">{tab.icon}</span>
          {tab.label}
        </span>
      {:else}
        <span class="tab" aria-disabled="true" title="Coming soon">
          <span class="tab-icon" aria-hidden="true">{tab.icon}</span>
          {tab.label}
        </span>
      {/if}
    {/each}
  </nav>
</div>

<style>
  /* Design tokens (mirrors design/assets/styles.css). Declared on the shell so
     they cascade into the page content too — CSS custom properties are not
     affected by Svelte's component-scoped class rewriting. */
  .app-shell {
    --bg: #f4f5fb;
    --surface: #ffffff;
    --surface-3: #eef0f8;
    --border: #e3e6f0;
    --text: #1c2030;
    --muted: #646b85;
    --faint: #9097ad;
    --primary: #4f46e5;
    --primary-600: #4338ca;
    --green: #1f9d57;
    --amber: #c98a00;
    --red: #d4453b;
    --radius: 14px;
    --shadow: 0 1px 2px rgba(20, 24, 48, 0.06), 0 8px 24px rgba(20, 24, 48, 0.06);
    --font: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif;

    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    max-width: 480px;
    margin-inline: auto;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
  }

  .app-header {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: calc(12px + env(safe-area-inset-top)) 18px 12px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    font-weight: 700;
    font-size: 16px;
    letter-spacing: -0.01em;
  }

  .brand-mark {
    width: 22px;
    height: 22px;
    border-radius: 7px;
    background: var(--primary);
    box-shadow: inset 0 0 0 3px rgba(255, 255, 255, 0.85);
  }

  .offline {
    font-size: 12px;
    font-weight: 600;
    color: var(--amber);
    background: #fbeecb;
    border-radius: 999px;
    padding: 3px 10px;
  }

  .app-main {
    flex: 1;
    overflow-y: auto;
    padding: 16px 18px 24px;
  }

  .tabbar {
    display: flex;
    justify-content: space-around;
    gap: 4px;
    padding: 10px 8px calc(10px + env(safe-area-inset-bottom));
    background: var(--surface);
    border-top: 1px solid var(--border);
  }

  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    flex: 1;
    font-size: 11px;
    font-weight: 600;
    color: var(--faint);
    user-select: none;
  }

  .tab.active {
    color: var(--primary);
  }

  .tab[aria-disabled="true"] {
    opacity: 0.55;
    cursor: default;
  }

  .tab-icon {
    font-size: 19px;
  }
</style>
