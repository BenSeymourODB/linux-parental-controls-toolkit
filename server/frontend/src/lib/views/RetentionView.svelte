<!--
  Data-retention windows editor (#214): the admin surface for the retention
  config whose backend landed in #136. Loads `/api/retention` on mount (browser
  only — the page is prerendered to a static shell), and lets the admin pin or
  clear a per-category override. All calls go through the typed
  `$lib/api/retention` wrappers; errors are surfaced inline.

  The global default window is environment-configured (`PCT_RETENTION_DEFAULT_DAYS`)
  and only per-category overrides are persisted, so the default is shown
  read-only with a "restart to change" note (matching #136's server model). A
  category is either inherited from that default (`source: "default"`) or pinned
  by an override — a custom day count or keep-forever.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type {
    RetentionCategory,
    RetentionEntryResponse,
    RetentionPurgePreviewResponse,
    RetentionPurgeRunResponse,
    SetRetentionOverrideRequest,
  } from "$lib/api/contract.js";
  import {
    clearRetentionOverride,
    fetchRetention,
    fetchRetentionPurgeRuns,
    previewRetentionPurge,
    runRetentionPurge,
    setRetentionOverride,
  } from "$lib/api/retention.js";

  // Human labels + a one-line description per known category. Typed against the
  // contract's `RetentionCategory` so it can never drift from the set the
  // server defines (the same drift-checked pattern `IntegrationTokensView` uses
  // for `SCOPE_OPTIONS`). A category the server adds later still renders — it
  // falls back to its raw key (see `metaFor`).
  const CATEGORY_META: Record<RetentionCategory, { label: string; description: string }> = {
    usage_samples: {
      label: "Usage samples",
      description: "ActivityWatch-derived per-activity usage rows.",
    },
    grant_ledger: {
      label: "Grant ledger",
      description: "Screen-time grants awarded by the admin or an integration.",
    },
    audit_log: {
      label: "Audit log",
      description: "Record of every command issued to a client.",
    },
    date_overrides: {
      label: "Date-specific overrides",
      description: "One-off / future-dated schedule exceptions.",
    },
  };

  function metaFor(category: string): { label: string; description: string } {
    return CATEGORY_META[category as RetentionCategory] ?? { label: category, description: "" };
  }

  // Mirrors `MAX_RETENTION_DAYS` in `server/src/policy/retention.ts` (~100 years).
  // A runtime value can't be imported here without dragging server code into the
  // frontend bundle (the contract module is deliberately type-only), so the bound
  // is duplicated as a literal; the server remains the authority and rejects an
  // out-of-range value regardless. Used for the native input `max` and a
  // pre-flight guard so a too-large window doesn't need a server round-trip to fail.
  const MAX_RETENTION_DAYS = 36_525;

  /** Per-row draft: the edit state seeded from (and re-seeded after) a save. */
  interface Draft {
    keepForever: boolean;
    /** Day count as typed; parsed + validated on save. */
    days: string;
  }

  let defaultDays = $state<number | null>(null);
  let entries = $state<RetentionEntryResponse[]>([]);
  let drafts = $state<Record<string, Draft>>({});
  let loading = $state(true);
  let error = $state<string | null>(null);

  // The category whose Save / Clear is in flight, so only that row shows
  // progress (mirrors `IntegrationTokensView`'s `revokingId`).
  let savingCategory = $state<string | null>(null);
  let clearingCategory = $state<string | null>(null);

  // Data-purge panel (#137): the last recorded run, a pending dry-run preview,
  // and the in-flight flags for the manual controls.
  let lastRun = $state<RetentionPurgeRunResponse | null>(null);
  let preview = $state<RetentionPurgePreviewResponse | null>(null);
  let purgeError = $state<string | null>(null);
  let running = $state(false);
  let previewing = $state(false);

  onMount(() => {
    void load();
    void loadLastRun();
  });

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const config = await fetchRetention();
      defaultDays = config.defaultDays;
      entries = config.categories;
      drafts = seedDrafts(config.categories, config.defaultDays);
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  /** Seed every row's edit state from its current entry. */
  function seedDrafts(
    rows: readonly RetentionEntryResponse[],
    fallbackDays: number,
  ): Record<string, Draft> {
    const next: Record<string, Draft> = {};
    for (const row of rows) {
      next[row.category] = draftFor(row, fallbackDays);
    }
    return next;
  }

  /**
   * The draft for one entry. A keep-forever row still seeds a sensible day
   * value (its own days, else the global default) so toggling back to a custom
   * window doesn't start from empty.
   */
  function draftFor(row: RetentionEntryResponse, fallbackDays: number): Draft {
    return {
      keepForever: row.keepForever,
      days: String(row.days ?? fallbackDays),
    };
  }

  function setMode(category: string, keepForever: boolean): void {
    const current = drafts[category];
    if (current === undefined) return;
    drafts = { ...drafts, [category]: { ...current, keepForever } };
  }

  function setDays(category: string, days: string): void {
    const current = drafts[category];
    if (current === undefined) return;
    drafts = { ...drafts, [category]: { ...current, days } };
  }

  async function handleSave(entry: RetentionEntryResponse): Promise<void> {
    const draft = drafts[entry.category];
    if (draft === undefined) return;

    let body: SetRetentionOverrideRequest;
    if (draft.keepForever) {
      body = { keepForever: true };
    } else {
      const days = Number.parseInt(draft.days, 10);
      if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
        error = `Enter a whole number of days between 1 and ${MAX_RETENTION_DAYS}, or choose keep forever.`;
        return;
      }
      body = { keepForever: false, days };
    }

    savingCategory = entry.category;
    error = null;
    try {
      const updated = await setRetentionOverride(entry.category, body);
      applyEntry(updated);
    } catch (err) {
      error = messageOf(err);
    } finally {
      savingCategory = null;
    }
  }

  async function handleClear(entry: RetentionEntryResponse): Promise<void> {
    clearingCategory = entry.category;
    error = null;
    try {
      const reverted = await clearRetentionOverride(entry.category);
      applyEntry(reverted);
    } catch (err) {
      error = messageOf(err);
    } finally {
      clearingCategory = null;
    }
  }

  /** Replace one entry (and re-seed its draft) from a server response. */
  function applyEntry(updated: RetentionEntryResponse): void {
    entries = entries.map((row) => (row.category === updated.category ? updated : row));
    drafts = { ...drafts, [updated.category]: draftFor(updated, defaultDays ?? 0) };
    // A window just changed, so any pending preview was computed against the old
    // cutoffs — drop it rather than show stale counts.
    preview = null;
  }

  /** The current effective window, human-readable. */
  function windowLabel(entry: RetentionEntryResponse): string {
    if (entry.keepForever) return "Kept forever";
    return `${entry.days} day${entry.days === 1 ? "" : "s"}`;
  }

  /** Load the most recent purge run for the last-run summary. */
  async function loadLastRun(): Promise<void> {
    try {
      const res = await fetchRetentionPurgeRuns(1);
      lastRun = res.runs[0] ?? null;
    } catch (err) {
      purgeError = messageOf(err);
    }
  }

  /** Dry-run: show what a purge would remove now, deleting/recording nothing. */
  async function handlePreview(): Promise<void> {
    previewing = true;
    purgeError = null;
    try {
      preview = await previewRetentionPurge();
    } catch (err) {
      purgeError = messageOf(err);
    } finally {
      previewing = false;
    }
  }

  /** Run the purge now; refresh the last-run summary and clear the stale preview. */
  async function handleRunNow(): Promise<void> {
    running = true;
    purgeError = null;
    try {
      lastRun = await runRetentionPurge();
      preview = null;
    } catch (err) {
      purgeError = messageOf(err);
    } finally {
      running = false;
    }
  }

  /** An ISO instant rendered in the viewer's locale. */
  function formatInstant(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** A per-category cutoff for a breakdown row: the date, or "kept forever". */
  function cutoffLabel(cutoff: string | null): string {
    return cutoff === null ? "kept forever" : `older than ${formatInstant(cutoff)}`;
  }

  /** Render any thrown value as a UI-safe message. */
  function messageOf(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : "Something went wrong";
  }
</script>

<section>
  <header class="head">
    <h1>Data retention</h1>
    <p class="hint">
      How long each class of dated data is kept before the automatic purge removes it. Recurrence
      rules themselves are never purged — only dated history (usage samples, grants, the audit log,
      and date-specific overrides).
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if defaultDays !== null}
    <div class="default-banner" role="note">
      <span class="default-label">Global default</span>
      <strong>{defaultDays} day{defaultDays === 1 ? "" : "s"}</strong>
      <span class="muted">
        Environment-configured (<code>PCT_RETENTION_DEFAULT_DAYS</code>); restart the server to
        change it. Categories without an override inherit this window.
      </span>
    </div>
  {/if}

  {#if loading}
    <p class="muted">Loading retention settings…</p>
  {:else if entries.length === 0}
    <p class="muted">No retention categories to configure.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Category</th>
          <th>Effective window</th>
          <th>Source</th>
          <th>Override</th>
          <th class="actions-col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each entries as entry (entry.category)}
          {@const meta = metaFor(entry.category)}
          {@const draft = drafts[entry.category]}
          {@const isOverride = entry.source === "override"}
          {@const busy = savingCategory === entry.category || clearingCategory === entry.category}
          <tr>
            <td>
              <div class="cat-name">{meta.label}</div>
              {#if meta.description}<div class="cat-desc muted">{meta.description}</div>{/if}
            </td>
            <td>{windowLabel(entry)}</td>
            <td>
              {#if isOverride}
                <span class="badge override">override</span>
              {:else}
                <span class="badge inherited">inherited default</span>
              {/if}
            </td>
            <td class="edit">
              {#if draft}
                <div class="edit-row">
                  <select
                    aria-label={`${meta.label} retention mode`}
                    value={draft.keepForever ? "forever" : "custom"}
                    onchange={(e) => setMode(entry.category, e.currentTarget.value === "forever")}
                    disabled={busy}
                  >
                    <option value="custom">Custom window</option>
                    <option value="forever">Keep forever</option>
                  </select>
                  <input
                    type="number"
                    min="1"
                    max={MAX_RETENTION_DAYS}
                    step="1"
                    aria-label={`${meta.label} retention days`}
                    value={draft.days}
                    oninput={(e) => setDays(entry.category, e.currentTarget.value)}
                    disabled={draft.keepForever || busy}
                  />
                  <span class="unit muted">days</span>
                </div>
              {/if}
            </td>
            <td class="actions">
              <button
                onclick={() => handleSave(entry)}
                disabled={busy}
                aria-label={`Save ${meta.label} retention`}
              >
                {savingCategory === entry.category ? "Saving…" : "Save override"}
              </button>
              <button
                class="ghost"
                onclick={() => handleClear(entry)}
                disabled={!isOverride || busy}
                aria-label={`Clear ${meta.label} override`}
              >
                {clearingCategory === entry.category ? "Clearing…" : "Clear override"}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <div class="purge-panel">
    <h2>Data purge</h2>
    <p class="hint">
      The purge runs automatically on a schedule and deletes records past their window. You can
      preview what it would remove, or run it now.
    </p>

    {#if purgeError}
      <p class="error" role="alert">{purgeError}</p>
    {/if}

    <div class="purge-actions">
      <button class="ghost" onclick={handlePreview} disabled={previewing || running}>
        {previewing ? "Previewing…" : "Preview"}
      </button>
      <button onclick={handleRunNow} disabled={running || previewing}>
        {running ? "Purging…" : "Run purge now"}
      </button>
    </div>

    {#if lastRun}
      <div class="purge-card" data-testid="last-run">
        <div class="purge-card-head">
          <span class="muted">Last purge</span>
          <strong>{formatInstant(lastRun.at)}</strong>
          <span class="badge {lastRun.trigger === 'manual' ? 'override' : 'inherited'}">
            {lastRun.trigger}
          </span>
          <span>{lastRun.totalDeleted} row{lastRun.totalDeleted === 1 ? "" : "s"} removed</span>
        </div>
        <ul class="purge-breakdown">
          {#each lastRun.items as item (item.category)}
            <li>
              <span>{metaFor(item.category).label}</span>
              <span class="muted cutoff">{cutoffLabel(item.cutoff)}</span>
              <span>{item.deleted}</span>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <p class="muted">No purge has run yet.</p>
    {/if}

    {#if preview}
      <div class="purge-card" data-testid="preview">
        <div class="purge-card-head">
          <span class="muted">Preview</span>
          <strong>
            {preview.totalWouldDelete} row{preview.totalWouldDelete === 1 ? "" : "s"} would be removed
          </strong>
        </div>
        <ul class="purge-breakdown">
          {#each preview.items as item (item.category)}
            <li>
              <span>{metaFor(item.category).label}</span>
              <span class="muted cutoff">{cutoffLabel(item.cutoff)}</span>
              <span>{item.wouldDelete}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</section>

<style>
  h1 {
    margin: 0;
    font-size: 1.3rem;
  }
  h2 {
    margin: 0 0 0.15rem;
    font-size: 1.05rem;
  }
  .purge-panel {
    margin-top: 1.75rem;
    padding-top: 1.25rem;
    border-top: 1px solid #e5e7eb;
  }
  .purge-actions {
    display: flex;
    gap: 0.5rem;
    margin: 0.5rem 0 1rem;
  }
  .purge-card {
    margin-top: 0.75rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid #e5e7eb;
    background: #f9fafb;
    border-radius: 0.5rem;
    font-size: 0.9rem;
  }
  .purge-card-head {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .purge-breakdown {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.15rem;
    max-width: 28rem;
  }
  .purge-breakdown li {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.75rem;
    align-items: baseline;
    font-size: 0.85rem;
    color: #4b5563;
  }
  .purge-breakdown .cutoff {
    font-size: 0.78rem;
    text-align: right;
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
  .default-banner {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    flex-wrap: wrap;
    margin-bottom: 1.25rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid #e5e7eb;
    background: #f9fafb;
    border-radius: 0.5rem;
    font-size: 0.9rem;
  }
  .default-label {
    font-weight: 600;
    color: #374151;
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
  .cat-name {
    font-weight: 600;
  }
  .cat-desc {
    font-size: 0.8rem;
    margin-top: 0.15rem;
  }
  .edit-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .edit select,
  .edit input[type="number"] {
    padding: 0.4rem 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    font-size: 0.85rem;
  }
  .edit input[type="number"] {
    width: 6rem;
  }
  .unit {
    font-size: 0.8rem;
  }
  .badge {
    font-size: 0.72rem;
    padding: 0.15rem 0.45rem;
    border-radius: 0.3rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge.override {
    background: #dbeafe;
    color: #1e40af;
  }
  .badge.inherited {
    background: #f3f4f6;
    color: #4b5563;
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
    white-space: nowrap;
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
