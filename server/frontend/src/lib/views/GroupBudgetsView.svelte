<!--
  Group-budget editor (#363) — the group counterpart of BudgetsView (#189).

  Group-targeted budgets (#134) grant every member of a user group an allowance
  for a `(scope, window, target)` slot, inherited by members unless the member's
  own budget overrides it (`gatherUserBudgets`, ADR 0008). Scoped to one group at
  a time: pick a group, then create / inline-edit / delete its budgets. As in
  BudgetsView, scope/target are fixed at create time (changing them means delete
  + re-add), so inline edit exposes only the window + allowance.

  Create is nested under the group (`POST /user-groups/:groupId/budgets`);
  update/delete are flat by id (`/group-budgets/:id`).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type {
    ActivityGroupResponse,
    ActivityResponse,
    BudgetWindow,
    GroupBudgetResponse,
    Scope,
    UserGroupResponse,
  } from "$lib/api/contract.js";
  import {
    listGroupBudgets,
    createGroupBudget,
    updateGroupBudget,
    deleteGroupBudget,
  } from "$lib/api/group-budgets.js";
  import { listUserGroups } from "$lib/api/user-groups.js";
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

  let userGroups = $state<UserGroupResponse[]>([]);
  let activities = $state<ActivityResponse[]>([]);
  let activityGroups = $state<ActivityGroupResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // The group whose budgets are being managed, and that group's budget rows.
  let selectedGroupId = $state<number | null>(null);
  let budgets = $state<GroupBudgetResponse[]>([]);
  let budgetsLoading = $state(false);

  // Create form (the group is the selected one; only scope/target/window/allowance here).
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
      [userGroups, activities, activityGroups] = await Promise.all([
        listUserGroups(),
        listActivities(),
        listActivityGroups(),
      ]);
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  /** Load (or reload) the selected group's budgets. */
  async function loadBudgets(): Promise<void> {
    if (selectedGroupId === null) {
      budgets = [];
      return;
    }
    budgetsLoading = true;
    error = null;
    try {
      budgets = await listGroupBudgets(selectedGroupId);
    } catch (err) {
      budgets = [];
      error = messageOf(err);
    } finally {
      budgetsLoading = false;
    }
  }

  function onSelectGroup(): void {
    editingId = null;
    void loadBudgets();
  }

  function scopeLabel(scope: Scope): string {
    return SCOPE_OPTIONS.find((o) => o.value === scope)?.label ?? scope;
  }

  function windowLabel(window: BudgetWindow): string {
    return WINDOW_OPTIONS.find((o) => o.value === window)?.label ?? window;
  }

  /** Human label for a budget's target, given its scope + targetId. */
  function targetLabel(budget: GroupBudgetResponse): string {
    if (budget.scope === "overall" || budget.targetId === null) {
      return "—";
    }
    if (budget.scope === "activity") {
      return (
        activities.find((a) => a.id === budget.targetId)?.matcher ?? `Activity ${budget.targetId}`
      );
    }
    return (
      activityGroups.find((g) => g.id === budget.targetId)?.name ?? `Group ${budget.targetId}`
    );
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

  function onScopeChange(): void {
    newTargetId = null;
  }

  let createDisabled = $derived(
    creating ||
      selectedGroupId === null ||
      minutesToSeconds(newMinutes) === null ||
      newMinutes.trim() === "" ||
      (newScope !== "overall" && newTargetId === null),
  );

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const seconds = minutesToSeconds(newMinutes);
    if (selectedGroupId === null || seconds === null) {
      return;
    }
    creating = true;
    error = null;
    try {
      const created = await createGroupBudget(selectedGroupId, {
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

  function startEdit(budget: GroupBudgetResponse): void {
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
      const updated = await updateGroupBudget(id, { window: editWindow, secondsAllowed: seconds });
      budgets = budgets.map((b) => (b.id === id ? updated : b));
      editingId = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(budget: GroupBudgetResponse): Promise<void> {
    if (
      !confirm(`Delete this ${budget.window} ${budget.scope} group budget? This cannot be undone.`)
    ) {
      return;
    }
    error = null;
    try {
      await deleteGroupBudget(budget.id);
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
    <h1>Group budgets</h1>
    <p class="hint">
      How much time every member of a user group gets per day, week, or month —
      overall or for a specific activity or activity group. A member's own budget
      overrides the group's for the same slot. Allowances are entered in minutes.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if userGroups.length === 0}
    <p class="muted">Add a user group first — a group budget always belongs to a group.</p>
  {:else}
    <div class="group-picker">
      <label for="group-budget-group">Manage budgets for group</label>
      <select
        id="group-budget-group"
        bind:value={selectedGroupId}
        onchange={onSelectGroup}
        aria-label="Manage budgets for group"
      >
        <option value={null} disabled selected>Choose a group…</option>
        {#each userGroups as group (group.id)}
          <option value={group.id}>{group.name}</option>
        {/each}
      </select>
    </div>

    {#if selectedGroupId === null}
      <p class="muted">Choose a group to view and manage its budgets.</p>
    {:else}
      <form class="create" onsubmit={handleCreate}>
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
            {#each activityGroups as group (group.id)}
              <option value={group.id}>{group.name}</option>
            {/each}
          </select>
        {/if}
        <select bind:value={newWindow} disabled={creating} aria-label="Budget window">
          {#each WINDOW_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
        <!-- Text (not `type="number"`) so the binding stays a string, matching
             BudgetsView: `minutesToSeconds` parses a string and `createDisabled`
             calls `.trim()`. `inputmode="numeric"` still gives a numeric keypad. -->
        <input
          type="text"
          inputmode="numeric"
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

      {#if budgetsLoading}
        <p class="muted">Loading budgets…</p>
      {:else if budgets.length === 0}
        <p class="muted">No budgets yet. Add one above.</p>
      {:else}
        <table>
          <thead>
            <tr>
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
                      type="text"
                      inputmode="numeric"
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
  .group-picker {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
    font-size: 0.9rem;
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
  .group-picker select {
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
