<!--
  Client health/status + enrol flow (#194, frontend half of #81).

  Read-only operational view over `GET /api/clients/health`: per enrolled
  client it shows reachability, the health of the five supervised components,
  and the offline + queued-change state, plus an "enrol a new client" panel
  that mints a scoped, single-use token (`POST /api/clients/enrolment-tokens`)
  and renders the documented install one-liner.

  Reachability/component health is reported `unknown` until the live SSH prober
  is wired (#39 plumbs the credentials; the prober injection lands with the
  live transport). This view renders that degraded state gracefully — real
  enrolment + queue data still shows. All calls go through the typed
  `$lib/api/*` wrappers; nothing here mutates client policy.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { browser } from "$app/environment";
  import { ApiError } from "$lib/api/client.js";
  import type {
    ClientHealthResponse,
    ComponentHealthDto,
    EnrolmentTokenResponse,
    UserResponse,
  } from "$lib/api/contract.js";
  import { listClientHealth } from "$lib/api/client-health.js";
  import { mintEnrolmentToken } from "$lib/api/clients.js";
  import { listUsers } from "$lib/api/users.js";

  let clients = $state<ClientHealthResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Per-client queue-detail expand/collapse, keyed by clientId.
  let expanded = $state<Record<number, boolean>>({});

  // Enrol flow.
  let users = $state<UserResponse[]>([]);
  let enrolHostname = $state("");
  let enrolRows = $state<{ userId: number | null; linuxUsername: string }[]>([
    { userId: null, linuxUsername: "" },
  ]);
  let minting = $state(false);
  let minted = $state<EnrolmentTokenResponse | null>(null);
  let mintedUsernames = $state<string[]>([]);
  let enrolError = $state<string | null>(null);
  let copied = $state(false);

  /** Friendly labels for the wire component identifiers. */
  const COMPONENT_LABELS: Record<ComponentHealthDto["component"], string> = {
    "timekpr-next": "Timekpr-nExT",
    activitywatch: "ActivityWatch",
    e2guardian: "e2guardian",
    "pct-client-bridge": "pct-client-bridge",
    "pct-client-agent": "pct-client-agent",
  };

  onMount(() => {
    void load();
    void loadUsers();
  });

  async function load(): Promise<void> {
    if (!browser) {
      return;
    }
    loading = true;
    error = null;
    try {
      clients = await listClientHealth();
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  async function loadUsers(): Promise<void> {
    if (!browser) {
      return;
    }
    try {
      users = await listUsers();
    } catch {
      // The enrol form degrades to "no users yet"; the health list above still
      // renders, so a users-fetch failure must not blank the whole page.
      users = [];
    }
  }

  function toggleQueue(clientId: number): void {
    expanded = { ...expanded, [clientId]: !expanded[clientId] };
  }

  function addEnrolRow(): void {
    enrolRows = [...enrolRows, { userId: null, linuxUsername: "" }];
  }

  function removeEnrolRow(index: number): void {
    enrolRows = enrolRows.filter((_, i) => i !== index);
  }

  /** True when every row names a user + a Linux username and rows are distinct. */
  let enrolReady = $derived(
    enrolRows.length > 0 &&
      enrolRows.every((r) => r.userId !== null && r.linuxUsername.trim() !== "") &&
      new Set(enrolRows.map((r) => r.linuxUsername.trim())).size === enrolRows.length,
  );

  async function handleMint(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!enrolReady) {
      return;
    }
    minting = true;
    enrolError = null;
    minted = null;
    copied = false;
    try {
      const supervisedUsers = enrolRows.map((r) => ({
        userId: r.userId as number,
        linuxUsername: r.linuxUsername.trim(),
      }));
      const hostname = enrolHostname.trim();
      minted = await mintEnrolmentToken({
        supervisedUsers,
        ttlSeconds: 3600,
        ...(hostname === "" ? {} : { hostname }),
      });
      mintedUsernames = supervisedUsers.map((u) => u.linuxUsername);
    } catch (err) {
      enrolError = messageOf(err);
    } finally {
      minting = false;
    }
  }

  function resetEnrol(): void {
    minted = null;
    mintedUsernames = [];
    enrolError = null;
    copied = false;
    enrolHostname = "";
    enrolRows = [{ userId: null, linuxUsername: "" }];
  }

  /** The install one-liner shown to the admin, per `docs/client-install.md`. */
  let installCommand = $derived.by(() => {
    if (minted === null) {
      return "";
    }
    const origin = browser ? window.location.origin : "https://<server>";
    const userFlags = mintedUsernames.map((u) => `    --supervised-user ${u}`).join(" \\\n");
    return (
      `curl -fsSL ${origin}/install-client.sh \\\n` +
      `  | sudo bash -s -- \\\n` +
      `    --enrolment-token ${minted.token} \\\n` +
      userFlags
    );
  });

  async function copyCommand(): Promise<void> {
    if (installCommand === "" || !browser || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(installCommand);
      copied = true;
    } catch {
      copied = false;
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
  function formatDateTime(iso: string | null): string {
    if (iso === null) {
      return "—";
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  function reachabilityClass(reachability: ClientHealthResponse["reachability"]): string {
    if (reachability === "online") {
      return "ok";
    }
    return reachability === "offline" ? "warn" : "unknown";
  }

  function componentClass(status: ComponentHealthDto["status"]): string {
    if (status === "ok") {
      return "ok";
    }
    return status === "unhealthy" ? "bad" : "unknown";
  }
</script>

<section>
  <header class="head">
    <h1>Client Health</h1>
    <p class="hint">
      Reachability and per-component health for every enrolled machine, plus
      what's queued for any client that's offline.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="toolbar">
    <button class="ghost" onclick={() => load()} disabled={loading}>
      {loading ? "Refreshing…" : "Refresh"}
    </button>
  </div>

  {#if loading}
    <p class="muted">Loading client health…</p>
  {:else if clients.length === 0}
    <p class="muted">No clients enrolled yet. Enrol one below.</p>
  {:else}
    <div class="grid">
      {#each clients as client (client.clientId)}
        <article class="card">
          <div class="card-top">
            <div>
              <div class="hostname">{client.hostname}</div>
              <div class="muted small">
                enrolled {formatDateTime(client.enrolledAt)}
              </div>
            </div>
            <span class="pill {reachabilityClass(client.reachability)}">
              {client.reachability}
            </span>
          </div>

          <dl class="kv">
            <div><dt>Last seen</dt><dd>{formatDateTime(client.lastSeen)}</dd></div>
            <div>
              <dt>Last probe</dt>
              <dd>
                {#if client.probedAt === null}
                  <span class="muted">not yet probed</span>
                {:else}
                  {formatDateTime(client.probedAt)}
                {/if}
              </dd>
            </div>
          </dl>

          <div class="components">
            <div class="section-title">Components</div>
            {#each client.components as comp (comp.component)}
              <div class="comp">
                <span class="dot {componentClass(comp.status)}" aria-hidden="true"></span>
                <span class="comp-name">{COMPONENT_LABELS[comp.component] ?? comp.component}</span>
                <span class="muted small">{comp.detail}</span>
              </div>
            {/each}
          </div>

          <div class="queue">
            <div class="queue-head">
              <span class="section-title">Queued changes</span>
              <span class="counts">
                <span class="pill {client.queue.pending > 0 ? 'warn' : 'ok'}">
                  {client.queue.pending} pending
                </span>
                {#if client.queue.failed > 0}
                  <span class="pill bad">{client.queue.failed} failed</span>
                {/if}
              </span>
            </div>
            {#if client.queue.actions.length > 0}
              <button class="link" onclick={() => toggleQueue(client.clientId)}>
                {expanded[client.clientId] ? "Hide" : "Show"} queued actions
                ({client.queue.actions.length})
              </button>
              {#if expanded[client.clientId]}
                <ul class="actions">
                  {#each client.queue.actions as action (action.id)}
                    <li>
                      <span class="mono">{action.kind}</span>
                      <span class="pill {action.status === 'failed' ? 'bad' : 'warn'}">
                        {action.status}
                      </span>
                      <span class="muted small">
                        ×{action.attempts}{action.lastError ? ` · ${action.lastError}` : ""}
                      </span>
                    </li>
                  {/each}
                </ul>
              {/if}
            {:else}
              <p class="muted small">Nothing queued.</p>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}

  <section class="enrol">
    <header class="head">
      <h2>Enrol a new client</h2>
      <p class="hint">
        Mint a one-time, short-lived token scoped to the supervised user(s) this
        machine will carry, then run the printed command on the fresh Mint box.
      </p>
    </header>

    {#if enrolError}
      <p class="error" role="alert">{enrolError}</p>
    {/if}

    {#if minted === null}
      <form onsubmit={handleMint}>
        {#each enrolRows as row, index (index)}
          <div class="enrol-row">
            <select bind:value={row.userId} aria-label="Supervised user">
              <option value={null} disabled>Select a user…</option>
              {#each users as user (user.id)}
                <option value={user.id}>{user.displayName}</option>
              {/each}
            </select>
            <input
              type="text"
              placeholder="Linux username (e.g. chloe)"
              bind:value={row.linuxUsername}
              aria-label="Linux username"
            />
            {#if enrolRows.length > 1}
              <button type="button" class="ghost" onclick={() => removeEnrolRow(index)}>
                Remove
              </button>
            {/if}
          </div>
        {/each}

        <button type="button" class="link" onclick={addEnrolRow}>+ Add another user</button>

        <input
          type="text"
          class="hostname-input"
          placeholder="Expected hostname (optional)"
          bind:value={enrolHostname}
          aria-label="Expected hostname"
        />

        {#if users.length === 0}
          <p class="muted small">Add a user first — the token must be scoped to one.</p>
        {/if}

        <button type="submit" disabled={minting || !enrolReady}>
          {minting ? "Minting…" : "Generate enrolment token"}
        </button>
      </form>
    {:else}
      <div class="minted">
        <p class="muted small">
          Run this on the client — the token expires {formatDateTime(minted.expiresAt)} and works
          once:
        </p>
        <pre class="command">{installCommand}</pre>
        <div class="minted-actions">
          <button onclick={() => copyCommand()}>{copied ? "Copied!" : "Copy command"}</button>
          <button class="ghost" onclick={resetEnrol}>Mint another</button>
        </div>
      </div>
    {/if}
  </section>
</section>

<style>
  h1 {
    margin: 0;
    font-size: 1.3rem;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .hint {
    margin: 0.25rem 0 1rem;
    color: #6b7280;
    font-size: 0.9rem;
  }
  .toolbar {
    margin-bottom: 1rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
    gap: 1rem;
  }
  .card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 0.6rem;
    padding: 1rem;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .card-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .hostname {
    font-weight: 650;
  }
  .kv {
    margin: 0;
    display: grid;
    gap: 0.2rem;
  }
  .kv div {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
    border-bottom: 1px dashed #f3f4f6;
    padding: 0.2rem 0;
  }
  .kv dt {
    color: #6b7280;
  }
  .kv dd {
    margin: 0;
  }
  .section-title {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9ca3af;
    font-weight: 600;
  }
  .components {
    border-top: 1px solid #f3f4f6;
    padding-top: 0.5rem;
  }
  .comp {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    font-size: 0.85rem;
  }
  .comp-name {
    font-weight: 500;
  }
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex: none;
    background: #9ca3af;
  }
  .dot.ok {
    background: #16a34a;
  }
  .dot.bad {
    background: #dc2626;
  }
  .dot.unknown {
    background: #9ca3af;
  }
  .queue {
    border-top: 1px solid #f3f4f6;
    padding-top: 0.5rem;
  }
  .queue-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }
  .counts {
    display: flex;
    gap: 0.35rem;
  }
  .actions {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }
  .actions li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    background: #e5e7eb;
    color: #374151;
  }
  .pill.ok {
    background: #dcfce7;
    color: #166534;
  }
  .pill.warn {
    background: #fef3c7;
    color: #92400e;
  }
  .pill.bad {
    background: #fee2e2;
    color: #991b1b;
  }
  .pill.unknown {
    background: #e5e7eb;
    color: #4b5563;
  }
  .enrol {
    margin-top: 2rem;
    border-top: 1px solid #e5e7eb;
    padding-top: 1.5rem;
  }
  .enrol form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    max-width: 40rem;
  }
  .enrol-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .enrol-row select,
  .enrol-row input {
    flex: 1 1 12rem;
  }
  select,
  input {
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    font-size: 0.9rem;
  }
  .hostname-input {
    max-width: 40rem;
  }
  .command {
    background: #0f1222;
    color: #9be7b6;
    padding: 0.75rem 0.9rem;
    border-radius: 0.5rem;
    font-size: 0.8rem;
    overflow-x: auto;
    white-space: pre;
    margin: 0.5rem 0;
  }
  .minted-actions {
    display: flex;
    gap: 0.5rem;
  }
  .small {
    font-size: 0.8rem;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
  }
  button {
    padding: 0.4rem 0.7rem;
    border: none;
    border-radius: 0.4rem;
    background: #2563eb;
    color: #fff;
    cursor: pointer;
    font-size: 0.85rem;
    align-self: flex-start;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  button.ghost {
    background: #e5e7eb;
    color: #374151;
  }
  button.link {
    background: none;
    color: #2563eb;
    padding: 0;
    font-size: 0.85rem;
    align-self: flex-start;
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
