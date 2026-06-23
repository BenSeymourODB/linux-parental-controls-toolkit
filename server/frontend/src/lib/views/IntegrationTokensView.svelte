<!--
  Integration tokens editor (#250): the admin surface for the per-integration
  API tokens whose backend landed in #114. Loads `/api/integrations/tokens` on
  mount (browser only — the page is prerendered to a static shell), supports
  minting a scoped token and revoking one. All calls go through the typed
  `$lib/api/integration-tokens` wrappers; errors are surfaced inline.

  A token is a scoped, revocable machine credential an external system (e.g. the
  family calendar) uses on the inbound `/api/integrations/*` endpoints. The
  plaintext secret is returned by the mint call **once** — only its hash is
  stored — so this view reveals it a single time with a copy affordance and a
  clear "you won't see it again" warning, mirroring the enrol-a-client flow.

  Per-token rate display/limiting is #115 and the summary DTO carries no rate
  data, so the rate column in the mock (`design/admin/integrations.html`) is
  deliberately omitted from this slice.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { browser } from "$app/environment";
  import { ApiError } from "$lib/api/client.js";
  import type {
    IntegrationScope,
    IntegrationTokenCreatedResponse,
    IntegrationTokenSummaryResponse,
  } from "$lib/api/contract.js";
  import {
    createIntegrationToken,
    listIntegrationTokens,
    revokeIntegrationToken,
  } from "$lib/api/integration-tokens.js";

  // Runtime scope vocabulary for the create form, typed against the contract's
  // `IntegrationScope` so it can never drift from the set the server accepts
  // (the same drift-checked pattern `BudgetsView` uses for `WINDOW_OPTIONS`).
  const SCOPE_OPTIONS: ReadonlyArray<{
    value: IntegrationScope;
    description: string;
  }> = [
    { value: "grants:write", description: "Create grants — award screen time" },
    { value: "policy:read", description: "Read effective policy and status" },
  ];

  let tokens = $state<IntegrationTokenSummaryResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Create form.
  let newName = $state("");
  let selectedScopes = $state<IntegrationScope[]>([]);
  let creating = $state(false);

  // The just-minted token whose plaintext secret is shown exactly once.
  let minted = $state<IntegrationTokenCreatedResponse | null>(null);
  let copied = $state(false);

  // Revoke in flight, by token id (so only that row's button shows progress).
  let revokingId = $state<number | null>(null);

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      tokens = await listIntegrationTokens();
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  function toggleScope(scope: IntegrationScope, checked: boolean): void {
    selectedScopes = checked
      ? [...selectedScopes.filter((s) => s !== scope), scope]
      : selectedScopes.filter((s) => s !== scope);
  }

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    creating = true;
    error = null;
    copied = false;
    try {
      const created = await createIntegrationToken({
        name: newName.trim(),
        scopes: selectedScopes,
      });
      minted = created;
      tokens = [
        ...tokens,
        {
          id: created.id,
          name: created.name,
          scopes: created.scopes,
          createdAt: created.createdAt,
          lastUsedAt: null,
          revokedAt: null,
        },
      ];
      newName = "";
      selectedScopes = [];
    } catch (err) {
      error = messageOf(err);
    } finally {
      creating = false;
    }
  }

  function dismissSecret(): void {
    minted = null;
    copied = false;
  }

  async function copySecret(): Promise<void> {
    if (minted === null || !browser || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(minted.secret);
      copied = true;
    } catch {
      copied = false;
    }
  }

  async function handleRevoke(token: IntegrationTokenSummaryResponse): Promise<void> {
    if (!confirm(`Revoke token "${token.name}"? Integrations using it stop working immediately.`)) {
      return;
    }
    revokingId = token.id;
    error = null;
    try {
      const updated = await revokeIntegrationToken(token.id);
      tokens = tokens.map((t) => (t.id === token.id ? updated : t));
    } catch (err) {
      error = messageOf(err);
    } finally {
      revokingId = null;
    }
  }

  /** Render any thrown value as a UI-safe message. */
  function messageOf(err: unknown): string {
    if (err instanceof ApiError) {
      return err.message;
    }
    return err instanceof Error ? err.message : "Something went wrong";
  }

  /** Format an ISO-8601 UTC timestamp as a short local date-time, or a dash. */
  function formatDate(iso: string | null): string {
    if (iso === null) {
      return "—";
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }
</script>

<section>
  <header class="head">
    <h1>Integrations</h1>
    <p class="hint">
      Scoped, revocable API tokens for external systems. All inbound traffic goes through
      <code>/api/integrations/*</code> and authenticates with one of these tokens.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <form class="create" onsubmit={handleCreate}>
    <input
      type="text"
      placeholder="Integration name (e.g. calendar)"
      bind:value={newName}
      disabled={creating}
      required
      aria-label="New token name"
    />
    <fieldset class="scopes" disabled={creating}>
      <legend>Scopes</legend>
      {#each SCOPE_OPTIONS as option (option.value)}
        <label class="scope-opt">
          <input
            type="checkbox"
            checked={selectedScopes.includes(option.value)}
            onchange={(e) => toggleScope(option.value, e.currentTarget.checked)}
            aria-label={`Scope ${option.value}`}
          />
          <span class="scope-name">{option.value}</span>
          <span class="scope-desc">{option.description}</span>
        </label>
      {/each}
    </fieldset>
    <button type="submit" disabled={creating || newName.trim() === "" || selectedScopes.length === 0}>
      {creating ? "Minting…" : "Mint token"}
    </button>
  </form>

  {#if minted}
    <div class="secret" role="status">
      <div class="secret-head">
        <strong>Token “{minted.name}” minted.</strong>
        <button class="ghost" onclick={dismissSecret}>Dismiss</button>
      </div>
      <p class="warn">
        Copy the secret now — it is shown <strong>once</strong> and cannot be retrieved again.
      </p>
      <div class="secret-row">
        <code class="secret-value">{minted.secret}</code>
        <button onclick={copySecret}>{copied ? "Copied!" : "Copy secret"}</button>
      </div>
    </div>
  {/if}

  {#if loading}
    <p class="muted">Loading tokens…</p>
  {:else if tokens.length === 0}
    <p class="muted">No integration tokens yet. Mint one above.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Scopes</th>
          <th>Created</th>
          <th>Last used</th>
          <th>State</th>
          <th class="actions-col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each tokens as token (token.id)}
          <tr class:revoked={token.revokedAt !== null}>
            <td>{token.name}</td>
            <td class="chips">
              {#each token.scopes as scope (scope)}
                <span class="chip">{scope}</span>
              {/each}
            </td>
            <td class="muted">{formatDate(token.createdAt)}</td>
            <td class="muted">{formatDate(token.lastUsedAt)}</td>
            <td>
              {#if token.revokedAt === null}
                <span class="badge active">active</span>
              {:else}
                <span class="badge revoked" title={`Revoked ${formatDate(token.revokedAt)}`}>
                  revoked
                </span>
              {/if}
            </td>
            <td class="actions">
              {#if token.revokedAt === null}
                <button
                  class="danger"
                  onclick={() => handleRevoke(token)}
                  disabled={revokingId === token.id}
                >
                  {revokingId === token.id ? "Revoking…" : "Revoke"}
                </button>
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
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
  code {
    background: #f3f4f6;
    padding: 0.1rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.85em;
  }
  .create {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
    align-items: flex-end;
  }
  .create input[type="text"] {
    flex: 1 1 14rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
  }
  .scopes {
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    padding: 0.4rem 0.75rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .scopes legend {
    font-size: 0.8rem;
    color: #374151;
    font-weight: 600;
    padding: 0 0.3rem;
  }
  .scope-opt {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 0.4rem;
    align-items: baseline;
    font-size: 0.85rem;
  }
  .scope-name {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 600;
  }
  .scope-desc {
    color: #6b7280;
  }
  .secret {
    margin-bottom: 1.25rem;
    padding: 0.75rem 0.9rem;
    border: 1px solid #fcd34d;
    background: #fffbeb;
    border-radius: 0.5rem;
  }
  .secret-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }
  .warn {
    margin: 0.4rem 0;
    color: #92400e;
    font-size: 0.85rem;
  }
  .secret-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .secret-value {
    flex: 1 1 16rem;
    background: #fff;
    border: 1px solid #e5e7eb;
    padding: 0.45rem 0.55rem;
    word-break: break-all;
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
    vertical-align: top;
  }
  th {
    background: #f9fafb;
    font-weight: 600;
    color: #374151;
  }
  tr.revoked td {
    opacity: 0.6;
  }
  .chips {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .chip {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
    border-radius: 0.3rem;
    background: #eef2ff;
    color: #3730a3;
    font-weight: 600;
  }
  .badge {
    font-size: 0.72rem;
    padding: 0.15rem 0.45rem;
    border-radius: 0.3rem;
    font-weight: 600;
  }
  .badge.active {
    background: #dcfce7;
    color: #166534;
  }
  .badge.revoked {
    background: #fee2e2;
    color: #991b1b;
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
