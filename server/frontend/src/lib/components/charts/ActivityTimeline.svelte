<!--
  Per-activity usage timeline (#62): horizontal lanes, one per activity, showing
  when each activity was active across the window — the second of the Phase-5
  "Key derived views" (docs/architecture.md). Reads
  `GET /api/users/:id/usage/timeline` through the typed `$lib/api/usage` wrapper;
  omitting `from`/`to` defaults to the user's daily window (today).

  Browser-only and read-only — usage is derived from telemetry, never written
  from the UI. Lane labels use the activity matcher until friendlier names exist.
-->
<script lang="ts">
  import { onMount } from "svelte";

  import { ApiError } from "$lib/api/client.js";
  import type { TimelineActivity, TimelineResponse } from "$lib/api/contract.js";
  import { getTimeline, type TimelineRange } from "$lib/api/usage.js";
  import { laneSegments } from "$lib/charts/timeline.js";

  interface Props {
    /** The supervised user whose timeline to render. */
    userId: number;
    /** Optional window start (ISO-8601 UTC); defaults to today. */
    from?: string;
    /** Optional window end (ISO-8601 UTC); defaults to today. */
    to?: string;
  }
  let { userId, from, to }: Props = $props();

  let data = $state<TimelineResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // One lane per activity, with its samples projected onto the window.
  let lanes = $derived.by(() => {
    const current = data;
    if (current === null) {
      return [];
    }
    return current.activities.map((activity) => ({
      activity,
      segments: laneSegments(
        current.samples.filter((s) => s.activityId === activity.id),
        current.from,
        current.to,
      ),
    }));
  });

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const range: TimelineRange = {
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      };
      data = await getTimeline(userId, range);
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  function messageOf(err: unknown): string {
    if (err instanceof ApiError) {
      return err.message;
    }
    return err instanceof Error ? err.message : "Something went wrong";
  }

  function activityLabel(activity: TimelineActivity): string {
    return activity.matcher;
  }
</script>

<section class="timeline" aria-label="Per-activity timeline">
  {#if loading}
    <p class="status">Loading timeline…</p>
  {:else if error !== null}
    <p class="status" role="alert">{error}</p>
  {:else if data !== null}
    {#if lanes.length === 0}
      <p class="empty">No activity recorded for this period.</p>
    {:else}
      <ul class="lanes">
        {#each lanes as lane (lane.activity.id)}
          <li class="lane">
            <span class="label">{activityLabel(lane.activity)}</span>
            <span class="track" aria-hidden="true">
              {#each lane.segments as seg, i (i)}
                <span class="segment" style="left: {seg.leftPct}%; width: {seg.widthPct}%"></span>
              {/each}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .lanes {
    list-style: none;
    padding: 0;
  }
  .lane {
    display: grid;
    grid-template-columns: 8rem 1fr;
    gap: 0.5rem;
    align-items: center;
  }
  .track {
    position: relative;
    display: block;
    height: 0.75rem;
    background: #f3f4f6;
    border-radius: 0.25rem;
  }
  .segment {
    position: absolute;
    top: 0;
    height: 100%;
    background: #2563eb;
    border-radius: 0.25rem;
  }
</style>
