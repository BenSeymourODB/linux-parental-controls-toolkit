<!--
  Clients editor (#189): the remaining-editor slice repeating the Users-editor
  pattern (#53). Loads `/api/clients` on mount (browser only — the page is
  prerendered to a static shell), supports create, inline edit, and delete. All
  calls go through the typed `$lib/api/clients` wrappers; errors are surfaced
  inline rather than thrown away.

  A `Client` is the supervised Linux desktop record. `enrolledAt`/`lastSeen` are
  server-owned and read-only here; the richer reachability/health view is
  Phase 3 / #81.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type { ClientResponse } from "$lib/api/contract.js";
  import {
    createClient,
    deleteClient,
    listClients,
    updateClient,
  } from "$lib/api/clients.js";

  let clients = $state<ClientResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Create form.
  let newHostname = $state("");
  let newSshUser = $state("");
  let creating = $state(false);

  // Inline edit.
  let editingId = $state<number | null>(null);
  let editHostname = $state("");
  let editSshUser = $state("");
  let saving = $state(false);

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      clients = await listClients();
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
      const created = await createClient({
        hostname: newHostname.trim(),
        sshUser: newSshUser.trim(),
      });
      clients = [...clients, created];
      newHostname = "";
      newSshUser = "";
    } catch (err) {
      error = messageOf(err);
    } finally {
      creating = false;
    }
  }

  function startEdit(client: ClientResponse): void {
    editingId = client.id;
    editHostname = client.hostname;
    editSshUser = client.sshUser;
    error = null;
  }

  function cancelEdit(): void {
    editingId = null;
  }

  async function saveEdit(id: number): Promise<void> {
    saving = true;
    error = null;
    try {
      const updated = await updateClient(id, {
        hostname: editHostname.trim(),
        sshUser: editSshUser.trim(),
      });
      clients = clients.map((c) => (c.id === id ? updated : c));
      editingId = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(client: ClientResponse): Promise<void> {
    if (!confirm(`Delete client "${client.hostname}"? This cannot be undone.`)) {
      return;
    }
    error = null;
    try {
      await deleteClient(client.id);
      clients = clients.filter((c) => c.id !== client.id);
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

  /** Format an ISO-8601 UTC timestamp as a short local date, or a dash. */
  function formatDate(iso: string | null): string {
    if (iso === null) {
      return "—";
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
  }

  const canSaveEdit = $derived(editHostname.trim() !== "" && editSshUser.trim() !== "");
</script>

<section>
  <header class="head">
    <h1>Clients</h1>
    <p class="hint">Supervised Linux desktops the dashboard pushes policy to.</p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <form class="create" onsubmit={handleCreate}>
    <input
      type="text"
      placeholder="Hostname (e.g. mint-living-room)"
      bind:value={newHostname}
      disabled={creating}
      required
      aria-label="New client hostname"
    />
    <input
      type="text"
      placeholder="SSH user (e.g. pct-agent)"
      bind:value={newSshUser}
      disabled={creating}
      required
      aria-label="New client SSH user"
    />
    <button
      type="submit"
      disabled={creating || newHostname.trim() === "" || newSshUser.trim() === ""}
    >
      {creating ? "Adding…" : "Add client"}
    </button>
  </form>

  {#if loading}
    <p class="muted">Loading clients…</p>
  {:else if clients.length === 0}
    <p class="muted">No clients yet. Add one above.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Hostname</th>
          <th>SSH user</th>
          <th>Enrolled</th>
          <th>Last seen</th>
          <th class="actions-col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each clients as client (client.id)}
          <tr>
            {#if editingId === client.id}
              <td><input bind:value={editHostname} aria-label="Edit hostname" /></td>
              <td><input bind:value={editSshUser} aria-label="Edit SSH user" /></td>
              <td class="muted">{formatDate(client.enrolledAt)}</td>
              <td class="muted">{formatDate(client.lastSeen)}</td>
              <td class="actions">
                <button onclick={() => saveEdit(client.id)} disabled={saving || !canSaveEdit}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button class="ghost" onclick={cancelEdit} disabled={saving}>Cancel</button>
              </td>
            {:else}
              <td>{client.hostname}</td>
              <td class="muted">{client.sshUser}</td>
              <td class="muted">{formatDate(client.enrolledAt)}</td>
              <td class="muted">{formatDate(client.lastSeen)}</td>
              <td class="actions">
                <button class="ghost" onclick={() => startEdit(client)}>Edit</button>
                <button class="danger" onclick={() => handleDelete(client)}>Delete</button>
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
