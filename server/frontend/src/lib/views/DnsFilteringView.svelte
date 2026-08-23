<!--
  DNS filtering admin surface (#97, Phase 7): the active AdGuard mode plus the
  per-client (device) domain blocklists composed from policy and pushed to
  AdGuard over its REST API. Loads `/api/dns` + `/api/dns/blocklist` on mount
  (browser only — the page is prerendered to a static shell). All calls go
  through the typed `$lib/api/dns` wrappers; the UI never talks to AdGuard
  directly.

  Domains are authored in the Activities + Schedules editors (policy is the
  single source of truth, ADR 0015); this view surfaces the resulting per-device
  blocklist, shows where DNS rules end up (the active mode), and pushes them.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type {
    DnsBlocklistApplyResponse,
    DnsBlocklistPreviewResponse,
    DnsStatusResponse,
  } from "$lib/api/contract.js";
  import { applyDnsBlocklist, fetchDnsBlocklist, fetchDnsStatus } from "$lib/api/dns.js";

  const MODE_LABEL: Record<DnsStatusResponse["mode"], string> = {
    disabled: "Disabled",
    external: "External AdGuard Home",
    managed: "Managed AdGuard Home",
  };

  const HEALTH_LABEL: Record<DnsStatusResponse["health"], string> = {
    not_applicable: "not applicable",
    unknown: "not yet checked",
    ok: "healthy",
    unreachable: "unreachable",
    auth_failed: "authentication failed",
    unhealthy: "reachable but not running",
    error: "error",
  };

  let status = $state<DnsStatusResponse | null>(null);
  let preview = $state<DnsBlocklistPreviewResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let applying = $state(false);
  let lastApply = $state<DnsBlocklistApplyResponse | null>(null);

  let disabled = $derived(status?.mode === "disabled");
  let healthTone = $derived(status?.health === "ok" ? "ok" : status?.health === "unknown" ? "warn" : "bad");

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [s, p] = await Promise.all([fetchDnsStatus(), fetchDnsBlocklist()]);
      status = s;
      preview = p;
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  async function handleApply(): Promise<void> {
    applying = true;
    error = null;
    lastApply = null;
    try {
      lastApply = await applyDnsBlocklist();
      // Re-read so the table + status reflect exactly what was pushed.
      const [s, p] = await Promise.all([fetchDnsStatus(), fetchDnsBlocklist()]);
      status = s;
      preview = p;
    } catch (err) {
      error = messageOf(err);
    } finally {
      applying = false;
    }
  }

  function applySummary(result: DnsBlocklistApplyResponse): string {
    if (!result.rulesChanged && result.clients.added + result.clients.updated + result.clients.deleted === 0) {
      return "Already up to date — nothing to change.";
    }
    const { added, updated, deleted } = result.clients;
    return (
      `Pushed ${result.ruleCount} rule${result.ruleCount === 1 ? "" : "s"} ` +
      `across ${result.clientsManaged} device${result.clientsManaged === 1 ? "" : "s"} ` +
      `(clients +${added} ~${updated} −${deleted}).`
    );
  }

  function messageOf(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : "Something went wrong";
  }
</script>

<section>
  <header class="head">
    <h1>DNS filtering</h1>
    <p class="hint">
      Per-device domain blocklists enforced at the DNS layer by AdGuard Home. Domains come from your
      <strong>deny</strong> schedules on <strong>domain</strong> activities — edit those under Activities
      and Schedules; this view shows where they land and pushes them.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading DNS status…</p>
  {:else if status !== null}
    <div class="mode-banner tone-{healthTone}" role="note">
      <div class="mode-line">
        <span class="mode-label">Active mode</span>
        <strong>{MODE_LABEL[status.mode]}</strong>
        {#if status.mode !== "disabled"}
          <span class="health">· {HEALTH_LABEL[status.health]}</span>
        {/if}
      </div>
      {#if status.baseUrl}
        <div class="muted small">Rules end up at <code>{status.baseUrl}</code></div>
      {/if}
      {#if status.mode === "external"}
        <p class="warn-note">
          External mode: the dashboard only ever writes its own <code>pct:</code>-prefixed clients and
          rules. Your household's own AdGuard clients and hand-written rules are left untouched.
        </p>
      {/if}
      {#if status.detail && status.health !== "ok"}
        <p class="muted small">{status.detail}</p>
      {/if}
    </div>

    {#if disabled}
      <p class="empty" role="note">
        DNS filtering is turned off. Set <code>PCT_ADGUARD_MODE</code> to <code>external</code> or
        <code>managed</code> and restart the server to manage per-device blocklists here. Your deny
        policy is still enforced at the web-proxy layer where configured.
      </p>
    {:else if preview !== null}
      {#if lastApply !== null}
        <p class="success" role="status">{applySummary(lastApply)}</p>
      {/if}

      <div class="actions-bar">
        <button
          onclick={handleApply}
          disabled={!preview.applyable || applying}
          aria-label="Apply DNS blocklists"
        >
          {applying ? "Applying…" : "Apply to AdGuard"}
        </button>
        {#if !preview.applyable}
          <span class="muted small">{preview.detail ?? "Not applyable right now."}</span>
        {/if}
      </div>

      {#if preview.clients.length === 0}
        <p class="muted">No devices have an always-on domain deny with a reachable address yet.</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Addresses</th>
              <th>Blocked domains</th>
            </tr>
          </thead>
          <tbody>
            {#each preview.clients as client (client.name)}
              <tr>
                <td class="device-name">{client.name}</td>
                <td class="addrs">{client.ids.join(", ")}</td>
                <td>
                  <span class="count">{client.domains.length}</span>
                  <div class="domains muted">{client.domains.join(", ")}</div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      {#if preview.skipped.length > 0}
        <div class="skipped" role="note">
          <h2>Not enforced</h2>
          <p class="muted small">
            These devices have domain denies but no reported IP address, so AdGuard cannot target
            them. They will be covered once the client re-enrols and reports an address.
          </p>
          <ul>
            {#each preview.skipped as skip (skip.clientId)}
              <li>
                <strong>{skip.label}</strong>
                <span class="muted">— {skip.domains.length} domain{skip.domains.length === 1 ? "" : "s"}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}
  {/if}
</section>

<style>
  h1 {
    margin: 0;
    font-size: 1.3rem;
  }
  h2 {
    margin: 0 0 0.25rem;
    font-size: 1rem;
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
  .mode-banner {
    margin-bottom: 1.25rem;
    padding: 0.7rem 0.9rem;
    border: 1px solid #e5e7eb;
    border-left-width: 4px;
    background: #f9fafb;
    border-radius: 0.5rem;
  }
  .mode-banner.tone-ok {
    border-left-color: #16a34a;
  }
  .mode-banner.tone-warn {
    border-left-color: #d97706;
  }
  .mode-banner.tone-bad {
    border-left-color: #dc2626;
  }
  .mode-line {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .mode-label {
    font-weight: 600;
    color: #374151;
  }
  .health {
    color: #4b5563;
    font-size: 0.9rem;
  }
  .warn-note {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
    color: #92400e;
  }
  .small {
    font-size: 0.8rem;
  }
  .empty {
    padding: 0.8rem 1rem;
    border: 1px dashed #d1d5db;
    border-radius: 0.5rem;
    color: #4b5563;
    font-size: 0.9rem;
  }
  .actions-bar {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
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
  .device-name {
    font-weight: 600;
    white-space: nowrap;
  }
  .addrs {
    font-variant-numeric: tabular-nums;
    color: #4b5563;
    white-space: nowrap;
  }
  .count {
    font-weight: 600;
  }
  .domains {
    font-size: 0.8rem;
    margin-top: 0.15rem;
    word-break: break-word;
  }
  .skipped {
    margin-top: 1.25rem;
    padding: 0.7rem 0.9rem;
    border: 1px solid #fde68a;
    background: #fffbeb;
    border-radius: 0.5rem;
  }
  .skipped ul {
    margin: 0.4rem 0 0;
    padding-left: 1.1rem;
  }
  button {
    padding: 0.45rem 0.8rem;
    border: none;
    border-radius: 0.4rem;
    background: #2563eb;
    color: #fff;
    cursor: pointer;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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
  .success {
    margin: 0 0 1rem;
    padding: 0.5rem 0.6rem;
    border-radius: 0.4rem;
    background: #f0fdf4;
    color: #15803d;
    font-size: 0.85rem;
  }
</style>
