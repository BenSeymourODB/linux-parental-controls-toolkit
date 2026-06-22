<!--
  Budgets editor (#189): repeats the Users/Activities pattern (#53). Loads
  `/api/budgets` plus the users / activities / activity-groups it needs to
  render and pick targets, all on mount (browser only — the page is prerendered
  to a static shell). Supports create, inline edit of the window + allowance,
  and delete. All calls go through the typed `$lib/api/budgets` wrappers; errors
  are surfaced inline.

  A `Budget` grants a user `secondsAllowed` per rollover `window` for a `scope`:
  `overall` (the user's whole screen time, no target), a single `activity`, or
  an activity `group`. Scope/target are fixed at create time — changing what a
  budget applies to means deleting it and adding a new one — so inline edit only
  exposes the window + allowance, the values an admin actually tweaks.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type {
    ActivityGroupResponse,
    ActivityResponse,
    BudgetResponse,
    BudgetWindow,
    Scope,
    UserResponse,
  } from "$lib/api/contract.js";
  import { listBudgets, createBudget, updateBudget, deleteBudget } from "$lib/api/budgets.js";
  import { listUsers } from "$lib/api/users.js";
  import { listActivities } from "$lib/api/activities.js";
  import { listActivityGroups } from "$lib/api/activity-groups.js";

  const SCOPE_OPTIONS: ReadonlyArray<{ value: Scope; label: string }> = [
    { value: "overall", label: "Overall" },
    { value: "activity", label: "Activity" },
    { value: "group", label: "Activity group" },
  ];

  const WINDOW_OPTIONS: ReadonlyArray<{ value: BudgetWindow; label: string }> = [
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
    { value: "monthly", label: "Monthly" },
  ];

  let budgets = $state<BudgetResponse[]>([]);
  let users = $state<UserResponse[]>([]);
  let activities = $state<ActivityResponse[]>([]);
  let groups = $state<ActivityGroupResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Create form.
  let newUserId = $state<number | null>(null);
  let newScope = $state<Scope>("overall");
  let newTargetId = $state<number | null>(null);
  let newWindow = $state<BudgetWindow>("daily");
  let newMinutes = $state("");
  let creating = $state(false);

  // Inline edit (window + allowance only).
  let editingId = $state<number | null>(null);
  let editWindow = $state<BudgetWindow>("daily");
  let editMinutes = $state("");
  let saving = $state(false);

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      [budgets, users, activities, groups] = await Promise.all([
        listBudgets(),
        listUsers(),
        listActivities(),
        listActivityGroups(),
      ]);
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  function userName(id: number): string {
    return users.find((u) => u.id === id)?.displayName ?? `User ${id}`;
  }

  function scopeLabel(scope: Scope): string {
    return SCOPE_OPTIONS.find((o) => o.value === scope)?.label ?? scope;
  }

  function windowLabel(window: BudgetWindow): string {
    return WINDOW_OPTIONS.find((o) => o.value === window)?.label ?? window;
  }

  /** Human label for a budget's target, given its scope + targetId. */
  function targetLabel(budget: BudgetResponse): string {
    if (budget.scope === "overall" || budget.targetId === null) {
      return "—";
    }
    if (budget.scope === "activity") {
      return activities.find((a) => a.id === budget.targetId)?.matcher ?? `Activity ${budget.targetId}`;
    }
    return groups.find((g) => g.id === budget.targetId)?.name ?? `Group ${budget.targetId}`;
  }

  /** Render `secondsAllowed` as a compact `Xh Ym`. */
  function formatAllowance(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours === 0) {
      return `${minutes}m`;
    }
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  /** Parse a minutes field to whole seconds, or `null` if not a valid count. */
  function minutesToSeconds(value: string): number | null {
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 0) {
      return null;
    }
    return minutes * 60;
  }

  // The target picker only applies to the non-overall scopes; clear any stale
  // selection when the scope changes so an `overall` budget can't carry a target.
  function onScopeChange(): void {
    newTargetId = null;
  }

  let createDisabled = $derived(
    creating ||
      newUserId === null ||
      minutesToSeconds(newMinutes) === null ||
      newMinutes.trim() === "" ||
      (newScope !== "overall" && newTargetId === null),
  );

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const seconds = minutesToSeconds(newMinutes);
    if (newUserId === null || seconds === null) {
      return;
    }
    creating = true;
    error = null;
    try {
      const created = await createBudget({
        userId: newUserId,
        scope: newScope,
        targetId: newScope === "overall" ? null : newTargetId,
        window: newWindow,
        secondsAllowed: seconds,
      });
      budgets = [...budgets, created];
      newScope = "overall";
      newTargetId = null;
      newWindow = "daily";
      newMinutes = "";
    } catch (err) {
      error = messageOf(err);
    } finally {
      creating = false;
    }
  }

  function startEdit(budget: BudgetResponse): void {
    editingId = budget.id;
    editWindow = budget.window;
    editMinutes = String(Math.round(budget.secondsAllowed / 60));
    error = null;
  }

  function cancelEdit(): void {
    editingId = null;
  }

  async function saveEdit(id: number): Promise<void> {
    const seconds = minutesToSeconds(editMinutes);
    if (seconds === null) {
      return;
    }
    saving = true;
    error = null;
    try {
      const updated = await updateBudget(id, { window: editWindow, secondsAllowed: seconds });
      budgets = budgets.map((b) => (b.id === id ? updated : b));
      editingId = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(budget: BudgetResponse): Promise<void> {
    if (!confirm(`Delete this ${budget.window} ${budget.scope} budget? This cannot be undone.`)) {
      return;
    }
    error = null;
    try {
      await deleteBudget(budget.id);
      budgets = budgets.filter((b) => b.id !== budget.id);
    } catch (err) {
      error = messageOf(err);
    }
  }

  /** Render any thrown value as a UI-safe message. */
  function messageOf(err: unknown): string {
    if (err instanceof ApiError) {
      return err.message;
    }
    return err instanceof Error ? err.message : "Something went wrong";
  }
</script>

<section>
  <header class="head">
    <h1>Budgets</h1>
    <p class="hint">
      How much time a user gets per day, week, or month — overall or for a
      specific activity or activity group. Allowances are entered in minutes.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if !loading && users.length === 0}
    <p class="muted">Add a user first — a budget always belongs to a user.</p>
  {:else}
    <form class="create" onsubmit={handleCreate}>
      <select bind:value={newUserId} disabled={creating} aria-label="Budget user" required>
        <option value={null} disabled selected>Choose a user…</option>
        {#each users as user (user.id)}
          <option value={user.id}>{user.displayName}</option>
        {/each}
      </select>
      <select
        bind:value={newScope}
        onchange={onScopeChange}
        disabled={creating}
        aria-label="Budget scope"
      >
        {#each SCOPE_OPTIONS as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
      {#if newScope === "activity"}
        <select bind:value={newTargetId} disabled={creating} aria-label="Target activity" required>
          <option value={null} disabled selected>Choose an activity…</option>
          {#each activities as activity (activity.id)}
            <option value={activity.id}>{activity.matcher} ({activity.kind})</option>
          {/each}
        </select>
      {:else if newScope === "group"}
        <select bind:value={newTargetId} disabled={creating} aria-label="Target group" required>
          <option value={null} disabled selected>Choose a group…</option>
          {#each groups as group (group.id)}
            <option value={group.id}>{group.name}</option>
          {/each}
        </select>
      {/if}
      <select bind:value={newWindow} disabled={creating} aria-label="Budget window">
        {#each WINDOW_OPTIONS as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
      <input
        type="number"
        min="0"
        step="1"
        placeholder="Minutes"
        bind:value={newMinutes}
        disabled={creating}
        required
        aria-label="Allowance in minutes"
      />
      <button type="submit" disabled={createDisabled}>
        {creating ? "Adding…" : "Add budget"}
      </button>
    </form>

    {#if loading}
      <p class="muted">Loading budgets…</p>
    {:else if budgets.length === 0}
      <p class="muted">No budgets yet. Add one above.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Scope</th>
            <th>Target</th>
            <th>Window</th>
            <th>Allowance</th>
            <th class="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each budgets as budget (budget.id)}
            <tr>
              <td>{userName(budget.userId)}</td>
              <td>{scopeLabel(budget.scope)}</td>
              <td class="muted">{targetLabel(budget)}</td>
              {#if editingId === budget.id}
                <td>
                  <select bind:value={editWindow} aria-label="Edit window">
                    {#each WINDOW_OPTIONS as option (option.value)}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    bind:value={editMinutes}
                    aria-label="Edit allowance in minutes"
                  />
                </td>
                <td class="actions">
                  <button
                    onclick={() => saveEdit(budget.id)}
                    disabled={saving || minutesToSeconds(editMinutes) === null}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button class="ghost" onclick={cancelEdit} disabled={saving}>Cancel</button>
                </td>
              {:else}
                <td>{windowLabel(budget.window)}</td>
                <td>{formatAllowance(budget.secondsAllowed)}</td>
                <td class="actions">
                  <button class="ghost" onclick={() => startEdit(budget)}>Edit</button>
                  <button class="danger" onclick={() => handleDelete(budget)}>Delete</button>
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</section>

<style>
  h1 {
    margin: 0;
    font-size: 1.3rem;
  }
  .hint {
    margin: 0.25rem 0 1rem;
    color: #6b7280;
    font-size: 0.9rem;
    max-width: 40rem;
  }
  .create {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
  }
  .create input {
    flex: 0 1 8rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
  }
  .create select {
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    background: #fff;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #fff;
    border-radius: 0.5rem;
    overflow: hidden;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
  }
  th,
  td {
    text-align: left;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid #f3f4f6;
    font-size: 0.9rem;
  }
  th {
    background: #f9fafb;
    font-weight: 600;
    color: #374151;
  }
  td input,
  td select {
    width: 100%;
    padding: 0.35rem 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.3rem;
    background: #fff;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
  }
  .actions-col {
    width: 1%;
    white-space: nowrap;
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
  button.danger {
    background: #dc2626;
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
