<!--
  "Add time today" lever (#257), extracted from LinksView so it can live on the
  Dashboard where it is easy to find — it was previously buried at the bottom of
  the per-user "User ↔ Client links" editor.

  A same-day remaining-time nudge applied to every client the chosen user is
  linked to. Not a Grant — see the caveat in the UI. The component is fully
  self-contained: it owns its user dropdown and loads the users + clients lists
  itself (clients only to label the per-client results), so it can be dropped
  into any view. All calls go through the typed `$lib/api/*` wrappers; errors
  are surfaced inline.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type { ClientResponse, TimeTodayResponse, UserResponse } from "$lib/api/contract.js";
  import { listUsers } from "$lib/api/users.js";
  import { listClients } from "$lib/api/clients.js";
  import { adjustTimeToday } from "$lib/api/time-today.js";

  let users = $state<UserResponse[]>([]);
  let clients = $state<ClientResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // The user the adjustment targets.
  let selectedUserId = $state<number | null>(null);

  let adjusting = $state(false);
  let adjustError = $state<string | null>(null);
  let adjustResult = $state<TimeTodayResponse | null>(null);
  let customMinutes = $state("");

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      [users, clients] = await Promise.all([listUsers(), listClients()]);
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  function clientName(id: number): string {
    return clients.find((c) => c.id === id)?.hostname ?? `Client ${id}`;
  }

  /** Clear any prior result when the target user changes. */
  function onSelectUser(): void {
    adjustResult = null;
    adjustError = null;
    customMinutes = "";
  }

  /**
   * Apply a same-day time adjustment (in minutes) to every client the selected
   * user is linked to. A positive value adds time, a negative value takes it
   * back; the server records the `--settimeleft` command in the audit log.
   * Online-only — the result lists each client's applied/unreachable/failed
   * outcome.
   */
  async function addTimeToday(minutes: number): Promise<void> {
    if (selectedUserId === null || minutes === 0 || !Number.isFinite(minutes)) {
      return;
    }
    adjusting = true;
    adjustError = null;
    adjustResult = null;
    try {
      adjustResult = await adjustTimeToday(selectedUserId, {
        deltaSeconds: Math.round(minutes * 60),
      });
    } catch (err) {
      adjustError = messageOf(err);
    } finally {
      adjusting = false;
    }
  }

  /** Apply the custom-minutes field, then clear it. */
  async function addCustomMinutes(): Promise<void> {
    const minutes = Number(customMinutes);
    if (!Number.isFinite(minutes) || minutes === 0) {
      adjustError = "Enter a non-zero number of minutes";
      return;
    }
    await addTimeToday(minutes);
    customMinutes = "";
  }

  /** Render any thrown value as a UI-safe message. */
  function messageOf(err: unknown): string {
    if (err instanceof ApiError) {
      return err.message;
    }
    return err instanceof Error ? err.message : "Something went wrong";
  }
</script>

<section class="add-time" aria-label="Add time today">
  <header class="head">
    <h2>Add time today</h2>
    <p class="caveat">
      A one-off adjustment to a user's <strong>remaining time today</strong> on
      every linked client — it does not change their standing daily limit and is
      forgotten at the next daily rollover. This is <strong>not</strong> a logged
      reward grant (that's coming later); the change takes effect on the client
      when it's online.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if users.length === 0}
    <p class="muted">Add a user first — there's nobody to adjust time for yet.</p>
  {:else}
    <div class="picker">
      <label for="add-time-user">User</label>
      <select id="add-time-user" bind:value={selectedUserId} onchange={onSelectUser}>
        <option value={null} disabled selected>Choose a user…</option>
        {#each users as user (user.id)}
          <option value={user.id}>{user.displayName}</option>
        {/each}
      </select>
    </div>

    {#if selectedUserId !== null}
      <div class="add-time-controls">
        <button class="grant" disabled={adjusting} onclick={() => addTimeToday(15)}>+15 min</button>
        <button class="grant" disabled={adjusting} onclick={() => addTimeToday(30)}>+30 min</button>
        <span class="custom">
          <input
            type="number"
            inputmode="numeric"
            step="1"
            placeholder="minutes (± )"
            bind:value={customMinutes}
            disabled={adjusting}
            aria-label="Custom minutes (negative to remove time)"
          />
          <button class="ghost" disabled={adjusting} onclick={addCustomMinutes}>
            {adjusting ? "Applying…" : "Apply"}
          </button>
        </span>
      </div>

      {#if adjustError}
        <p class="error" role="alert">{adjustError}</p>
      {/if}

      {#if adjustResult}
        <ul class="results" aria-label="Adjustment results">
          {#each adjustResult.results as r (r.clientId)}
            <li class={`result result-${r.status}`}>
              <span class="result-client">{clientName(r.clientId)}</span>
              <span class="result-status">{r.status}</span>
              {#if r.error}<span class="result-error">{r.error}</span>{/if}
            </li>
          {/each}
          {#if adjustResult.results.length === 0}
            <li class="muted">No linked clients were affected.</li>
          {/if}
        </ul>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .add-time {
    padding: 1rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    background: #f9fafb;
  }
  .add-time h2 {
    margin: 0 0 0.4rem;
    font-size: 1rem;
  }
  .caveat {
    margin: 0 0 0.75rem;
    color: #6b7280;
    font-size: 0.85rem;
    max-width: 40rem;
  }
  .picker {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .picker label {
    font-size: 0.9rem;
    color: #374151;
    font-weight: 600;
  }
  .picker select {
    flex: 0 1 18rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    background: #fff;
  }
  .add-time-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .custom {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .custom input {
    width: 9rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
  }
  button {
    padding: 0.4rem 0.7rem;
    border: none;
    border-radius: 0.4rem;
    background: #2563eb;
    color: #fff;
    cursor: pointer;
    font-size: 0.85rem;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  button.ghost {
    background: #e5e7eb;
    color: #374151;
  }
  button.grant {
    background: #047857;
  }
  .results {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .result {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .result-status {
    font-weight: 600;
    text-transform: capitalize;
  }
  .result-applied .result-status {
    color: #047857;
  }
  .result-unreachable .result-status {
    color: #b45309;
  }
  .result-failed .result-status {
    color: #b91c1c;
  }
  .result-error {
    color: #6b7280;
  }
  .muted {
    color: #6b7280;
  }
  .error {
    margin: 0 0 1rem;
    padding: 0.5rem 0.6rem;
    border-radius: 0.4rem;
    background: #fef2f2;
    color: #b91c1c;
    font-size: 0.85rem;
  }
</style>
