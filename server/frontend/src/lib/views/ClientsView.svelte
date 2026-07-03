<!--
  Clients view (#305): the single place to see, enrol, and manage the
  supervised Linux desktops the dashboard pushes policy to. This merges the
  former "Clients" inventory editor (#189) and "Client Health" status board
  (#194) into one surface so there is one home for clients and one canonical
  way to enrol them.

  Per client it shows the inventory facts (hostname, SSH user, enrolled/last
  seen) alongside the operational health (reachability, per-component health,
  offline + queued-change state), with inline edit/delete. The primary action
  is the enrolment-token flow — mint a scoped, single-use token
  (`POST /api/clients/enrolment-tokens`) and render the documented install
  one-liner. The lower-level manual record-create (`POST /api/clients`) is kept
  as an API-only escape hatch (scripts/tests/integrations), deliberately off the
  admin surface (#305): it writes a bare row with no event-stream credential and
  no supervised-user links, and collides with a later real enrolment of the same
  hostname, so it isn't a path the admin should reach for. Any such record still
  renders here, flagged "not enrolled".

  Reachability/component health is reported `unknown` until the live SSH prober
  is wired (#39); this view renders that degraded state gracefully — inventory
  and queue data still show. All calls go through the typed `$lib/api/*`
  wrappers; nothing here links to a GPL component.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { browser } from "$app/environment";
  import { ApiError } from "$lib/api/client.js";
  import type {
    ClientResponse,
    ClientHealthResponse,
    ComponentHealthDto,
    EnrolmentTokenResponse,
    UserResponse,
  } from "$lib/api/contract.js";
  import {
    deleteClient,
    listClients,
    updateClient,
    mintEnrolmentToken,
  } from "$lib/api/clients.js";
  import { listClientHealth } from "$lib/api/client-health.js";
  import { listUsers } from "$lib/api/users.js";

  // Inventory is the spine (it carries sshUser + the enrolled flag + identity
  // for edit/delete); health is joined in by clientId and degrades to "unknown"
  // when a probe hasn't run or the health fetch fails.
  let clients = $state<ClientResponse[]>([]);
  let health = $state<ClientHealthResponse[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  // Non-blocking: set when the health fetch fails so the admin can tell
  // "health service is down" apart from "clients genuinely un-probed". The
  // inventory still renders regardless.
  let healthError = $state<string | null>(null);

  // Per-client queue-detail expand/collapse, keyed by clientId.
  let expanded = $state<Record<number, boolean>>({});

  // Inline edit.
  let editingId = $state<number | null>(null);
  let editHostname = $state("");
  let editSshUser = $state("");
  let saving = $state(false);

  // Enrol flow.
  let users = $state<UserResponse[]>([]);
  let enrolHostname = $state("");
  let enrolRows = $state<{ userId: number | null; osUsername: string }[]>([
    { userId: null, osUsername: "" },
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

  type MergedClient = { client: ClientResponse; health: ClientHealthResponse | null };

  let healthById = $derived(new Map(health.map((h) => [h.clientId, h])));
  let merged = $derived<MergedClient[]>(
    clients.map((c) => ({ client: c, health: healthById.get(c.id) ?? null })),
  );

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
    healthError = null;
    try {
      // Inventory is required; a health-fetch failure degrades to "unknown"
      // rather than blanking the whole list, but is surfaced non-blockingly
      // (below) so the lost signal isn't silently swallowed.
      const [inv, h] = await Promise.all([
        listClients(),
        listClientHealth().catch((err) => {
          healthError = messageOf(err);
          return [] as ClientHealthResponse[];
        }),
      ]);
      clients = inv;
      health = h;
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
      // The enrol form degrades to "no users yet"; the list above still
      // renders, so a users-fetch failure must not blank the page.
      users = [];
    }
  }

  function toggleQueue(clientId: number): void {
    expanded = { ...expanded, [clientId]: !expanded[clientId] };
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
      health = health.filter((h) => h.clientId !== client.id);
      // Drop any queue-expand state so it can't go stale / leak for a reused id.
      const { [client.id]: _removed, ...rest } = expanded;
      expanded = rest;
    } catch (err) {
      error = messageOf(err);
    }
  }

  function addEnrolRow(): void {
    enrolRows = [...enrolRows, { userId: null, osUsername: "" }];
  }

  function removeEnrolRow(index: number): void {
    enrolRows = enrolRows.filter((_, i) => i !== index);
  }

  /** True when every row names a user + an OS username and rows are distinct. */
  let enrolReady = $derived(
    enrolRows.length > 0 &&
      enrolRows.every((r) => r.userId !== null && r.osUsername.trim() !== "") &&
      new Set(enrolRows.map((r) => r.osUsername.trim())).size === enrolRows.length,
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
      // `enrolReady` already guarantees every row has a non-null userId; this
      // loop narrows the type without an `as` cast (CLAUDE.md → no casts).
      const supervisedUsers: { userId: number; osUsername: string }[] = [];
      for (const r of enrolRows) {
        if (r.userId === null) {
          return;
        }
        supervisedUsers.push({ userId: r.userId, osUsername: r.osUsername.trim() });
      }
      const hostname = enrolHostname.trim();
      minted = await mintEnrolmentToken({
        supervisedUsers,
        ttlSeconds: 3600,
        ...(hostname === "" ? {} : { hostname }),
      });
      mintedUsernames = supervisedUsers.map((u) => u.osUsername);
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
    enrolRows = [{ userId: null, osUsername: "" }];
  }

  /**
   * The install one-liner shown to the admin, per `docs/client-install.md` →
   * "Usage" (non-interactive form). The dashboard's own origin is the server
   * URL the client enrols against, so `--server-url` is filled from it — the
   * piped (`bash -s --`) form is non-interactive and the script can't prompt
   * for it over the consumed stdin.
   */
  let installCommand = $derived.by(() => {
    if (minted === null) {
      return "";
    }
    const origin = browser ? window.location.origin : "https://<server>";
    const userFlags = mintedUsernames.map((u) => `    --supervised-user ${u}`).join(" \\\n");
    return (
      `curl -fsSL ${origin}/install-client.sh \\\n` +
      `  | sudo bash -s -- \\\n` +
      `    --server-url ${origin} \\\n` +
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

  /** Badge label + pill class + hover detail for a client's version-drift verdict (#352). */
  function versionStatusMeta(status: ClientHealthResponse["versionStatus"] | undefined): {
    label: string;
    cls: string;
    title: string;
  } {
    switch (status) {
      case "up_to_date":
        return { label: "up to date", cls: "ok", title: "Reported agent version matches or is newer than the server." };
      case "outdated":
        return {
          label: "update available",
          cls: "warn",
          title: "This client's reported agent version is behind the server. It still works; re-run the installer to update it.",
        };
      case "update_required":
        return {
          label: "update required",
          cls: "bad",
          title: "The event-stream handshake refused this client for running an out-of-window protocol (ADR 0007). It must be updated before it can reconnect.",
        };
      default:
        return {
          label: "version unknown",
          cls: "unknown",
          title: "No version to compare — the client hasn't reported one, the server build stamped none, or the version string couldn't be parsed.",
        };
    }
  }

  function reachabilityClass(reachability: ClientHealthResponse["reachability"]): string {
    if (reachability === "online") {
      return "ok";
    }
    return reachability === "offline" ? "warn" : "unknown";
  }

  /**
   * A one-line remediation hint for a classified SSH failure cause (#353) — the
   * four+ root causes "host unreachable" used to collapse each want a different
   * fix. `null` for `unknown` (nothing actionable to suggest beyond the detail).
   */
  const REACHABILITY_HINTS: Record<
    NonNullable<ClientHealthResponse["reachabilityReason"]>,
    string | null
  > = {
    dns: "The dashboard can't resolve this hostname — fix container DNS or enrol the client by IP.",
    connection_refused:
      "No SSH server is answering — re-run the installer on the client (`--skip-enrol`).",
    timeout: "The host didn't answer — a firewall is blocking SSH, or the address is stale.",
    auth: "The dashboard's SSH key isn't authorized on the client — re-enrol it.",
    handshake: "The SSH handshake failed — an SSH version or configuration mismatch on the client.",
    unknown: null,
  };

  /** The remediation hint to show for an offline client, or null when none applies. */
  function reachabilityHint(health: ClientHealthResponse | null): string | null {
    if (health === null || health.reachability !== "offline" || health.reachabilityReason === null) {
      return null;
    }
    return REACHABILITY_HINTS[health.reachabilityReason];
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
    <h1>Clients</h1>
    <p class="hint">
      Supervised Linux desktops the dashboard pushes policy to — their health,
      what's queued while they're offline, and how to enrol new ones.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if healthError !== null}
    <p class="notice" role="status">
      Health data unavailable — showing inventory only. Reachability and
      component status will read "unknown" until it's reachable again.
    </p>
  {/if}

  <div class="toolbar">
    <button class="ghost" onclick={() => load()} disabled={loading}>
      {loading ? "Refreshing…" : "Refresh"}
    </button>
  </div>

  {#if loading}
    <p class="muted">Loading clients…</p>
  {:else if merged.length === 0}
    <p class="muted">No clients yet. Enrol one below.</p>
  {:else}
    <div class="grid">
      {#each merged as entry (entry.client.id)}
        {@const client = entry.client}
        {@const h = entry.health}
        {@const vsm = versionStatusMeta(h?.versionStatus)}
        {@const reachHint = reachabilityHint(h)}
        <article class="card">
          <div class="card-top">
            <div>
              {#if editingId === client.id}
                <input
                  class="edit-host"
                  bind:value={editHostname}
                  aria-label="Edit hostname"
                />
              {:else}
                <div class="hostname">
                  {client.hostname}
                  {#if !client.enrolled}
                    <span class="badge manual" title="Created manually — has not been through the enrolment exchange, so it has no event-stream credential or supervised-user links yet.">
                      manual · not enrolled
                    </span>
                  {/if}
                </div>
              {/if}
              <div class="muted small">
                {client.enrolled ? "enrolled" : "added"}
                {formatDateTime(client.enrolledAt)}
              </div>
            </div>
            <div class="status-pills">
              <span
                class="pill {reachabilityClass(h?.reachability ?? 'unknown')}"
                title={h?.reachabilityReason ? `SSH failure: ${h.reachabilityReason}` : undefined}
              >
                {h?.reachability ?? "unknown"}
              </span>
              <span class="pill {vsm.cls}" title={vsm.title}>{vsm.label}</span>
            </div>
          </div>

          {#if reachHint !== null}
            <p class="reach-hint" role="status">{reachHint}</p>
          {/if}

          <dl class="kv">
            <div>
              <dt>SSH user</dt>
              <dd>
                {#if editingId === client.id}
                  <input bind:value={editSshUser} aria-label="Edit SSH user" />
                {:else}
                  {client.sshUser}
                {/if}
              </dd>
            </div>
            <div><dt>Last seen</dt><dd>{formatDateTime(client.lastSeen)}</dd></div>
            <div>
              <dt>Agent version</dt>
              <dd>
                {#if h?.agentVersion}
                  {h.agentVersion}
                {:else}
                  <span class="muted">not reported</span>
                {/if}
                {#if h?.serverVersion}
                  <span class="muted small">· server {h.serverVersion}</span>
                {/if}
              </dd>
            </div>
            <div>
              <dt>Version reported</dt>
              <dd>
                {#if h?.versionsReportedAt}
                  {formatDateTime(h.versionsReportedAt)}
                {:else}
                  <span class="muted">—</span>
                {/if}
              </dd>
            </div>
            <div>
              <dt>Last probe</dt>
              <dd>
                {#if h === null || h.probedAt === null}
                  <span class="muted">not yet probed</span>
                {:else}
                  {formatDateTime(h.probedAt)}
                {/if}
              </dd>
            </div>
          </dl>

          <div class="components">
            <div class="section-title">Components</div>
            {#if h === null || h.components.length === 0}
              <p class="muted small">Awaiting first health probe.</p>
            {:else}
              {#each h.components as comp (comp.component)}
                <div class="comp">
                  <span class="dot {componentClass(comp.status)}" aria-hidden="true"></span>
                  <span class="comp-name">{COMPONENT_LABELS[comp.component] ?? comp.component}</span>
                  <span class="muted small">{comp.detail}</span>
                </div>
              {/each}
            {/if}
          </div>

          <div class="queue">
            <div class="queue-head">
              <span class="section-title">Queued changes</span>
              <span class="counts">
                <span class="pill {(h?.queue.pending ?? 0) > 0 ? 'warn' : 'ok'}">
                  {h?.queue.pending ?? 0} pending
                </span>
                {#if (h?.queue.failed ?? 0) > 0}
                  <span class="pill bad">{h?.queue.failed} failed</span>
                {/if}
              </span>
            </div>
            {#if h !== null && h.queue.actions.length > 0}
              <button class="link" onclick={() => toggleQueue(client.id)}>
                {expanded[client.id] ? "Hide" : "Show"} queued actions
                ({h.queue.actions.length})
              </button>
              {#if expanded[client.id]}
                <ul class="action-list">
                  {#each h.queue.actions as action (action.id)}
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

          <div class="card-actions">
            {#if editingId === client.id}
              <button
                onclick={() => saveEdit(client.id)}
                disabled={saving || editHostname.trim() === "" || editSshUser.trim() === ""}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button class="ghost" onclick={cancelEdit} disabled={saving}>Cancel</button>
            {:else}
              <button class="ghost" onclick={() => startEdit(client)}>Edit</button>
              <button class="danger" onclick={() => handleDelete(client)}>Delete</button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}

  <section class="enrol">
    <header class="head">
      <h2>Enrol a client</h2>
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
              placeholder="OS username (e.g. chloe)"
              bind:value={row.osUsername}
              aria-label="OS username"
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
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .edit-host {
    width: 100%;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: none;
  }
  .badge.manual {
    background: #fef3c7;
    color: #92400e;
  }
  .kv {
    margin: 0;
    display: grid;
    gap: 0.2rem;
  }
  .kv div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.85rem;
    border-bottom: 1px dashed #f3f4f6;
    padding: 0.2rem 0;
  }
  .kv dt {
    color: #6b7280;
  }
  .kv dd {
    margin: 0;
    text-align: right;
  }
  .kv dd input {
    width: 100%;
    max-width: 12rem;
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
  .action-list {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }
  .action-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
  }
  .card-actions {
    display: flex;
    gap: 0.4rem;
    border-top: 1px solid #f3f4f6;
    padding-top: 0.5rem;
  }
  .status-pills {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.3rem;
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
  button.danger {
    background: #dc2626;
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
  .notice {
    margin: 0 0 1rem;
    padding: 0.5rem 0.6rem;
    border-radius: 0.4rem;
    background: #fffbeb;
    color: #92400e;
    font-size: 0.85rem;
  }
  .reach-hint {
    margin: 0;
    padding: 0.4rem 0.55rem;
    border-radius: 0.4rem;
    background: #fffbeb;
    color: #92400e;
    font-size: 0.8rem;
    line-height: 1.35;
  }
</style>
