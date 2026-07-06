<!--
  Fleet-wide offline-queue summary widget (#322).

  A compact, at-a-glance panel on the admin Dashboard showing whether any
  policy-push action is stuck across the whole fleet, without having to open
  each client row. It reads the cheap `GET /api/system/queue-summary`
  aggregation once on mount (no background polling — the counts are fresh on
  dashboard load, per the issue) and renders:

    - a calm green "all delivered" state when nothing is pending or failed;
    - the pending count plus the age of the oldest pending action, so a short
      backlog is distinguishable from a stuck one;
    - a prominent red failed (dead-lettered) count whenever anything has been
      dead-lettered — never suppressed or zero-padded away;
    - a "View clients" link into the Clients view for per-client drill-down.

  Fully self-contained: it owns its own load + error state and goes through the
  typed `$lib/api` wrapper. License boundary: none — JSON API only.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type { QueueSummaryResponse } from "$lib/api/contract.js";
  import { fetchQueueSummary } from "$lib/api/system.js";

  interface Props {
    /** Jump to a section by id (wired to the shell nav) — used for "View clients". */
    onnavigate: (id: string) => void;
  }
  let { onnavigate }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let summary = $state<QueueSummaryResponse | null>(null);

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      summary = await fetchQueueSummary();
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  /** Render any thrown value as a UI-safe message. */
  function messageOf(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : "Something went wrong";
  }

  // Everything delivered: no work outstanding and nothing stuck.
  let allClear = $derived(summary !== null && summary.pending === 0 && summary.failed === 0);

  /**
   * A coarse "how long has the oldest pending action been waiting" label,
   * computed relative to render time (the summary is a point-in-time snapshot).
   * Distinguishes a fresh backlog ("just now") from a stuck one ("3h 12m").
   */
  function formatAge(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "unknown";
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      const remMinutes = minutes % 60;
      return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
</script>

<section class="queue-summary" aria-label="Transport queue summary">
  <header class="head">
    <h2>Policy push queue</h2>
    <button class="link" onclick={() => onnavigate("clients")}>View clients →</button>
  </header>

  {#if loading}
    <div class="skeleton" aria-hidden="true">
      <span class="shimmer"></span>
      <span class="shimmer"></span>
    </div>
  {:else if error}
    <p class="error" role="alert">Couldn't load queue status: {error}</p>
  {:else if summary}
    {#if allClear}
      <p class="all-clear" data-state="ok">All policy pushes delivered.</p>
    {:else}
      <ul class="stats">
        <li class="stat" class:has-failed={summary.failed > 0}>
          <span class="count" data-state={summary.failed > 0 ? "failed" : "ok"}
            >{summary.failed}</span
          >
          <span class="label">failed</span>
        </li>
        <li class="stat">
          <span class="count" data-state={summary.pending > 0 ? "pending" : "ok"}
            >{summary.pending}</span
          >
          <span class="label">pending</span>
        </li>
        {#if summary.pending > 0 && summary.oldestPendingAt}
          <li class="stat oldest">
            <span class="count age" title={summary.oldestPendingAt}
              >{formatAge(summary.oldestPendingAt)}</span
            >
            <span class="label">oldest waiting</span>
          </li>
        {/if}
      </ul>
      {#if summary.failed > 0}
        <p class="hint" role="alert">
          {summary.failed} dead-lettered action{summary.failed === 1 ? "" : "s"} need attention — open
          a client to inspect the error and re-queue or dismiss.
        </p>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .queue-summary {
    padding: 1rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    background: #f9fafb;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .head h2 {
    margin: 0;
    font-size: 1rem;
  }
  button.link {
    border: none;
    background: none;
    padding: 0;
    color: #2563eb;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .all-clear {
    margin: 0;
    color: #047857;
    font-size: 0.9rem;
    font-weight: 600;
  }
  .stats {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .count {
    font-size: 1.4rem;
    font-weight: 700;
    line-height: 1;
    color: #374151;
  }
  .count[data-state="failed"] {
    color: #b91c1c;
  }
  .count[data-state="pending"] {
    color: #b45309;
  }
  .count.age {
    font-size: 1.1rem;
  }
  .label {
    font-size: 0.8rem;
    color: #6b7280;
  }
  .hint {
    margin: 0.75rem 0 0;
    color: #b91c1c;
    font-size: 0.85rem;
  }
  .error {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border-radius: 0.4rem;
    background: #fef2f2;
    color: #b91c1c;
    font-size: 0.85rem;
  }
  .skeleton {
    display: flex;
    gap: 1.5rem;
  }
  .shimmer {
    display: block;
    width: 4rem;
    height: 2.2rem;
    border-radius: 0.4rem;
    background: linear-gradient(90deg, #eceff3 25%, #f4f6f8 37%, #eceff3 63%);
    background-size: 400% 100%;
    animation: shimmer 1.4s ease infinite;
  }
  @keyframes shimmer {
    0% {
      background-position: 100% 50%;
    }
    100% {
      background-position: 0 50%;
    }
  }
</style>
