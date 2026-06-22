<!--
  Activity Groups editor (#189): repeats the Users/Activities pattern (#53) with
  an extra master-detail layer for membership. Loads `/api/activity-groups` and
  `/api/activities` on mount (browser only — the page is prerendered to a static
  shell), supports create / inline-rename / delete of groups, and — when a group
  is expanded — add/remove of member activities. All calls go through the typed
  `$lib/api/activity-groups` wrappers; errors are surfaced inline.

  An `ActivityGroup` is a named bundle a budget/schedule can target with scope
  `group`. Membership is loaded lazily when a group's panel is opened so the
  initial render stays a single list query.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type { ActivityGroupResponse, ActivityResponse } from "$lib/api/contract.js";
  import { listActivities } from "$lib/api/activities.js";
  import {
    addActivityToGroup,
    createActivityGroup,
    deleteActivityGroup,
    listActivityGroups,
    listGroupActivities,
    removeActivityFromGroup,
    updateActivityGroup,
  } from "$lib/api/activity-groups.js";

  let groups = $state<ActivityGroupResponse[]>([]);
  let activities = $state<ActivityResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Create form.
  let newName = $state("");
  let creating = $state(false);

  // Inline rename.
  let editingId = $state<number | null>(null);
  let editName = $state("");
  let saving = $state(false);

  // Membership: the currently expanded group + its member rows, loaded lazily.
  let openGroupId = $state<number | null>(null);
  let members = $state<ActivityResponse[]>([]);
  let membersLoading = $state(false);
  let addActivityId = $state<number | null>(null);
  let mutatingMembership = $state(false);

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      [groups, activities] = await Promise.all([listActivityGroups(), listActivities()]);
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  /** Activities matched by id, for rendering a member's kind/matcher. */
  function activityById(id: number): ActivityResponse | undefined {
    return activities.find((a) => a.id === id);
  }

  /** Activities not yet in the open group — the add-dropdown candidates. */
  let candidates = $derived(
    activities.filter((a) => !members.some((m) => m.id === a.id)),
  );

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    creating = true;
    error = null;
    try {
      const created = await createActivityGroup({ name: newName.trim() });
      groups = [...groups, created];
      newName = "";
    } catch (err) {
      error = messageOf(err);
    } finally {
      creating = false;
    }
  }

  function startEdit(group: ActivityGroupResponse): void {
    editingId = group.id;
    editName = group.name;
    error = null;
  }

  function cancelEdit(): void {
    editingId = null;
  }

  async function saveEdit(id: number): Promise<void> {
    saving = true;
    error = null;
    try {
      const updated = await updateActivityGroup(id, { name: editName.trim() });
      groups = groups.map((g) => (g.id === id ? updated : g));
      editingId = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(group: ActivityGroupResponse): Promise<void> {
    if (!confirm(`Delete activity group "${group.name}"? This cannot be undone.`)) {
      return;
    }
    error = null;
    try {
      await deleteActivityGroup(group.id);
      groups = groups.filter((g) => g.id !== group.id);
      if (openGroupId === group.id) {
        openGroupId = null;
      }
    } catch (err) {
      error = messageOf(err);
    }
  }

  async function toggleMembers(group: ActivityGroupResponse): Promise<void> {
    if (openGroupId === group.id) {
      openGroupId = null;
      return;
    }
    openGroupId = group.id;
    addActivityId = null;
    membersLoading = true;
    error = null;
    try {
      members = await listGroupActivities(group.id);
    } catch (err) {
      error = messageOf(err);
      members = [];
    } finally {
      membersLoading = false;
    }
  }

  async function handleAddMember(groupId: number): Promise<void> {
    if (addActivityId === null) {
      return;
    }
    mutatingMembership = true;
    error = null;
    try {
      await addActivityToGroup(groupId, addActivityId);
      const added = activityById(addActivityId);
      if (added !== undefined) {
        members = [...members, added];
      }
      addActivityId = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      mutatingMembership = false;
    }
  }

  async function handleRemoveMember(groupId: number, activityId: number): Promise<void> {
    mutatingMembership = true;
    error = null;
    try {
      await removeActivityFromGroup(groupId, activityId);
      members = members.filter((m) => m.id !== activityId);
    } catch (err) {
      error = messageOf(err);
    } finally {
      mutatingMembership = false;
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
    <h1>Activity Groups</h1>
    <p class="hint">
      Named bundles of activities. A budget or schedule can target a group so a
      whole set of apps/domains shares one limit.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <form class="create" onsubmit={handleCreate}>
    <input
      type="text"
      placeholder="Group name (e.g. Games)"
      bind:value={newName}
      disabled={creating}
      required
      aria-label="New group name"
    />
    <button type="submit" disabled={creating || newName.trim() === ""}>
      {creating ? "Adding…" : "Add group"}
    </button>
  </form>

  {#if loading}
    <p class="muted">Loading activity groups…</p>
  {:else if groups.length === 0}
    <p class="muted">No activity groups yet. Add one above.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th class="actions-col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each groups as group (group.id)}
          <tr>
            {#if editingId === group.id}
              <td><input bind:value={editName} aria-label="Edit group name" /></td>
              <td class="actions">
                <button onclick={() => saveEdit(group.id)} disabled={saving || editName.trim() === ""}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button class="ghost" onclick={cancelEdit} disabled={saving}>Cancel</button>
              </td>
            {:else}
              <td>{group.name}</td>
              <td class="actions">
                <button class="ghost" onclick={() => toggleMembers(group)}>
                  {openGroupId === group.id ? "Hide members" : "Members"}
                </button>
                <button class="ghost" onclick={() => startEdit(group)}>Rename</button>
                <button class="danger" onclick={() => handleDelete(group)}>Delete</button>
              </td>
            {/if}
          </tr>
          {#if openGroupId === group.id}
            <tr class="detail">
              <td colspan="2">
                {#if membersLoading}
                  <p class="muted">Loading members…</p>
                {:else}
                  <div class="members">
                    {#if members.length === 0}
                      <p class="muted">No activities in this group yet.</p>
                    {:else}
                      <ul class="member-list">
                        {#each members as member (member.id)}
                          <li>
                            <code>{member.matcher}</code>
                            <span class="muted">({member.kind})</span>
                            <button
                              class="ghost small"
                              disabled={mutatingMembership}
                              onclick={() => handleRemoveMember(group.id, member.id)}
                            >
                              Remove
                            </button>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    {#if candidates.length === 0}
                      <p class="muted">All activities are already in this group.</p>
                    {:else}
                      <div class="add-member">
                        <select bind:value={addActivityId} aria-label="Activity to add">
                          <option value={null} disabled selected>Choose an activity…</option>
                          {#each candidates as activity (activity.id)}
                            <option value={activity.id}>{activity.matcher} ({activity.kind})</option>
                          {/each}
                        </select>
                        <button
                          disabled={mutatingMembership || addActivityId === null}
                          onclick={() => handleAddMember(group.id)}
                        >
                          {mutatingMembership ? "Adding…" : "Add to group"}
                        </button>
                      </div>
                    {/if}
                  </div>
                {/if}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
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
    flex: 1 1 12rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
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
  tr.detail td {
    background: #f9fafb;
  }
  .members {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .member-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .member-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .add-member {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .add-member select {
    flex: 1 1 16rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.3rem;
    background: #fff;
  }
  code {
    font-size: 0.85rem;
    color: #111827;
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
  button.small {
    padding: 0.2rem 0.5rem;
    font-size: 0.8rem;
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
    margin: 0;
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
