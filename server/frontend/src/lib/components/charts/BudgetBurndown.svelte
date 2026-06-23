<!--
  Overall-budget burndown chart (#62), the rendering half of the Phase-5
  "Key derived views" (docs/architecture.md). Reads
  `GET /api/users/:id/usage/burndown` + `…/usage/timeline` through the typed
  `$lib/api/usage` wrapper and draws remaining budget over the window with an
  ideal-pace reference line and a "now" marker, plus a per-budget consumed/allowed
  list. Today / Week / Month re-fetch the corresponding rollover window.

  The SVG is decorative (`aria-hidden`); the textual summary + per-budget list
  are the accessible surface and what the component tests assert on. Browser-only
  and read-only — usage is derived from telemetry, never written from the UI.

  Deferred (tracked): discrete grant-bump markers need the Phase-10 grant ledger.
-->
<script lang="ts">
  import { onMount } from "svelte";

  import { ApiError } from "$lib/api/client.js";
  import type {
    BudgetBurndownRow,
    BudgetWindow,
    BurndownResponse,
    TimelineResponse,
  } from "$lib/api/contract.js";
  import { getBurndown, getTimeline } from "$lib/api/usage.js";
  import { remainingSeries } from "$lib/charts/burndown.js";
  import { formatDuration } from "$lib/format/duration.js";

  interface Props {
    /** The supervised user whose usage to chart. */
    userId: number;
  }
  let { userId }: Props = $props();

  // `satisfies` keeps every value a valid `BudgetWindow`, so a renamed enum
  // member fails the build here rather than shipping a dead toggle option.
  const WINDOW_OPTIONS = [
    { value: "daily", label: "Today" },
    { value: "weekly", label: "Week" },
    { value: "monthly", label: "Month" },
  ] as const satisfies ReadonlyArray<{ value: BudgetWindow; label: string }>;

  let period = $state<BudgetWindow>("daily");
  let burndown = $state<BurndownResponse | null>(null);
  let timeline = $state<TimelineResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let overall = $derived(burndown?.budgets.find((b) => b.scope === "overall") ?? null);

  const VIEW_W = 100;
  const VIEW_H = 40;

  // The remaining-budget polyline + "now" marker, in the SVG's viewBox units.
  // `null` when there is no overall budget to burn down.
  let curve = $derived.by(() => {
    const data = burndown;
    const samples = timeline?.samples ?? [];
    if (data === null || overall === null || overall.allowedSeconds <= 0) {
      return null;
    }
    const windowStartMs = new Date(data.windowStart).getTime();
    const span = new Date(data.windowEnd).getTime() - windowStartMs;
    if (span <= 0) {
      return null;
    }
    const budget = overall.allowedSeconds;
    const points = remainingSeries(budget, samples, data.windowStart, data.windowEnd)
      .map((p) => {
        const x = ((p.t - windowStartMs) / span) * VIEW_W;
        const y = VIEW_H * (1 - p.remaining / budget);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
    const nowX = Math.max(
      0,
      Math.min(VIEW_W, ((new Date(data.now).getTime() - windowStartMs) / span) * VIEW_W),
    );
    return { points, nowX };
  });

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const data = await getBurndown(userId, period);
      burndown = data;
      // The timeline over the same window feeds the actual-remaining curve.
      timeline = await getTimeline(userId, { from: data.windowStart, to: data.windowEnd });
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  function selectWindow(value: BudgetWindow): void {
    if (value === period) {
      return;
    }
    period = value;
    void load();
  }

  function messageOf(err: unknown): string {
    if (err instanceof ApiError) {
      return err.message;
    }
    return err instanceof Error ? err.message : "Something went wrong";
  }

  /** A human label for a budget row (ids until activity names are surfaced). */
  function budgetLabel(b: BudgetBurndownRow): string {
    if (b.scope === "overall") {
      return "Overall";
    }
    const noun = b.scope === "group" ? "Group" : "Activity";
    return `${noun} #${b.targetId ?? "?"}`;
  }

  /** Consumed fraction of a budget as a clamped percentage. */
  function consumedPct(b: BudgetBurndownRow): number {
    return b.allowedSeconds <= 0 ? 0 : Math.min(100, (b.consumedSeconds / b.allowedSeconds) * 100);
  }
</script>

<section class="burndown" aria-label="Budget burndown">
  <div class="toggle" role="group" aria-label="Window">
    {#each WINDOW_OPTIONS as opt (opt.value)}
      <button type="button" aria-pressed={period === opt.value} onclick={() => selectWindow(opt.value)}>
        {opt.label}
      </button>
    {/each}
  </div>

  {#if loading}
    <p class="status">Loading usage…</p>
  {:else if error !== null}
    <p class="status" role="alert">{error}</p>
  {:else if burndown !== null}
    {#if overall !== null}
      <p class="summary">
        {formatDuration(overall.consumedSeconds)} of {formatDuration(overall.allowedSeconds)} used ·
        {formatDuration(Math.max(0, overall.allowedSeconds - overall.consumedSeconds))} remaining
      </p>
      {#if curve !== null}
        <svg
          class="chart"
          viewBox="0 0 {VIEW_W} {VIEW_H}"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line class="ideal" x1="0" y1="0" x2={VIEW_W} y2={VIEW_H} />
          <polyline class="actual" points={curve.points} fill="none" />
          <line class="now" x1={curve.nowX} y1="0" x2={curve.nowX} y2={VIEW_H} />
        </svg>
      {/if}
    {:else}
      <p class="empty">No overall budget set for this window.</p>
    {/if}

    {#if burndown.budgets.length > 0}
      <ul class="budgets">
        {#each burndown.budgets as b (b.scope + ":" + (b.targetId ?? "null"))}
          <li>
            <span class="label">{budgetLabel(b)}</span>
            <span class="bar"><span class="fill" style="width: {consumedPct(b)}%"></span></span>
            <span class="value">
              {formatDuration(b.consumedSeconds)} / {formatDuration(b.allowedSeconds)}
            </span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">No budgets defined for this window.</p>
    {/if}
  {/if}
</section>

<style>
  .toggle {
    display: inline-flex;
    gap: 0.25rem;
  }
  .toggle button[aria-pressed="true"] {
    font-weight: 600;
    text-decoration: underline;
  }
  .chart {
    display: block;
    width: 100%;
    height: 8rem;
  }
  .ideal {
    stroke: #9ca3af;
    stroke-width: 0.4;
    stroke-dasharray: 1.5 1.5;
  }
  .actual {
    stroke: #2563eb;
    stroke-width: 0.8;
  }
  .now {
    stroke: #dc2626;
    stroke-width: 0.4;
  }
  .budgets {
    list-style: none;
    padding: 0;
  }
  .budgets li {
    display: grid;
    grid-template-columns: 8rem 1fr 8rem;
    gap: 0.5rem;
    align-items: center;
  }
  .bar {
    display: block;
    height: 0.5rem;
    background: #e5e7eb;
    border-radius: 0.25rem;
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: #2563eb;
  }
  .value {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
