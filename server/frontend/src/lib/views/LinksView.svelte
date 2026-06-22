<!--
  User ↔ Client links editor (#189): repeats the Users/Activities pattern (#53)
  but scoped to one user at a time, since the link routes are nested under the
  user. Loads the users + clients lists on mount (browser only — the page is
  prerendered to a static shell); picking a user loads that user's links. All
  calls go through the typed `$lib/api/links` wrappers; errors are surfaced
  inline.

  A link maps a policy `User` to an OS account (`osUsername` + `osUserRef`)
  on a specific `Client` — the mapping enforcement needs to drive `timekpra`
  and read ActivityWatch for the right OS account. `osUserRef` is the OS-neutral
  account reference (#230): a uid on Linux, a SID on Windows. The `PUT` is
  idempotent, so the same form both creates and updates a link.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type { ClientResponse, LinkResponse, UserResponse } from "$lib/api/contract.js";
  import { listUsers } from "$lib/api/users.js";
  import { listClients } from "$lib/api/clients.js";
  import { listUserLinks, upsertLink, deleteLink } from "$lib/api/links.js";

  let users = $state<UserResponse[]>([]);
  let clients = $state<ClientResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // The selected user whose links are shown.
  let selectedUserId = $state<number | null>(null);
  let links = $state<LinkResponse[]>([]);
  let linksLoading = $state(false);

  // Create/update form.
  let formClientId = $state<number | null>(null);
  let formOsUsername = $state("");
  let formOsUserRef = $state("");
  let submitting = $state(false);

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

  /** Clients the selected user is not yet linked to — the add-dropdown options. */
  let candidateClients = $derived(
    clients.filter((c) => !links.some((l) => l.clientId === c.id)),
  );

  /**
   * Whether the OS-user-ref field is a valid account reference (#230): a
   * non-empty token matching the same `[A-Za-z0-9._:-]` charset the `/api`
   * `upsertLink` DTO enforces (a uid on Linux, a SID on Windows). Mirrors the
   * server rule so the form gives early feedback; the server stays the
   * authority.
   */
  function osUserRefValid(value: string): boolean {
    return /^[A-Za-z0-9._:-]+$/.test(value.trim());
  }

  async function onSelectUser(): Promise<void> {
    resetForm();
    if (selectedUserId === null) {
      links = [];
      return;
    }
    linksLoading = true;
    error = null;
    try {
      links = await listUserLinks(selectedUserId);
    } catch (err) {
      error = messageOf(err);
      links = [];
    } finally {
      linksLoading = false;
    }
  }

  function resetForm(): void {
    formClientId = null;
    formOsUsername = "";
    formOsUserRef = "";
  }

  let submitDisabled = $derived(
    submitting ||
      formClientId === null ||
      formOsUsername.trim() === "" ||
      !osUserRefValid(formOsUserRef),
  );

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (selectedUserId === null || formClientId === null || !osUserRefValid(formOsUserRef)) {
      return;
    }
    submitting = true;
    error = null;
    try {
      const saved = await upsertLink(selectedUserId, formClientId, {
        osUsername: formOsUsername.trim(),
        osUserRef: formOsUserRef.trim(),
      });
      // `PUT` is upsert: replace an existing link to this client, else append.
      const existing = links.some((l) => l.clientId === saved.clientId);
      links = existing
        ? links.map((l) => (l.clientId === saved.clientId ? saved : l))
        : [...links, saved];
      resetForm();
    } catch (err) {
      error = messageOf(err);
    } finally {
      submitting = false;
    }
  }

  /** Load a link's values into the form so the upsert updates it. */
  function startEdit(link: LinkResponse): void {
    formClientId = link.clientId;
    formOsUsername = link.osUsername;
    formOsUserRef = link.osUserRef;
    error = null;
  }

  async function handleDelete(link: LinkResponse): Promise<void> {
    if (selectedUserId === null) {
      return;
    }
    if (!confirm(`Remove the link to ${clientName(link.clientId)}? This cannot be undone.`)) {
      return;
    }
    error = null;
    try {
      await deleteLink(selectedUserId, link.clientId);
      links = links.filter((l) => l.clientId !== link.clientId);
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
    <h1>User ↔ Client links</h1>
    <p class="hint">
      Map a supervised user to their OS account (username + account reference —
      a UID on Linux) on each client. Enforcement uses this mapping to target
      the right OS account.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if users.length === 0}
    <p class="muted">Add a user first — links are per user.</p>
  {:else}
    <div class="picker">
      <label for="link-user">User</label>
      <select id="link-user" bind:value={selectedUserId} onchange={onSelectUser}>
        <option value={null} disabled selected>Choose a user…</option>
        {#each users as user (user.id)}
          <option value={user.id}>{user.displayName}</option>
        {/each}
      </select>
    </div>

    {#if selectedUserId !== null}
      {#if clients.length === 0}
        <p class="muted">Enrol a client first — there's nothing to link to yet.</p>
      {:else}
        <form class="create" onsubmit={handleSubmit}>
          <select bind:value={formClientId} disabled={submitting} aria-label="Client" required>
            <option value={null} disabled selected>Choose a client…</option>
            {#each candidateClients as client (client.id)}
              <option value={client.id}>{client.hostname}</option>
            {/each}
            <!-- Editing an existing link keeps its client selectable. -->
            {#each links as link (link.clientId)}
              {#if !candidateClients.some((c) => c.id === link.clientId)}
                <option value={link.clientId}>{clientName(link.clientId)}</option>
              {/if}
            {/each}
          </select>
          <input
            type="text"
            placeholder="OS username"
            bind:value={formOsUsername}
            disabled={submitting}
            required
            aria-label="OS username"
          />
          <input
            type="text"
            inputmode="numeric"
            placeholder="UID"
            bind:value={formOsUserRef}
            disabled={submitting}
            required
            aria-label="OS user reference (UID on Linux)"
          />
          <button type="submit" disabled={submitDisabled}>
            {submitting ? "Saving…" : "Save link"}
          </button>
        </form>

        {#if linksLoading}
          <p class="muted">Loading links…</p>
        {:else if links.length === 0}
          <p class="muted">No links for this user yet. Add one above.</p>
        {:else}
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>OS username</th>
                <th>User ref</th>
                <th class="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each links as link (link.clientId)}
                <tr>
                  <td>{clientName(link.clientId)}</td>
                  <td><code>{link.osUsername}</code></td>
                  <td class="muted">{link.osUserRef}</td>
                  <td class="actions">
                    <button class="ghost" onclick={() => startEdit(link)}>Edit</button>
                    <button class="danger" onclick={() => handleDelete(link)}>Delete</button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
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
  .create {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
  }
  .create input {
    flex: 0 1 12rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
  }
  .create select {
    flex: 1 1 12rem;
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
