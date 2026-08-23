<!--
  The /app per-child status screen (#110) — the signed-in "My time" view.

  Reads `GET /api/app/status` (PIN-scoped, own data only) through the typed
  `$lib/api/app-status` wrapper and renders, in the child's effective timezone:
  the overall time left today, a per-activity "My limits today" list, and the
  next scheduled access change. Non-punitive framing throughout
  (design/app/child-status.html, design/README.md) — this is a calm status
  glance, not a warning.

  Read-only and browser-only. Times arrive as the resolver computed them in the
  user's zone (ADR 0001): durations in seconds, the next transition as a local
  wall-clock minute-of-day; this component only formats them.

  Deferred (tracked): the "rewards" strip (recent grants) rides with the
  Phase-10 grant ledger (#113/#116/#117).
-->
<script lang="ts">
  import { onMount } from "svelte";

  import { ApiError } from "$lib/api/client.js";
  import { fetchAppStatus } from "$lib/api/app-status.js";
  import type { AppNextTransition, AppStatusResponse } from "$lib/api/contract.js";
  import { formatDuration } from "$lib/format/duration.js";

  let status = $state<AppStatusResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      status = await fetchAppStatus();
    } catch (err) {
      error =
        err instanceof ApiError
          ? "We couldn't load your time right now. Pull to refresh in a moment."
          : "Something went wrong loading your time. Try again in a moment.";
    } finally {
      loading = false;
    }
  }

  /** A local minute-of-day (`0..1440`) as a `H:MM` wall-clock string. */
  function formatClock(minuteOfDay: number): string {
    const h = Math.floor(minuteOfDay / 60) % 24;
    const m = minuteOfDay % 60;
    return `${h}:${m.toString().padStart(2, "0")}`;
  }

  /** A friendly "when" for the next transition, relative to today. */
  function whenLabel(t: AppNextTransition, today: string): string {
    const clock = formatClock(t.atMinuteOfDay);
    return t.localDate === today ? `at ${clock}` : `tomorrow at ${clock}`;
  }

  /** Percentage of a budget consumed, clamped to `[0, 100]`. */
  function usedPercent(consumed: number, allowed: number): number {
    if (allowed <= 0) {
      return 100;
    }
    return Math.max(0, Math.min(100, Math.round((consumed / allowed) * 100)));
  }

  /** Bar tone by how much is left — a gentle low/almost-gone cue, not alarm. */
  function tone(remaining: number, allowed: number): "ok" | "low" | "gone" {
    if (remaining <= 0) {
      return "gone";
    }
    if (allowed > 0 && remaining / allowed <= 0.15) {
      return "low";
    }
    return "ok";
  }
</script>

{#if loading}
  <p class="state" role="status">Loading your time…</p>
{:else if error}
  <p class="state error" role="alert">{error}</p>
{:else if status !== null}
  {@const s = status}
  <section class="status" aria-labelledby="status-title">
    <h1 id="status-title">Hi, {s.user.displayName} 👋</h1>

    <!-- Overall time left today -->
    <div class="card overall">
      {#if s.overall.remainingSeconds === null}
        <p class="big">No time limit today</p>
        <p class="muted">Enjoy — there's no overall screen-time limit set for today.</p>
      {:else}
        <p class="big">{formatDuration(s.overall.remainingSeconds)} left today</p>
        {#if s.overall.allowedSeconds !== null}
          <p class="muted">
            You've used {formatDuration(s.overall.consumedSeconds)} of
            {formatDuration(s.overall.allowedSeconds)}. Resets at midnight 🌙
          </p>
        {/if}
        <div
          class="bar tone-{tone(s.overall.remainingSeconds, s.overall.allowedSeconds ?? 0)}"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usedPercent(s.overall.consumedSeconds, s.overall.allowedSeconds ?? 0)}
          aria-label="Overall screen time used today"
        >
          <span
            style="width:{usedPercent(s.overall.consumedSeconds, s.overall.allowedSeconds ?? 0)}%"
          ></span>
        </div>
      {/if}
    </div>

    <!-- Next scheduled access change -->
    {#if !s.access.allowedNow}
      <div class="next paused">
        ⏸️
        <div>
          <strong>Screen time is paused right now</strong>
          {#if s.access.nextTransition && s.access.nextTransition.kind === "access_resumes"}
            <div class="muted small">
              It comes back {whenLabel(s.access.nextTransition, s.date)}.
            </div>
          {/if}
        </div>
      </div>
    {:else if s.access.nextTransition && s.access.nextTransition.kind === "access_ends"}
      <div class="next">
        ⏰
        <div>
          <strong>Screen time until {formatClock(s.access.nextTransition.atMinuteOfDay)}</strong>
          {#if s.access.nextTransition.localDate !== s.date}
            <div class="muted small">That's tomorrow's bedtime.</div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Per-activity limits today -->
    {#if s.activities.length > 0}
      <h2 class="section-title">My limits today</h2>
      <div class="card">
        <ul class="limits">
          {#each s.activities as a (a.scope + ":" + a.targetId)}
            <li class="limit">
              <div class="grow">
                <div class="name">{a.label}</div>
                <div
                  class="bar tone-{tone(a.remainingSeconds, a.allowedSeconds)}"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={usedPercent(a.consumedSeconds, a.allowedSeconds)}
                  aria-label="{a.label} time used today"
                >
                  <span style="width:{usedPercent(a.consumedSeconds, a.allowedSeconds)}%"></span>
                </div>
              </div>
              <div class="amount">
                <strong>{formatDuration(a.remainingSeconds)}</strong>
                <div class="muted small">of {formatDuration(a.allowedSeconds)}</div>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <p class="muted center foot">Questions about your limits? Talk to a parent 💬</p>
  </section>
{/if}

<style>
  .state {
    text-align: center;
    color: var(--muted);
    padding: 32px 8px;
  }
  .state.error {
    color: var(--red);
    font-weight: 600;
  }

  .status {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  h1 {
    margin: 4px 0 0;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 16px;
  }

  .overall {
    text-align: center;
  }

  .big {
    margin: 0;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .muted {
    color: var(--muted);
  }
  .muted.small {
    font-size: 12px;
  }
  .muted.center {
    text-align: center;
  }

  .overall .muted {
    margin: 6px 0 0;
    font-size: 13px;
  }

  .bar {
    height: 8px;
    border-radius: 999px;
    background: var(--surface-3);
    overflow: hidden;
    margin-top: 10px;
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--green);
  }
  .bar.tone-low span {
    background: var(--amber);
  }
  .bar.tone-gone span {
    background: var(--red);
  }

  .next {
    display: flex;
    gap: 10px;
    align-items: center;
    background: var(--surface-3);
    border-radius: 12px;
    padding: 12px 14px;
    font-size: 14px;
  }
  .next.paused {
    background: #fbeecb;
  }
  .next strong {
    font-weight: 600;
  }

  .section-title {
    margin: 6px 0 0;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  .limits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .limit {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 0;
    border-bottom: 1px solid var(--border);
  }
  .limit:last-child {
    border-bottom: none;
  }
  .grow {
    flex: 1;
  }
  .name {
    font-weight: 600;
    font-size: 14px;
  }
  .amount {
    text-align: right;
    white-space: nowrap;
  }
  .amount strong {
    font-size: 15px;
    font-weight: 700;
  }

  .foot {
    font-size: 11.5px;
    margin-top: 6px;
  }
</style>
