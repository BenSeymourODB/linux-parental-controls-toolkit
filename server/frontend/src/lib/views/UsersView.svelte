<!--
  Users editor (#53): the first full CRUD surface, the pattern the deferred
  editors repeat. Loads `/api/users` on mount (browser only — the page is
  prerendered to a static shell), supports create, inline edit, and delete.
  All calls go through the typed `$lib/api/users` wrappers; errors are surfaced
  inline rather than thrown away.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type { UserResponse } from "$lib/api/contract.js";
  import { createUser, deleteUser, listUsers, updateUser } from "$lib/api/users.js";

  let users = $state<UserResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Create form.
  let newName = $state("");
  let newTz = $state("");
  let creating = $state(false);

  // Inline edit.
  let editingId = $state<number | null>(null);
  let editName = $state("");
  let editTz = $state("");
  let saving = $state(false);

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      users = await listUsers();
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    creating = true;
    error = null;
    try {
      const tz = newTz.trim();
      const created = await createUser({
        displayName: newName.trim(),
        ...(tz === "" ? {} : { tz }),
      });
      users = [...users, created];
      newName = "";
      newTz = "";
    } catch (err) {
      error = messageOf(err);
    } finally {
      creating = false;
    }
  }

  function startEdit(user: UserResponse): void {
    editingId = user.id;
    editName = user.displayName;
    editTz = user.tz ?? "";
    error = null;
  }

  function cancelEdit(): void {
    editingId = null;
  }

  async function saveEdit(id: number): Promise<void> {
    saving = true;
    error = null;
    try {
      const tz = editTz.trim();
      const updated = await updateUser(id, { displayName: editName, tz: tz === "" ? null : tz });
      users = users.map((u) => (u.id === id ? updated : u));
      editingId = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(user: UserResponse): Promise<void> {
    if (!confirm(`Delete user "${user.displayName}"? This cannot be undone.`)) {
      return;
    }
    error = null;
    try {
      await deleteUser(user.id);
      users = users.filter((u) => u.id !== user.id);
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

  /** Format an ISO-8601 UTC timestamp as a short local date. */
  function formatDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
  }
</script>

<section>
  <header class="head">
    <h1>Users</h1>
    <p class="hint">Supervised user accounts. Time and content limits attach to these.</p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <form class="create" onsubmit={handleCreate}>
    <input
      type="text"
      placeholder="Display name"
      bind:value={newName}
      disabled={creating}
      required
      aria-label="New user display name"
    />
    <input
      type="text"
      placeholder="Timezone (optional, e.g. Europe/London)"
      bind:value={newTz}
      disabled={creating}
      aria-label="New user timezone"
    />
    <button type="submit" disabled={creating || newName.trim() === ""}>
      {creating ? "Adding…" : "Add user"}
    </button>
  </form>

  {#if loading}
    <p class="muted">Loading users…</p>
  {:else if users.length === 0}
    <p class="muted">No users yet. Add one above.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Display name</th>
          <th>Timezone</th>
          <th>Created</th>
          <th class="actions-col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each users as user (user.id)}
          <tr>
            {#if editingId === user.id}
              <td><input bind:value={editName} aria-label="Edit display name" /></td>
              <td>
                <input
                  bind:value={editTz}
                  placeholder="(server default)"
                  aria-label="Edit timezone"
                />
              </td>
              <td class="muted">{formatDate(user.createdAt)}</td>
              <td class="actions">
                <button onclick={() => saveEdit(user.id)} disabled={saving || editName.trim() === ""}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button class="ghost" onclick={cancelEdit} disabled={saving}>Cancel</button>
              </td>
            {:else}
              <td>{user.displayName}</td>
              <td class="muted">{user.tz ?? "—"}</td>
              <td class="muted">{formatDate(user.createdAt)}</td>
              <td class="actions">
                <button class="ghost" onclick={() => startEdit(user)}>Edit</button>
                <button class="danger" onclick={() => handleDelete(user)}>Delete</button>
              </td>
            {/if}
          </tr>
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
  td input {
    width: 100%;
    padding: 0.35rem 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.3rem;
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
