<!--
  Activities editor (#189): the remaining-editor slice repeating the Users-editor
  pattern (#53). Loads `/api/activities` on mount (browser only — the page is
  prerendered to a static shell), supports create, inline edit, and delete. All
  calls go through the typed `$lib/api/activities` wrappers; errors are surfaced
  inline rather than thrown away.

  An `Activity` is a matcher that budgets/schedules can target: a `kind` (app /
  domain, individually or as a named group) plus a `matcher` string interpreted
  per `matchType` (exact / substring / glob / regex — ADR 0006). A `regex` that
  does not compile is a 400 from the server, surfaced inline.

  The kind/match-type option lists are declared locally and typed against the
  inferred `ActivityKind`/`MatchType` so they stay in step with the source enums
  without importing server runtime values into the bundle.

  UI consolidation: the Activity Groups editor used to be its own top-level nav
  section. It is closely related (groups bundle the activities managed here), so
  it now lives below the activities CRUD as a second section of this view. It is
  still the self-contained `ActivityGroupsView` component — unchanged and
  independently testable — just composed in here rather than reached via its own
  nav entry.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type { ActivityKind, ActivityResponse, MatchType } from "$lib/api/contract.js";
  import { createActivity, deleteActivity, updateActivity } from "$lib/api/activities.js";
  import { activitiesResource } from "$lib/data/resources.svelte.js";
  import ActivityGroupsView from "./ActivityGroupsView.svelte";

  const KIND_OPTIONS: ReadonlyArray<{ value: ActivityKind; label: string }> = [
    { value: "app", label: "App" },
    { value: "app_group", label: "App group" },
    { value: "domain", label: "Domain" },
    { value: "domain_group", label: "Domain group" },
  ];

  const MATCH_TYPE_OPTIONS: ReadonlyArray<{ value: MatchType; label: string }> = [
    { value: "exact", label: "Exact" },
    { value: "substring", label: "Substring" },
    { value: "glob", label: "Glob" },
    { value: "regex", label: "Regex" },
  ];

  function kindLabel(kind: ActivityKind): string {
    return KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
  }

  function matchTypeLabel(matchType: MatchType): string {
    return MATCH_TYPE_OPTIONS.find((o) => o.value === matchType)?.label ?? matchType;
  }

  // The activity list is a shared resource (so the composed ActivityGroupsView
  // reads the same copy rather than re-fetching). This view owns the list, so it
  // shows the resource's load error; `error` below is for its own mutations.
  let error = $state<string | null>(null);
  let displayError = $derived(error ?? activitiesResource.error);

  // Create form.
  let newKind = $state<ActivityKind>("app");
  let newMatcher = $state("");
  let newMatchType = $state<MatchType>("exact");
  let creating = $state(false);

  // Inline edit.
  let editingId = $state<number | null>(null);
  let editKind = $state<ActivityKind>("app");
  let editMatcher = $state("");
  let editMatchType = $state<MatchType>("exact");
  let saving = $state(false);

  onMount(() => activitiesResource.load());

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    creating = true;
    error = null;
    try {
      const created = await createActivity({
        kind: newKind,
        matcher: newMatcher.trim(),
        matchType: newMatchType,
      });
      activitiesResource.set([...activitiesResource.items, created]);
      newKind = "app";
      newMatcher = "";
      newMatchType = "exact";
    } catch (err) {
      error = messageOf(err);
    } finally {
      creating = false;
    }
  }

  function startEdit(activity: ActivityResponse): void {
    editingId = activity.id;
    editKind = activity.kind;
    editMatcher = activity.matcher;
    editMatchType = activity.matchType;
    error = null;
  }

  function cancelEdit(): void {
    editingId = null;
  }

  async function saveEdit(id: number): Promise<void> {
    saving = true;
    error = null;
    try {
      const updated = await updateActivity(id, {
        kind: editKind,
        matcher: editMatcher.trim(),
        matchType: editMatchType,
      });
      activitiesResource.set(activitiesResource.items.map((a) => (a.id === id ? updated : a)));
      editingId = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(activity: ActivityResponse): Promise<void> {
    if (!confirm(`Delete activity "${activity.matcher}"? This cannot be undone.`)) {
      return;
    }
    error = null;
    try {
      await deleteActivity(activity.id);
      activitiesResource.set(activitiesResource.items.filter((a) => a.id !== activity.id));
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
    <h1>Activities</h1>
    <p class="hint">
      Apps and domains that budgets and schedules can target. The match type
      controls how the matcher is interpreted.
    </p>
  </header>

  {#if displayError}
    <p class="error" role="alert">{displayError}</p>
  {/if}

  <form class="create" onsubmit={handleCreate}>
    <select bind:value={newKind} disabled={creating} aria-label="New activity kind">
      {#each KIND_OPTIONS as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
    <select bind:value={newMatchType} disabled={creating} aria-label="New activity match type">
      {#each MATCH_TYPE_OPTIONS as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
    <input
      type="text"
      placeholder="Matcher (e.g. firefox, *.youtube.com)"
      bind:value={newMatcher}
      disabled={creating}
      required
      aria-label="New activity matcher"
    />
    <button type="submit" disabled={creating || newMatcher.trim() === ""}>
      {creating ? "Adding…" : "Add activity"}
    </button>
  </form>

  {#if activitiesResource.loading}
    <p class="muted">Loading activities…</p>
  {:else if activitiesResource.items.length === 0}
    <p class="muted">No activities yet. Add one above.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Kind</th>
          <th>Match type</th>
          <th>Matcher</th>
          <th class="actions-col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each activitiesResource.items as activity (activity.id)}
          <tr>
            {#if editingId === activity.id}
              <td>
                <select bind:value={editKind} aria-label="Edit kind">
                  {#each KIND_OPTIONS as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              </td>
              <td>
                <select bind:value={editMatchType} aria-label="Edit match type">
                  {#each MATCH_TYPE_OPTIONS as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              </td>
              <td><input bind:value={editMatcher} aria-label="Edit matcher" /></td>
              <td class="actions">
                <button
                  onclick={() => saveEdit(activity.id)}
                  disabled={saving || editMatcher.trim() === ""}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button class="ghost" onclick={cancelEdit} disabled={saving}>Cancel</button>
              </td>
            {:else}
              <td>{kindLabel(activity.kind)}</td>
              <td class="muted">{matchTypeLabel(activity.matchType)}</td>
              <td><code>{activity.matcher}</code></td>
              <td class="actions">
                <button class="ghost" onclick={() => startEdit(activity)}>Edit</button>
                <button class="danger" onclick={() => handleDelete(activity)}>Delete</button>
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<div class="subview">
  <ActivityGroupsView />
</div>

<style>
  h1 {
    margin: 0;
    font-size: 1.3rem;
  }
  .subview {
    margin-top: 2.5rem;
    padding-top: 1.75rem;
    border-top: 1px solid #e5e7eb;
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
