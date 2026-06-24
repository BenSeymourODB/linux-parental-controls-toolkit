<!--
  Group-schedule editor (#270) — the group counterpart of SchedulesView (#63).

  Group-targeted schedules (#182) carry the same per-group `ordinal` and
  first-match-wins precedence (ascending `ordinal`; ADR 0004) as a user's own
  rules, so this editor is scoped to one group at a time: pick a group, then see
  its rules in evaluation order and reorder them. Reordering is available two
  ways — a drag handle (pointer) and per-row Move up / Move down buttons
  (keyboard) — and persists atomically via
  `PUT /user-groups/:groupId/schedules/order`.

  The server computes the **shadow** finding the editor surfaces (which rules an
  earlier rule makes unreachable), so precedence lives in exactly one place
  (`policy/schedule-precedence.ts`) and the editor never re-implements it.

  Unlike SchedulesView there is **no "in effect now" badge**: a group has no
  single timezone (members may differ), so a live instant is only meaningful
  resolved per member (`GET /users/:userId/effective`), not for the group. The
  group order view therefore omits `effectiveIds` by design (#270).

  A group `Schedule` allow/deny/extends a `targetKind` (`overall`, an `activity`,
  or an activity `group`). Scope/target are fixed at create time; inline edit
  exposes `action` only. Recurrence is rendered read-only ("Always" for the
  degenerate always-on rule); authoring day/time windows is #140.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type {
    ActivityGroupResponse,
    ActivityResponse,
    GroupScheduleOrderView,
    GroupScheduleResponse,
    ScheduleAction,
    Scope,
    UserGroupResponse,
  } from "$lib/api/contract.js";
  import {
    createGroupSchedule,
    updateGroupSchedule,
    deleteGroupSchedule,
    getGroupScheduleOrder,
    reorderGroupSchedules,
  } from "$lib/api/schedules.js";
  import { listUserGroups } from "$lib/api/user-groups.js";
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

  let userGroups = $state<UserGroupResponse[]>([]);
  let activities = $state<ActivityResponse[]>([]);
  let activityGroups = $state<ActivityGroupResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // The group whose ordered rules are being managed, and that group's order view.
  let selectedGroupId = $state<number | null>(null);
  let order = $state<GroupScheduleOrderView | null>(null);
  let orderLoading = $state(false);
  let reordering = $state(false);

  // Create form (the group is the selected one; only scope/target/action here).
  let newScope = $state<Scope>("overall");
  let newTargetId = $state<number | null>(null);
  let newAction = $state<ScheduleAction>("deny");
  let creating = $state(false);

  // Inline edit (action only).
  let editingId = $state<number | null>(null);
  let editAction = $state<ScheduleAction>("deny");
  let saving = $state(false);

  // The rule being dragged (index into the current order), or null.
  let dragIndex = $state<number | null>(null);

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

  /** Load (or reload) the selected group's order view. */
  async function loadOrder(): Promise<void> {
    if (selectedGroupId === null) {
      order = null;
      return;
    }
    orderLoading = true;
    error = null;
    try {
      order = await getGroupScheduleOrder(selectedGroupId);
    } catch (err) {
      order = null;
      error = messageOf(err);
    } finally {
      orderLoading = false;
    }
  }

  function onSelectGroup(): void {
    editingId = null;
    void loadOrder();
  }

  // Derived lookups for the warnings (recomputed when `order` changes).
  let shadowedBy = $derived(
    new Map((order?.shadows ?? []).map((s) => [s.shadowedId, s.shadowedById])),
  );
  let schedules = $derived(order?.schedules ?? []);

  function scopeLabel(scope: Scope): string {
    return SCOPE_OPTIONS.find((o) => o.value === scope)?.label ?? scope;
  }

  function actionLabel(action: ScheduleAction): string {
    return ACTION_OPTIONS.find((o) => o.value === action)?.label ?? action;
  }

  /** Human label for a schedule's target, given its scope + targetId. */
  function targetLabel(schedule: GroupScheduleResponse): string {
    if (schedule.targetKind === "overall" || schedule.targetId === null) {
      return "—";
    }
    if (schedule.targetKind === "activity") {
      return (
        activities.find((a) => a.id === schedule.targetId)?.matcher ??
        `Activity ${schedule.targetId}`
      );
    }
    return (
      activityGroups.find((g) => g.id === schedule.targetId)?.name ?? `Group ${schedule.targetId}`
    );
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

  /** Render a schedule's recurrence + date scope read-only (#140 authors these). */
  function recurrenceSummary(s: GroupScheduleResponse): string {
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

  /** The 1-based position of the rule that shadows `id`, for the warning text. */
  function shadowerPosition(id: number): number | null {
    const by = shadowedBy.get(id);
    if (by === undefined) return null;
    const index = schedules.findIndex((s) => s.id === by);
    return index === -1 ? null : index + 1;
  }

  function onScopeChange(): void {
    newTargetId = null;
  }

  let createDisabled = $derived(
    creating || selectedGroupId === null || (newScope !== "overall" && newTargetId === null),
  );

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (selectedGroupId === null) {
      return;
    }
    creating = true;
    error = null;
    // Append after the current rules: one past the largest existing ordinal, so
    // a new rule sorts last whether or not the ordinals have been densified by a
    // reorder (mirrors the server's `nextOrdinal`).
    const appendOrdinal = schedules.reduce((max, s) => Math.max(max, s.ordinal + 1), 0);
    try {
      await createGroupSchedule(selectedGroupId, {
        targetKind: newScope,
        targetId: newScope === "overall" ? null : newTargetId,
        action: newAction,
        ordinal: appendOrdinal,
        recurrenceDays: null,
        recurrenceStartMinute: null,
        recurrenceEndMinute: null,
        effectiveFrom: null,
        effectiveTo: null,
      });
      newScope = "overall";
      newTargetId = null;
      newAction = "deny";
      await loadOrder();
    } catch (err) {
      error = messageOf(err);
    } finally {
      creating = false;
    }
  }

  function startEdit(schedule: GroupScheduleResponse): void {
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
      await updateGroupSchedule(id, { action: editAction });
      editingId = null;
      await loadOrder();
    } catch (err) {
      error = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(schedule: GroupScheduleResponse): Promise<void> {
    if (
      !confirm(
        `Delete this ${schedule.action} ${schedule.targetKind} group schedule? This cannot be undone.`,
      )
    ) {
      return;
    }
    error = null;
    try {
      await deleteGroupSchedule(schedule.id);
      await loadOrder();
    } catch (err) {
      error = messageOf(err);
    }
  }

  /** Produce the id order that results from moving `from` to `to`. */
  function moved(from: number, to: number): number[] {
    const ids = schedules.map((s) => s.id);
    const [m] = ids.splice(from, 1);
    if (m === undefined) return ids;
    ids.splice(to, 0, m);
    return ids;
  }

  /** Persist a new id order and replace state with the server's fresh view. */
  async function persistOrder(orderedIds: number[]): Promise<void> {
    if (selectedGroupId === null) return;
    reordering = true;
    error = null;
    try {
      order = await reorderGroupSchedules(selectedGroupId, orderedIds);
    } catch (err) {
      // Resync to the server's truth first (loadOrder resets `error`), then
      // surface the reorder failure so the message survives the reload.
      await loadOrder();
      error = messageOf(err);
    } finally {
      reordering = false;
    }
  }

  /** Keyboard-accessible reorder: move the rule at `index` by `delta` (±1). */
  async function move(index: number, delta: number): Promise<void> {
    const to = index + delta;
    if (to < 0 || to >= schedules.length) return;
    await persistOrder(moved(index, to));
  }

  function onDragStart(index: number): void {
    dragIndex = index;
  }

  function onDragOver(event: DragEvent): void {
    event.preventDefault(); // allow the drop
  }

  async function onDrop(index: number): Promise<void> {
    const from = dragIndex;
    dragIndex = null;
    if (from === null || from === index) return;
    await persistOrder(moved(from, index));
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
    <h1>Group schedules</h1>
    <p class="hint">
      Recurring rules that allow, deny, or extend access for every member of a
      user group — overall or for a specific activity or activity group. Rules
      are evaluated top to bottom and the first matching rule wins, so drag (or
      use Move up / Move down) to set precedence. Because a group's members can
      span timezones, "in effect now" is shown per user on their own status, not
      here. New rules apply at all times; day-of-week and time-of-day windows
      come later (#140).
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if userGroups.length === 0}
    <p class="muted">Add a user group first — a group schedule always belongs to a group.</p>
  {:else}
    <div class="group-picker">
      <label for="group-schedule-group">Manage schedules for group</label>
      <select
        id="group-schedule-group"
        bind:value={selectedGroupId}
        onchange={onSelectGroup}
        aria-label="Manage schedules for group"
      >
        <option value={null} disabled selected>Choose a group…</option>
        {#each userGroups as group (group.id)}
          <option value={group.id}>{group.name}</option>
        {/each}
      </select>
    </div>

    {#if selectedGroupId === null}
      <p class="muted">Choose a group to view and order its schedule rules.</p>
    {:else}
      <form class="create" onsubmit={handleCreate}>
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
            {#each activityGroups as group (group.id)}
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

      {#if orderLoading}
        <p class="muted">Loading schedules…</p>
      {:else if schedules.length === 0}
        <p class="muted">No schedules yet. Add one above.</p>
      {:else}
        <ol class="rules" aria-busy={reordering}>
          {#each schedules as schedule, index (schedule.id)}
            {@const shadower = shadowerPosition(schedule.id)}
            <li
              class="rule"
              class:shadowed={shadower !== null}
              draggable={!reordering && editingId === null}
              ondragstart={() => onDragStart(index)}
              ondragover={onDragOver}
              ondrop={() => onDrop(index)}
              ondragend={() => (dragIndex = null)}
            >
              <span class="handle" aria-hidden="true" title="Drag to reorder">⠿</span>
              <span class="pos">{index + 1}</span>

              <div class="body">
                <div class="line">
                  <span class="scope">{scopeLabel(schedule.targetKind)}</span>
                  {#if schedule.targetKind !== "overall"}
                    <span class="target">{targetLabel(schedule)}</span>
                  {/if}
                  {#if editingId === schedule.id}
                    <select bind:value={editAction} aria-label="Edit action">
                      {#each ACTION_OPTIONS as option (option.value)}
                        <option value={option.value}>{option.label}</option>
                      {/each}
                    </select>
                  {:else}
                    <span class="action action-{schedule.action}"
                      >{actionLabel(schedule.action)}</span
                    >
                  {/if}
                </div>
                <div class="when muted">{recurrenceSummary(schedule)}</div>
                {#if shadower !== null}
                  <p class="warn" role="note">
                    Never applies — rule #{shadower} above always wins for this target.
                  </p>
                {/if}
              </div>

              <div class="controls">
                <button
                  class="ghost icon"
                  aria-label="Move up"
                  disabled={reordering || index === 0}
                  onclick={() => move(index, -1)}>↑</button
                >
                <button
                  class="ghost icon"
                  aria-label="Move down"
                  disabled={reordering || index === schedules.length - 1}
                  onclick={() => move(index, 1)}>↓</button
                >
                {#if editingId === schedule.id}
                  <button onclick={() => saveEdit(schedule.id)} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button class="ghost" onclick={cancelEdit} disabled={saving}>Cancel</button>
                {:else}
                  <button class="ghost" onclick={() => startEdit(schedule)}>Edit</button>
                  <button class="danger" onclick={() => handleDelete(schedule)}>Delete</button>
                {/if}
              </div>
            </li>
          {/each}
        </ol>
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
  select {
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    background: #fff;
  }
  .rules {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .rule {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.6rem 0.75rem;
    background: #fff;
    border: 1px solid #f3f4f6;
    border-radius: 0.5rem;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
  }
  .rule.shadowed {
    opacity: 0.85;
    border-color: #fde68a;
    background: #fffbeb;
  }
  .handle {
    cursor: grab;
    color: #9ca3af;
    user-select: none;
    line-height: 1.5;
  }
  .pos {
    min-width: 1.25rem;
    text-align: center;
    color: #6b7280;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.9rem;
  }
  .scope {
    font-weight: 600;
    color: #374151;
  }
  .target {
    color: #6b7280;
  }
  .action {
    padding: 0.05rem 0.4rem;
    border-radius: 0.3rem;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .action-allow {
    background: #dcfce7;
    color: #166534;
  }
  .action-deny {
    background: #fee2e2;
    color: #991b1b;
  }
  .action-extend {
    background: #dbeafe;
    color: #1e40af;
  }
  .when {
    font-size: 0.8rem;
    margin-top: 0.15rem;
  }
  .warn {
    margin: 0.3rem 0 0;
    font-size: 0.8rem;
    color: #92400e;
  }
  .controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
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
  button.icon {
    padding: 0.3rem 0.55rem;
    font-weight: 700;
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
