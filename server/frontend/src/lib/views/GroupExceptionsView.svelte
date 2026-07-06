<!--
  Group-exception editor (#363) — the group counterpart of ExceptionsView (#189).

  Group-targeted exceptions (#182) are one-shot, date-boxed overrides that
  allow/deny/extend a `targetKind` (`overall`, an activity, or an activity group)
  for every member of a user group over `[effectiveFrom ?? createdAt, expiresAt)`
  (ADR 0005 §2). Scoped to one group at a time: pick a group, then create /
  inline-edit / delete its exceptions. Scope/target are fixed at create time.

  Create is nested under the group (`POST /user-groups/:groupId/exceptions`);
  update/delete are flat by id (`/group-exceptions/:id`).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type {
    ActivityGroupResponse,
    ActivityResponse,
    GroupExceptionResponse,
    ScheduleAction,
    Scope,
    UserGroupResponse,
  } from "$lib/api/contract.js";
  import {
    listGroupExceptions,
    createGroupException,
    updateGroupException,
    deleteGroupException,
  } from "$lib/api/group-exceptions.js";
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

  let userGroups = $state<UserGroupResponse[]>([]);
  let activities = $state<ActivityResponse[]>([]);
  let activityGroups = $state<ActivityGroupResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // The group whose exceptions are being managed, and that group's rows.
  let selectedGroupId = $state<number | null>(null);
  let exceptions = $state<GroupExceptionResponse[]>([]);
  let exceptionsLoading = $state(false);

  // Create form (the group is the selected one).
  let newScope = $state<Scope>("overall");
  let newTargetId = $state<number | null>(null);
  let newAction = $state<ScheduleAction>("allow");
  let newReason = $state("");
  let newEffectiveFrom = $state("");
  let newExpiresAt = $state("");
  let creating = $state(false);

  // Inline edit (action + reason + expiry).
  let editingId = $state<number | null>(null);
  let editAction = $state<ScheduleAction>("allow");
  let editReason = $state("");
  let editExpiresAt = $state("");
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

  /** Load (or reload) the selected group's exceptions. */
  async function loadExceptions(): Promise<void> {
    if (selectedGroupId === null) {
      exceptions = [];
      return;
    }
    exceptionsLoading = true;
    error = null;
    try {
      exceptions = await listGroupExceptions(selectedGroupId);
    } catch (err) {
      exceptions = [];
      error = messageOf(err);
    } finally {
      exceptionsLoading = false;
    }
  }

  function onSelectGroup(): void {
    editingId = null;
    void loadExceptions();
  }

  function scopeLabel(scope: Scope): string {
    return SCOPE_OPTIONS.find((o) => o.value === scope)?.label ?? scope;
  }

  function actionLabel(action: ScheduleAction): string {
    return ACTION_OPTIONS.find((o) => o.value === action)?.label ?? action;
  }

  /** Human label for an exception's target, given its scope + targetId. */
  function targetLabel(exception: GroupExceptionResponse): string {
    if (exception.targetKind === "overall" || exception.targetId === null) {
      return "—";
    }
    if (exception.targetKind === "activity") {
      return (
        activities.find((a) => a.id === exception.targetId)?.matcher ??
        `Activity ${exception.targetId}`
      );
    }
    return (
      activityGroups.find((g) => g.id === exception.targetId)?.name ??
      `Group ${exception.targetId}`
    );
  }

  /** ISO instant → readable local date+time for display. */
  function formatInstant(iso: string | null): string {
    return iso === null ? "—" : new Date(iso).toLocaleString();
  }

  /**
   * A `datetime-local` value ("YYYY-MM-DDTHH:mm", local) → an ISO-8601 UTC
   * instant, or `null` when the field is blank.
   */
  function localToIso(value: string): string | null {
    if (value.trim() === "") {
      return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  /** ISO instant → a `datetime-local` value in the browser's local zone for edit prefill. */
  function isoToLocalInput(iso: string | null): string {
    if (iso === null) {
      return "";
    }
    const d = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function onScopeChange(): void {
    newTargetId = null;
  }

  // Mirror the server's `effectiveFrom < expiresAt` refinement for fast feedback.
  let datesInvalid = $derived.by(() => {
    const from = localToIso(newEffectiveFrom);
    const to = localToIso(newExpiresAt);
    return from !== null && to !== null && Date.parse(from) >= Date.parse(to);
  });

  let createDisabled = $derived(
    creating ||
      selectedGroupId === null ||
      newExpiresAt.trim() === "" ||
      datesInvalid ||
      (newScope !== "overall" && newTargetId === null),
  );

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const expiresAt = localToIso(newExpiresAt);
    if (selectedGroupId === null || expiresAt === null) {
      return;
    }
    creating = true;
    error = null;
    try {
      const created = await createGroupException(selectedGroupId, {
        targetKind: newScope,
        targetId: newScope === "overall" ? null : newTargetId,
        action: newAction,
        reason: newReason.trim() === "" ? null : newReason.trim(),
        effectiveFrom: localToIso(newEffectiveFrom),
        expiresAt,
      });
      exceptions = [...exceptions, created];
      newScope = "overall";
      newTargetId = null;
      newAction = "allow";
      newReason = "";
      newEffectiveFrom = "";
      newExpiresAt = "";
    } catch (err) {
      error = messageOf(err);
    } finally {
      creating = false;
    }
  }

  function startEdit(exception: GroupExceptionResponse): void {
    editingId = exception.id;
    editAction = exception.action;
    editReason = exception.reason ?? "";
    editExpiresAt = isoToLocalInput(exception.expiresAt);
    error = null;
  }

  function cancelEdit(): void {
    editingId = null;
  }

  async function saveEdit(id: number): Promise<void> {
    const expiresAt = localToIso(editExpiresAt);
    if (expiresAt === null) {
      return;
    }
    saving = true;
    error = null;
    try {
      const updated = await updateGroupException(id, {
        action: editAction,
        reason: editReason.trim() === "" ? null : editReason.trim(),
        expiresAt,
      });
      exceptions = exceptions.map((e) => (e.id === id ? updated : e));
      editingId = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(exception: GroupExceptionResponse): Promise<void> {
    if (
      !confirm(
        `Delete this ${exception.action} ${exception.targetKind} group exception? This cannot be undone.`,
      )
    ) {
      return;
    }
    error = null;
    try {
      await deleteGroupException(exception.id);
      exceptions = exceptions.filter((e) => e.id !== exception.id);
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
    <h1>Group exceptions</h1>
    <p class="hint">
      One-off overrides that allow, deny, or extend access for a fixed window,
      applied to every member of a user group — e.g. "allow games for the whole
      group until Sunday night". Each override needs an expiry; an optional start
      defaults to now.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if userGroups.length === 0}
    <p class="muted">Add a user group first — a group exception always belongs to a group.</p>
  {:else}
    <div class="group-picker">
      <label for="group-exception-group">Manage exceptions for group</label>
      <select
        id="group-exception-group"
        bind:value={selectedGroupId}
        onchange={onSelectGroup}
        aria-label="Manage exceptions for group"
      >
        <option value={null} disabled selected>Choose a group…</option>
        {#each userGroups as group (group.id)}
          <option value={group.id}>{group.name}</option>
        {/each}
      </select>
    </div>

    {#if selectedGroupId === null}
      <p class="muted">Choose a group to view and manage its exceptions.</p>
    {:else}
      <form class="create" onsubmit={handleCreate}>
        <select
          bind:value={newScope}
          onchange={onScopeChange}
          disabled={creating}
          aria-label="Exception scope"
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
        <select bind:value={newAction} disabled={creating} aria-label="Exception action">
          {#each ACTION_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
        <input
          type="text"
          placeholder="Reason (optional)"
          bind:value={newReason}
          disabled={creating}
          aria-label="Reason"
        />
        <label class="field">
          <span>From</span>
          <input
            type="datetime-local"
            bind:value={newEffectiveFrom}
            disabled={creating}
            aria-label="Effective from"
          />
        </label>
        <label class="field">
          <span>Expires</span>
          <input
            type="datetime-local"
            bind:value={newExpiresAt}
            disabled={creating}
            required
            aria-label="Expires at"
          />
        </label>
        <button type="submit" disabled={createDisabled}>
          {creating ? "Adding…" : "Add exception"}
        </button>
      </form>

      {#if datesInvalid}
        <p class="warn" role="alert">Expiry must be after the start time.</p>
      {/if}

      {#if exceptionsLoading}
        <p class="muted">Loading exceptions…</p>
      {:else if exceptions.length === 0}
        <p class="muted">No exceptions yet. Add one above.</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Target</th>
              <th>Action</th>
              <th>Reason</th>
              <th>From</th>
              <th>Expires</th>
              <th class="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each exceptions as exception (exception.id)}
              <tr>
                <td>{scopeLabel(exception.targetKind)}</td>
                <td class="muted">{targetLabel(exception)}</td>
                {#if editingId === exception.id}
                  <td>
                    <select bind:value={editAction} aria-label="Edit action">
                      {#each ACTION_OPTIONS as option (option.value)}
                        <option value={option.value}>{option.label}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <input type="text" bind:value={editReason} aria-label="Edit reason" />
                  </td>
                  <td class="muted">{formatInstant(exception.effectiveFrom)}</td>
                  <td>
                    <input
                      type="datetime-local"
                      bind:value={editExpiresAt}
                      aria-label="Edit expiry"
                    />
                  </td>
                  <td class="actions">
                    <button
                      onclick={() => saveEdit(exception.id)}
                      disabled={saving || editExpiresAt.trim() === ""}
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button class="ghost" onclick={cancelEdit} disabled={saving}>Cancel</button>
                  </td>
                {:else}
                  <td>{actionLabel(exception.action)}</td>
                  <td class="muted">{exception.reason ?? "—"}</td>
                  <td class="muted">{formatInstant(exception.effectiveFrom)}</td>
                  <td>{formatInstant(exception.expiresAt)}</td>
                  <td class="actions">
                    <button class="ghost" onclick={() => startEdit(exception)}>Edit</button>
                    <button class="danger" onclick={() => handleDelete(exception)}>Delete</button>
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
  .group-picker select {
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    background: #fff;
  }
  .create {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
    align-items: end;
  }
  .create input[type="text"] {
    flex: 0 1 12rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
  }
  .create select,
  .create input[type="datetime-local"] {
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    background: #fff;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.75rem;
    color: #6b7280;
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
  .warn {
    margin: -0.5rem 0 1rem;
    color: #b45309;
    font-size: 0.8rem;
  }
</style>
