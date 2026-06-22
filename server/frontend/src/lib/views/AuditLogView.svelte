<!--
  Transport audit log view (#183): the read-only admin surface over the
  append-only record of every command the dashboard issued to a client (#85).

  Reads `GET /api/audit` through the typed `$lib/api/audit` wrapper — newest
  first, with `clientId`/`outcome` filters and cursor-based "load older"
  pagination (`before = nextCursor`). There is no write path: entries are
  produced by the `transport/audit` recorder, never by the UI. Like the other
  editors this is browser-only (the page is prerendered to a static shell) and
  surfaces errors inline rather than throwing them away.

  Tamper-resistance ceiling unchanged — this is a read-only operational view.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type { AuditEntryResponse, AuditOutcome } from "$lib/api/contract.js";
  import { listAudit } from "$lib/api/audit.js";

  // The outcomes the API can report (mirrors `auditOutcomeValues`). Declared
  // locally so the bundle never imports server runtime values; `satisfies`
  // keeps every entry a valid `AuditOutcome` so a renamed enum member fails the
  // build here rather than silently shipping a dead filter option.
  const OUTCOME_OPTIONS = [
    { value: "ok", label: "OK" },
    { value: "failed", label: "Failed" },
    { value: "unreachable", label: "Unreachable" },
    { value: "timeout", label: "Timeout" },
    { value: "parse_error", label: "Parse error" },
  ] as const satisfies ReadonlyArray<{ value: AuditOutcome; label: string }>;

  let entries = $state<AuditEntryResponse[]>([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let nextCursor = $state<number | null>(null);

  // Filter inputs. `clientIdInput` is text so an empty field means "all
  // clients"; it is parsed to a positive integer before it reaches the query.
  let clientIdInput = $state("");
  let outcomeFilter = $state<AuditOutcome | "">("");

  let hasMore = $derived(nextCursor !== null);

  onMount(load);

  /** Parse the client-id filter, or `undefined` when blank/invalid. */
  function clientIdFilter(): number | undefined {
    const trimmed = clientIdInput.trim();
    if (trimmed === "") {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  /** Build the current filter params (no cursor — that is added per page). */
  function filterParams(): { clientId?: number; outcome?: AuditOutcome } {
    const clientId = clientIdFilter();
    return {
      ...(clientId !== undefined ? { clientId } : {}),
      ...(outcomeFilter !== "" ? { outcome: outcomeFilter } : {}),
    };
  }

  /** Fetch the first (newest) page for the current filters, replacing the list. */
  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const page = await listAudit(filterParams());
      entries = page.entries;
      nextCursor = page.nextCursor;
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  /** Append the next, older page using the current cursor. */
  async function loadMore(): Promise<void> {
    if (nextCursor === null) {
      return;
    }
    loadingMore = true;
    error = null;
    try {
      const page = await listAudit({ ...filterParams(), before: nextCursor });
      entries = [...entries, ...page.entries];
      nextCursor = page.nextCursor;
    } catch (err) {
      error = messageOf(err);
    } finally {
      loadingMore = false;
    }
  }

  /** Apply the filter form: reset to the newest page under the new filters. */
  function applyFilters(event: SubmitEvent): void {
    event.preventDefault();
    void load();
  }

  /** Render any thrown value as a UI-safe message. */
  function messageOf(err: unknown): string {
    if (err instanceof ApiError) {
      return err.message;
    }
    return err instanceof Error ? err.message : "Something went wrong";
  }

  /** Format an ISO-8601 UTC timestamp as a short local date-time, or a dash. */
  function formatAt(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  /** Join a redacted argv vector into a single readable command line. */
  function formatCommand(command: readonly string[]): string {
    return command.join(" ");
  }

  /** The detail cell: the failure reason/error if present, else the audit reason. */
  function detailOf(entry: AuditEntryResponse): string {
    return entry.errorMessage ?? entry.reason ?? "—";
  }
</script>

<section>
  <header class="head">
    <h1>Audit log</h1>
    <p class="hint">
      Every command the dashboard has issued to a client, newest first. Read-only.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <form class="filters" onsubmit={applyFilters}>
    <input
      type="number"
      min="1"
      placeholder="Client id (all)"
      bind:value={clientIdInput}
      aria-label="Filter by client id"
    />
    <select bind:value={outcomeFilter} aria-label="Filter by outcome">
      <option value="">All outcomes</option>
      {#each OUTCOME_OPTIONS as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
    <button type="submit" disabled={loading}>{loading ? "Loading…" : "Apply"}</button>
  </form>

  {#if loading}
    <p class="muted">Loading audit log…</p>
  {:else if entries.length === 0}
    <p class="muted">No audit entries match these filters.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Actor</th>
          <th>Target</th>
          <th>Command</th>
          <th>Outcome</th>
          <th class="num">Exit</th>
          <th class="num">Duration</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {#each entries as entry (entry.id)}
          <tr>
            <td class="muted nowrap">{formatAt(entry.at)}</td>
            <td>{entry.actor}</td>
            <td class="muted">
              {entry.targetUser}@{entry.targetHost}:{entry.targetPort}
            </td>
            <td><code>{formatCommand(entry.command)}</code></td>
            <td>
              <span class="chip {entry.outcome}">{entry.outcome}</span>
            </td>
            <td class="num muted">
              {entry.exitCode ?? entry.signal ?? "—"}
            </td>
            <td class="num muted nowrap">{entry.durationMs} ms</td>
            <td class="muted detail">{detailOf(entry)}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    {#if hasMore}
      <div class="more">
        <button class="ghost" onclick={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load older"}
        </button>
      </div>
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
  }
  .filters {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
  }
  .filters input,
  .filters select {
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
  }
  .filters input {
    flex: 0 1 12rem;
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
  th.num,
  td.num {
    text-align: right;
  }
  .nowrap {
    white-space: nowrap;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    word-break: break-word;
  }
  .detail {
    max-width: 18rem;
    word-break: break-word;
  }
  .chip {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: capitalize;
    background: #e5e7eb;
    color: #374151;
  }
  .chip.ok {
    background: #dcfce7;
    color: #166534;
  }
  .chip.failed {
    background: #fee2e2;
    color: #991b1b;
  }
  .chip.unreachable,
  .chip.timeout {
    background: #fef3c7;
    color: #92400e;
  }
  .chip.parse_error {
    background: #ede9fe;
    color: #5b21b6;
  }
  .more {
    margin-top: 1rem;
    text-align: center;
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
