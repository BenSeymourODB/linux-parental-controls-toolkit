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
    ResolvedBudgetResponse,
    Scope,
    UserGroupResponse,
    UserResponse,
  } from "$lib/api/contract.js";
  import {
    listBudgets,
    createBudget,
    updateBudget,
    deleteBudget,
    listResolvedBudgets,
  } from "$lib/api/budgets.js";
  import { listUsers } from "$lib/api/users.js";
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

  let budgets = $state<BudgetResponse[]>([]);
  let users = $state<UserResponse[]>([]);
  let userGroups = $state<UserGroupResponse[]>([]);
  let activities = $state<ActivityResponse[]>([]);
  let groups = $state<ActivityGroupResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Group-inherited budget slots per user (#363): the slots a member gets from a
  // group and has *not* overridden with an own budget, so the table can mark
  // each slot local vs inherited. Resolution stays server-side
  // (`gatherUserBudgets`); this is a display-only projection via
  // `GET /users/:id/budgets/resolved`. Empty unless at least one group exists.
  let inherited = $state<{ userId: number; groupId: number; slot: ResolvedBudgetResponse }[]>([]);

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
      [budgets, users, userGroups, activities, groups] = await Promise.all([
        listBudgets(),
        listUsers(),
        listUserGroups(),
        listActivities(),
        listActivityGroups(),
      ]);
      await loadInherited();
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  /** The group-sourced slots for one user (empty when there are no groups). */
  async function fetchGroupSlots(
    userId: number,
  ): Promise<{ userId: number; groupId: number; slot: ResolvedBudgetResponse }[]> {
    if (userGroups.length === 0) {
      return [];
    }
    let resolved: ResolvedBudgetResponse[] = [];
    try {
      resolved = await listResolvedBudgets(userId);
    } catch {
      // Inherited display is a display-only enrichment; if the projection fails
      // for a user, leave their inherited rows empty rather than failing the view.
      return [];
    }
    return resolved.flatMap((slot) =>
      slot.source.kind === "group" ? [{ userId, groupId: slot.source.groupId, slot }] : [],
    );
  }

  /** Recompute the full inherited-slot set across every user. */
  async function loadInherited(): Promise<void> {
    if (userGroups.length === 0) {
      inherited = [];
      return;
    }
    const perUser = await Promise.all(users.map((u) => fetchGroupSlots(u.id)));
    inherited = perUser.flat();
  }

  /** Recompute one user's inherited slots after their own budgets change. */
  async function refreshInherited(userId: number): Promise<void> {
    if (userGroups.length === 0) {
      return;
    }
    const slots = await fetchGroupSlots(userId);
    inherited = [...inherited.filter((row) => row.userId !== userId), ...slots];
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

  /** Human label for a budget slot's target, given its scope + targetId. */
  function targetLabel(slot: { scope: Scope; targetId: number | null }): string {
    if (slot.scope === "overall" || slot.targetId === null) {
      return "—";
    }
    if (slot.scope === "activity") {
      return activities.find((a) => a.id === slot.targetId)?.matcher ?? `Activity ${slot.targetId}`;
    }
    return groups.find((g) => g.id === slot.targetId)?.name ?? `Group ${slot.targetId}`;
  }

  /** Human name for a user group, for the "inherited from …" source label. */
  function groupName(id: number): string {
    return userGroups.find((g) => g.id === id)?.name ?? `Group ${id}`;
  }

  /**
   * The table rows: each user's own budgets (editable, source "local") followed
   * by the slots they inherit from a group (read-only, source "inherited").
   * Sorted by user so a user's own and inherited rows sit together.
   */
  let displayRows = $derived.by(() => {
    const locals = budgets.map((b) => ({
      kind: "local" as const,
      key: `local-${b.id}`,
      userId: b.userId,
      budget: b,
    }));
    const inh = inherited.map((row) => ({
      kind: "inherited" as const,
      key: `inherited-${row.userId}-${row.slot.scope}-${row.slot.window}-${row.slot.targetId ?? "null"}`,
      userId: row.userId,
      groupId: row.groupId,
      slot: row.slot,
    }));
    return [...locals, ...inh].sort(
      (a, b) => a.userId - b.userId || (a.kind === b.kind ? 0 : a.kind === "local" ? -1 : 1),
    );
  });

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
      // A new own budget may now override a slot the user was inheriting.
      await refreshInherited(created.userId);
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
      // Removing an own budget may re-expose a group slot the user now inherits.
      await refreshInherited(budget.userId);
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
      <!--
        Text (not `type="number"`) so the binding stays a string: `bind:value`
        on a number input coerces to a number, which breaks `newMinutes.trim()`
        in `createDisabled` (and the string contract `minutesToSeconds` parses).
        `inputmode="numeric"` still gives a numeric keypad.
      -->
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

    {#if loading}
      <p class="muted">Loading budgets…</p>
    {:else if displayRows.length === 0}
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
            <th>Source</th>
            <th class="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each displayRows as row (row.key)}
            {#if row.kind === "local"}
              {@const budget = row.budget}
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
                    <!-- Text for the same reason as the create field above. -->
                    <input
                      type="text"
                      inputmode="numeric"
                      bind:value={editMinutes}
                      aria-label="Edit allowance in minutes"
                    />
                  </td>
                  <td class="muted">Local</td>
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
                  <td><span class="source source-local">Local</span></td>
                  <td class="actions">
                    <button class="ghost" onclick={() => startEdit(budget)}>Edit</button>
                    <button class="danger" onclick={() => handleDelete(budget)}>Delete</button>
                  </td>
                {/if}
              </tr>
            {:else}
              <!-- Inherited from a group: read-only here — edit it on the group,
                   or add an own budget for this slot to override it. -->
              <tr class="inherited-row">
                <td>{userName(row.userId)}</td>
                <td>{scopeLabel(row.slot.scope)}</td>
                <td class="muted">{targetLabel(row.slot)}</td>
                <td>{windowLabel(row.slot.window)}</td>
                <td>{formatAllowance(row.slot.secondsAllowed)}</td>
                <td>
                  <span class="source source-inherited">Inherited · {groupName(row.groupId)}</span>
                </td>
                <td class="muted">—</td>
              </tr>
            {/if}
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
  .inherited-row {
    background: #f9fafb;
  }
  .source {
    display: inline-block;
    padding: 0.05rem 0.4rem;
    border-radius: 0.3rem;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .source-local {
    background: #eef2ff;
    color: #3730a3;
  }
  .source-inherited {
    background: #fef3c7;
    color: #92400e;
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
