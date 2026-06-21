<!--
  Schedules editor (#189): repeats the Users/Activities/Budgets pattern (#53).
  Loads `/api/schedules` plus the users / activities / activity-groups it needs
  to render targets and populate the create form, all on mount (browser only —
  the page is prerendered to a static shell). Supports create, inline edit of
  the `action`, and delete. All calls go through the typed `$lib/api/schedules`
  wrappers; errors surface inline.

  A `Schedule` is a recurring rule that `allow`/`deny`/`extend`s a `targetKind`
  (`overall`, a single `activity`, or an activity `group`) for a user. Scope and
  target are fixed at create time — changing what a rule applies to means
  deleting it and adding a new one — so inline edit only exposes `action`.

  Recurrence is rendered read-only here ("Always" for the degenerate always-on
  rule). Authoring day-of-week + intra-day windows is #140, and drag-to-order of
  the `ordinal` is #63; this editor creates the always-on rule and faithfully
  displays any recurrence those editors set later.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type {
    ActivityGroupResponse,
    ActivityResponse,
    ScheduleAction,
    ScheduleResponse,
    Scope,
    UserResponse,
  } from "$lib/api/contract.js";
  import {
    listSchedules,
    createSchedule,
    updateSchedule,
    deleteSchedule,
  } from "$lib/api/schedules.js";
  import { listUsers } from "$lib/api/users.js";
  import { listActivities } from "$lib/api/activities.js";
  import { listActivityGroups } from "$lib/api/activity-groups.js";

  const SCOPE_OPTIONS: ReadonlyArray<{ value: Scope; label: string }> = [
    { value: "overall", label: "Overall" },
    { value: "activity", label: "Activity" },
    { value: "group", label: "Activity group" },
  ];

  const ACTION_OPTIONS: ReadonlyArray<{ value: ScheduleAction; label: string }> = [
    { value: "allow", label: "Allow" },
    { value: "deny", label: "Deny" },
    { value: "extend", label: "Extend" },
  ];

  // ISO weekday order, bit 0 = Monday … bit 6 = Sunday (ADR 0005 §1).
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

  let schedules = $state<ScheduleResponse[]>([]);
  let users = $state<UserResponse[]>([]);
  let activities = $state<ActivityResponse[]>([]);
  let groups = $state<ActivityGroupResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Create form.
  let newUserId = $state<number | null>(null);
  let newScope = $state<Scope>("overall");
  let newTargetId = $state<number | null>(null);
  let newAction = $state<ScheduleAction>("deny");
  let creating = $state(false);

  // Inline edit (action only).
  let editingId = $state<number | null>(null);
  let editAction = $state<ScheduleAction>("deny");
  let saving = $state(false);

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      [schedules, users, activities, groups] = await Promise.all([
        listSchedules(),
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

  function actionLabel(action: ScheduleAction): string {
    return ACTION_OPTIONS.find((o) => o.value === action)?.label ?? action;
  }

  /** Human label for a schedule's target, given its scope + targetId. */
  function targetLabel(schedule: ScheduleResponse): string {
    if (schedule.targetKind === "overall" || schedule.targetId === null) {
      return "—";
    }
    if (schedule.targetKind === "activity") {
      return (
        activities.find((a) => a.id === schedule.targetId)?.matcher ?? `Activity ${schedule.targetId}`
      );
    }
    return groups.find((g) => g.id === schedule.targetId)?.name ?? `Group ${schedule.targetId}`;
  }

  /** Decode the 7-bit ISO-weekday mask (bit 0 = Monday) to a short label. */
  function daysLabel(mask: number): string {
    const days = WEEKDAYS.filter((_, i) => (mask & (1 << i)) !== 0);
    return days.length === 7 ? "Every day" : days.join(", ");
  }

  /** Minutes-from-midnight → `HH:MM`. */
  function clockLabel(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  /** ISO instant → a short local date (no time) for the effective-window scope. */
  function dateLabel(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }

  /**
   * Render a schedule's recurrence + date scope read-only. The degenerate row
   * (no weekday, no intra-day window, no effective bounds) is the always-on
   * rule. Authoring these fields is #140; this editor only displays them.
   */
  function recurrenceSummary(s: ScheduleResponse): string {
    const parts: string[] = [];
    if (s.recurrenceDays !== null) {
      parts.push(daysLabel(s.recurrenceDays));
    }
    if (s.recurrenceStartMinute !== null && s.recurrenceEndMinute !== null) {
      parts.push(`${clockLabel(s.recurrenceStartMinute)}–${clockLabel(s.recurrenceEndMinute)}`);
    }
    if (parts.length === 0) {
      parts.push("Always");
    }
    if (s.effectiveFrom !== null || s.effectiveTo !== null) {
      const from = s.effectiveFrom === null ? "…" : dateLabel(s.effectiveFrom);
      const to = s.effectiveTo === null ? "…" : dateLabel(s.effectiveTo);
      parts.push(`(${from} → ${to})`);
    }
    return parts.join(" ");
  }

  // The target picker only applies to the non-overall scopes; clear any stale
  // selection when the scope changes so an `overall` rule can't carry a target.
  function onScopeChange(): void {
    newTargetId = null;
  }

  let createDisabled = $derived(
    creating || newUserId === null || (newScope !== "overall" && newTargetId === null),
  );

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (newUserId === null) {
      return;
    }
    creating = true;
    error = null;
    try {
      const created = await createSchedule({
        userId: newUserId,
        targetKind: newScope,
        targetId: newScope === "overall" ? null : newTargetId,
        action: newAction,
        // Always-on degenerate rule; day/window authoring is #140.
        recurrenceDays: null,
        recurrenceStartMinute: null,
        recurrenceEndMinute: null,
        effectiveFrom: null,
        effectiveTo: null,
      });
      schedules = [...schedules, created];
      newScope = "overall";
      newTargetId = null;
      newAction = "deny";
    } catch (err) {
      error = messageOf(err);
    } finally {
      creating = false;
    }
  }

  function startEdit(schedule: ScheduleResponse): void {
    editingId = schedule.id;
    editAction = schedule.action;
    error = null;
  }

  function cancelEdit(): void {
    editingId = null;
  }

  async function saveEdit(id: number): Promise<void> {
    saving = true;
    error = null;
    try {
      const updated = await updateSchedule(id, { action: editAction });
      schedules = schedules.map((s) => (s.id === id ? updated : s));
      editingId = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(schedule: ScheduleResponse): Promise<void> {
    if (
      !confirm(
        `Delete this ${schedule.action} ${schedule.targetKind} schedule? This cannot be undone.`,
      )
    ) {
      return;
    }
    error = null;
    try {
      await deleteSchedule(schedule.id);
      schedules = schedules.filter((s) => s.id !== schedule.id);
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
    <h1>Schedules</h1>
    <p class="hint">
      Recurring rules that allow, deny, or extend access — overall or for a
      specific activity or activity group. New rules apply at all times; setting
      day-of-week and time-of-day windows comes later (#140).
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if !loading && users.length === 0}
    <p class="muted">Add a user first — a schedule always belongs to a user.</p>
  {:else}
    <form class="create" onsubmit={handleCreate}>
      <select bind:value={newUserId} disabled={creating} aria-label="Schedule user" required>
        <option value={null} disabled selected>Choose a user…</option>
        {#each users as user (user.id)}
          <option value={user.id}>{user.displayName}</option>
        {/each}
      </select>
      <select
        bind:value={newScope}
        onchange={onScopeChange}
        disabled={creating}
        aria-label="Schedule scope"
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
      <select bind:value={newAction} disabled={creating} aria-label="Schedule action">
        {#each ACTION_OPTIONS as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
      <button type="submit" disabled={createDisabled}>
        {creating ? "Adding…" : "Add schedule"}
      </button>
    </form>

    {#if loading}
      <p class="muted">Loading schedules…</p>
    {:else if schedules.length === 0}
      <p class="muted">No schedules yet. Add one above.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Scope</th>
            <th>Target</th>
            <th>Action</th>
            <th>When</th>
            <th class="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each schedules as schedule (schedule.id)}
            <tr>
              <td>{userName(schedule.userId)}</td>
              <td>{scopeLabel(schedule.targetKind)}</td>
              <td class="muted">{targetLabel(schedule)}</td>
              {#if editingId === schedule.id}
                <td>
                  <select bind:value={editAction} aria-label="Edit action">
                    {#each ACTION_OPTIONS as option (option.value)}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                </td>
                <td class="muted">{recurrenceSummary(schedule)}</td>
                <td class="actions">
                  <button onclick={() => saveEdit(schedule.id)} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button class="ghost" onclick={cancelEdit} disabled={saving}>Cancel</button>
                </td>
              {:else}
                <td>{actionLabel(schedule.action)}</td>
                <td class="muted">{recurrenceSummary(schedule)}</td>
                <td class="actions">
                  <button class="ghost" onclick={() => startEdit(schedule)}>Edit</button>
                  <button class="danger" onclick={() => handleDelete(schedule)}>Delete</button>
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
