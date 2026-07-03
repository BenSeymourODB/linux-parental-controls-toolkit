<!--
  Save-and-push preview (#281, follow-up to #64's preview backend).

  Renders the visible save-and-push bar mocked in `design/admin/policy-editor.html`
  against the side-effect-free `POST /api/users/:userId/policy-preview` contract.
  The admin picks a user; the view loads that user's persisted overall budgets +
  schedules into an editable **what-if** sandbox (it never persists, never
  pushes) and live-previews what a push would change:

  - overall daily / weekly / monthly budget durations (the diff's scalar limits),
  - an include toggle per overall budget ("preview removing this limit"),
  - an include toggle per schedule ("preview removing this rule") — the path that
    moves the recurring allowed-hours grid.

  Authoring budgets/schedules themselves stays in the Budgets/Schedules editors
  (#189) and #63/#140; the what-if sandbox is preview-only. A "Push saved policy
  now" action (#304) re-pushes the user's *saved* policy — NOT the sandbox edits —
  and reports a per-client result; persisting the sandbox edits and hosting the
  bar inline in a combined editor are #343. The diff covers the SSH + `timekpra`
  session limits the resolver models on `main`; the Ansible-side filter diff
  (e2guardian / iptables) is Phase 6.

  License boundary: none — JSON API only; DTO types are erased `import type`s.
-->
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type {
    BudgetResponse,
    BudgetWindow,
    ClientPushResultDto,
    PolicyPreviewResponse,
    PushPolicyResponse,
    ScheduleAction,
    ScheduleResponse,
    UserResponse,
  } from "$lib/api/contract.js";
  import { listUsers } from "$lib/api/users.js";
  import { listBudgets } from "$lib/api/budgets.js";
  import { listSchedules } from "$lib/api/schedules.js";
  import { previewPolicyPush, pushPolicyNow } from "$lib/api/policy-preview.js";

  // ISO weekday order, bit 0 = Monday … bit 6 = Sunday (ADR 0005 §1).
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

  const WINDOW_LABEL: Readonly<Record<BudgetWindow, string>> = {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
  };

  const ACTION_LABEL: Readonly<Record<ScheduleAction, string>> = {
    allow: "allow",
    deny: "deny",
    extend: "extend",
  };

  let users = $state<UserResponse[]>([]);
  let selectedUserId = $state<number | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // The persisted baseline for the selected user (the proposed payload is
  // derived from it + the admin's what-if edits).
  let budgets = $state<BudgetResponse[]>([]);
  let schedules = $state<ScheduleResponse[]>([]);
  let loadingPolicy = $state(false);

  // What-if edits. `minutesById` holds the editable overall-budget durations;
  // the excluded sets drive the "preview removing this" toggles.
  let minutesById = $state<Record<number, string>>({});
  let excludedBudgetIds = $state<Set<number>>(new Set());
  let excludedScheduleIds = $state<Set<number>>(new Set());

  // Preview result + its own in-flight / error state (kept apart from the
  // policy load so a slow preview never blanks the editor).
  let preview = $state<PolicyPreviewResponse | null>(null);
  let previewing = $state(false);
  let previewError = $state<string | null>(null);

  // Guard against out-of-order preview responses (each edit supersedes the
  // last); only the newest request's result is applied.
  let previewSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // "Push saved policy now" (#304): the on-demand re-push of the *saved* policy
  // (not the what-if edits) + its per-client result. Kept apart from the preview
  // state so a push outcome never blanks the diff.
  let pushing = $state(false);
  let pushResult = $state<PushPolicyResponse | null>(null);
  let pushError = $state<string | null>(null);

  const PUSH_STATUS_LABEL: Readonly<Record<ClientPushResultDto["status"], string>> = {
    pushed: "pushed",
    queued: "queued (offline)",
    failed: "failed",
  };

  const overallBudgets = $derived(budgets.filter((b) => b.scope === "overall"));
  const activityBudgets = $derived(budgets.filter((b) => b.scope !== "overall"));
  const selectedUserName = $derived(
    users.find((u) => u.id === selectedUserId)?.displayName ?? null,
  );

  onMount(loadUsers);
  onDestroy(() => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
  });

  async function loadUsers(): Promise<void> {
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

  async function onSelectUser(): Promise<void> {
    if (selectedUserId === null) return;
    loadingPolicy = true;
    error = null;
    preview = null;
    previewError = null;
    pushResult = null;
    pushError = null;
    try {
      const [loadedBudgets, loadedSchedules] = await Promise.all([
        listBudgets(selectedUserId),
        listSchedules(selectedUserId),
      ]);
      budgets = loadedBudgets;
      schedules = loadedSchedules;
      // Seed the what-if state from the baseline: every rule included, every
      // overall duration at its persisted value. Budgets are authored in whole
      // minutes (BudgetsView), so `secondsAllowed / 60` is lossless; the round
      // only guards a hand-seeded sub-minute value, which would seed a rounded
      // box rather than crash.
      minutesById = Object.fromEntries(
        loadedBudgets
          .filter((b) => b.scope === "overall")
          .map((b) => [b.id, String(Math.round(b.secondsAllowed / 60))]),
      );
      excludedBudgetIds = new Set();
      excludedScheduleIds = new Set();
      schedulePreview();
    } catch (err) {
      error = messageOf(err);
    } finally {
      loadingPolicy = false;
    }
  }

  /**
   * Parse a minutes field to whole seconds, or `null` if it is not a plain
   * non-negative integer count. An empty/blank field is `null` (not `0`) so a
   * half-typed or cleared box falls back to the budget's persisted value rather
   * than previewing a real "0 minutes" limit; the digits-only guard also keeps
   * `"1e3"` / `"0x10"` from sneaking through `Number`.
   */
  function minutesToSeconds(value: string | undefined): number | null {
    if (value === undefined) return null;
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    return Number(trimmed) * 60;
  }

  /** Build the proposed policy from the baseline + the current what-if edits. */
  function proposedBudgets(): BudgetResponse[] {
    return budgets
      .filter((b) => !excludedBudgetIds.has(b.id))
      .map((b) => {
        if (b.scope !== "overall") return b;
        const edited = minutesToSeconds(minutesById[b.id]);
        return edited === null ? b : { ...b, secondsAllowed: edited };
      });
  }

  function proposedSchedules(): ScheduleResponse[] {
    return schedules.filter((s) => !excludedScheduleIds.has(s.id));
  }

  /** Debounce a preview so a burst of edits collapses into one request. */
  function schedulePreview(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runPreview();
    }, 200);
  }

  async function runPreview(): Promise<void> {
    if (selectedUserId === null) return;
    const seq = ++previewSeq;
    previewing = true;
    previewError = null;
    try {
      const result = await previewPolicyPush(selectedUserId, {
        budgets: proposedBudgets(),
        schedules: proposedSchedules(),
      });
      if (seq === previewSeq) preview = result;
    } catch (err) {
      if (seq === previewSeq) {
        previewError = messageOf(err);
        preview = null;
      }
    } finally {
      if (seq === previewSeq) previewing = false;
    }
  }

  /**
   * Push the user's **saved** policy now (#304). This is *not* a save of the
   * what-if edits above — it re-pushes the persisted policy to every linked
   * client and reports what happened on each. Idempotent (absolute limits), so
   * an unreachable client is durably queued for replay rather than dropped.
   */
  async function runPush(): Promise<void> {
    if (selectedUserId === null || pushing) return;
    pushing = true;
    pushError = null;
    pushResult = null;
    try {
      pushResult = await pushPolicyNow(selectedUserId);
    } catch (err) {
      pushError = messageOf(err);
    } finally {
      pushing = false;
    }
  }

  function onMinutesChange(id: number, value: string): void {
    minutesById = { ...minutesById, [id]: value };
    schedulePreview();
  }

  function toggleBudget(id: number): void {
    const next = new Set(excludedBudgetIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    excludedBudgetIds = next;
    schedulePreview();
  }

  function toggleSchedule(id: number): void {
    const next = new Set(excludedScheduleIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    excludedScheduleIds = next;
    schedulePreview();
  }

  // ----- display helpers -----

  function windowLabel(window: BudgetWindow): string {
    return WINDOW_LABEL[window];
  }

  /** Decode the 7-bit ISO-weekday mask (bit 0 = Monday) to a short label. */
  function daysLabel(mask: number): string {
    const days = WEEKDAYS.filter((_, i) => (mask & (1 << i)) !== 0);
    return days.length === 7 ? "Every day" : days.length === 0 ? "—" : days.join(", ");
  }

  /** Minutes-from-midnight → `HH:MM`. */
  function clockLabel(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  /** A one-line read-only summary of a schedule rule (authored in #140/#63). */
  function scheduleSummary(s: ScheduleResponse): string {
    const parts: string[] = [];
    if (s.recurrenceDays !== null) parts.push(daysLabel(s.recurrenceDays));
    if (s.recurrenceStartMinute !== null && s.recurrenceEndMinute !== null) {
      parts.push(`${clockLabel(s.recurrenceStartMinute)}–${clockLabel(s.recurrenceEndMinute)}`);
    }
    if (parts.length === 0) parts.push("Always");
    return parts.join(" ");
  }

  /** Render a client's last-seen instant, or "never" when it has never reported. */
  function lastSeenLabel(iso: string | null): string {
    return iso === null ? "never seen" : `last seen ${new Date(iso).toLocaleString()}`;
  }

  /** Render any thrown value as a UI-safe message. */
  function messageOf(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : "Something went wrong";
  }
</script>

<section>
  <header class="head">
    <h1>Save &amp; push preview</h1>
    <p class="hint">
      Pick a user and see exactly what a policy push would change on their
      clients — before you save. Adjust the overall limits or toggle a rule off
      to preview the effect. This is a read-only what-if: nothing here is saved
      or pushed.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if !loading && users.length === 0}
    <p class="muted">Add a user first — a preview is always for one user's policy.</p>
  {:else}
    <div class="picker">
      <label for="preview-user">User</label>
      <select
        id="preview-user"
        bind:value={selectedUserId}
        onchange={onSelectUser}
        disabled={loadingPolicy}
      >
        <option value={null} disabled selected>Choose a user…</option>
        {#each users as user (user.id)}
          <option value={user.id}>{user.displayName}</option>
        {/each}
      </select>
    </div>

    {#if selectedUserId !== null}
      {#if loadingPolicy}
        <p class="muted">Loading policy…</p>
      {:else}
        <div class="editor">
          <div class="card">
            <h2>Overall time budgets</h2>
            {#if overallBudgets.length === 0}
              <p class="muted">No overall budgets — the push sends no session limit.</p>
            {:else}
              <ul class="rules">
                {#each overallBudgets as budget (budget.id)}
                  {@const excluded = excludedBudgetIds.has(budget.id)}
                  <li class="rule" class:excluded>
                    <label class="incl">
                      <input
                        type="checkbox"
                        checked={!excluded}
                        onchange={() => toggleBudget(budget.id)}
                        aria-label={`Include ${windowLabel(budget.window)} overall budget`}
                      />
                      <span class="win">{windowLabel(budget.window)}</span>
                    </label>
                    <span class="mins">
                      <!--
                        Text (not `type="number"`) so the value stays a string:
                        the house pattern (BudgetsView) — a number input coerces
                        to a number and breaks the string contract
                        `minutesToSeconds` parses. `inputmode="numeric"` still
                        gives a numeric keypad.
                      -->
                      <input
                        type="text"
                        inputmode="numeric"
                        value={minutesById[budget.id] ?? ""}
                        oninput={(e) => onMinutesChange(budget.id, e.currentTarget.value)}
                        disabled={excluded}
                        aria-label={`${windowLabel(budget.window)} overall minutes`}
                      />
                      <span class="unit">min</span>
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if activityBudgets.length > 0}
              <p class="note">
                {activityBudgets.length} per-activity / group budget{activityBudgets.length === 1
                  ? ""
                  : "s"} not shown — they aren't pushed over timekpra yet (Phase 8).
              </p>
            {/if}
          </div>

          <div class="card">
            <h2>Schedule rules</h2>
            {#if schedules.length === 0}
              <p class="muted">No schedule rules — access is unrestricted by time.</p>
            {:else}
              <ul class="rules">
                {#each schedules as schedule (schedule.id)}
                  {@const excluded = excludedScheduleIds.has(schedule.id)}
                  <li class="rule" class:excluded>
                    <label class="incl">
                      <input
                        type="checkbox"
                        checked={!excluded}
                        onchange={() => toggleSchedule(schedule.id)}
                        aria-label={`Include ${ACTION_LABEL[schedule.action]} schedule rule: ${scheduleSummary(schedule)}`}
                      />
                      <span class="act act-{schedule.action}">{ACTION_LABEL[schedule.action]}</span>
                    </label>
                    <span class="sched-sum">{scheduleSummary(schedule)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>

        <!-- The save-and-push bar (design/admin/policy-editor.html). -->
        <div class="pushbar" aria-label="Save and push preview" aria-busy={previewing}>
          {#if previewError}
            <p class="push-error" role="alert">{previewError}</p>
          {:else if preview === null}
            <p class="push-muted">{previewing ? "Computing preview…" : "Select a user to preview."}</p>
          {:else}
            <div class="push-changes">
              {#if !preview.hasChanges}
                <p class="no-changes" data-testid="no-changes">
                  No pending changes — the next push would be a no-op.
                </p>
              {:else}
                <h3>
                  {preview.changes.length} change{preview.changes.length === 1 ? "" : "s"}{selectedUserName
                    ? ` for ${selectedUserName}`
                    : ""}
                </h3>
                <ul class="changes">
                  {#each preview.changes as change (`${change.field}-${change.weekday}`)}
                    <li class="change">
                      <span class="kind kind-{change.kind}">{change.kind}</span>
                      <span class="summary">{change.summary}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>

            <div class="push-clients">
              <h3>
                {preview.affectedClients.length} client{preview.affectedClients.length === 1
                  ? ""
                  : "s"} affected
              </h3>
              {#if preview.affectedClients.length === 0}
                <p class="push-muted">No clients linked — nothing to push to yet.</p>
              {:else}
                <ul class="clients">
                  {#each preview.affectedClients as client (client.clientId)}
                    <li class="client">
                      <span class="host">{client.hostname}</span>
                      <span class="meta">{lastSeenLabel(client.lastSeen)}</span>
                      <span class="queue"
                        >{client.pendingQueueDepth} queued action{client.pendingQueueDepth === 1
                          ? ""
                          : "s"}</span
                      >
                    </li>
                  {/each}
                </ul>
              {/if}
              <p class="note">
                Session limits push via SSH + timekpra. Filter / group changes push
                via Ansible (Phase 6) and aren't previewed here.
              </p>
            </div>

            <!-- Push saved policy now (#304): re-pushes the SAVED policy, not the
                 what-if edits above. Inline placement in a combined editor + a
                 persist-then-push flow are #343. -->
            <div class="push-actions">
              <button
                type="button"
                class="push-btn"
                onclick={runPush}
                disabled={pushing || preview.affectedClients.length === 0}
              >
                {pushing ? "Pushing…" : "Push saved policy now"}
              </button>
              <p class="push-hint">
                Re-pushes {selectedUserName ?? "this user"}'s <strong>saved</strong> policy to their
                clients. The what-if edits above aren't saved — edit and save in the Budgets /
                Schedules editors first.
              </p>

              {#if pushError}
                <p class="push-error" role="alert">{pushError}</p>
              {:else if pushResult !== null}
                {#if pushResult.results.length === 0}
                  <p class="push-muted" data-testid="push-empty">No clients were pushed to.</p>
                {:else}
                  <ul class="push-results" data-testid="push-results">
                    {#each pushResult.results as result (result.clientId)}
                      <li class="push-result">
                        <span class="pstatus pstatus-{result.status}"
                          >{PUSH_STATUS_LABEL[result.status]}</span
                        >
                        <span class="host">{result.hostname}</span>
                        {#if result.error}<span class="perr">{result.error}</span>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              {/if}
            </div>
          {/if}
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
    margin: 0 0 0.6rem;
    font-size: 1rem;
    color: #374151;
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
    color: #374151;
  }
  .hint {
    margin: 0.25rem 0 1rem;
    color: #6b7280;
    font-size: 0.9rem;
    max-width: 44rem;
  }
  .picker {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }
  .picker label {
    font-weight: 600;
    color: #374151;
    font-size: 0.9rem;
  }
  .picker select {
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    background: #fff;
  }
  .editor {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }
  @media (max-width: 60rem) {
    .editor {
      grid-template-columns: 1fr;
    }
  }
  .card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.9rem 1rem;
  }
  .rules {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .rule {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.45rem 0.55rem;
    border: 1px solid #f3f4f6;
    border-radius: 0.4rem;
  }
  .rule.excluded {
    opacity: 0.5;
  }
  .incl {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }
  .win {
    font-weight: 600;
    color: #374151;
  }
  .mins {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .mins input {
    width: 5rem;
    padding: 0.35rem 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.3rem;
  }
  .unit {
    color: #6b7280;
    font-size: 0.85rem;
  }
  .act {
    text-transform: uppercase;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0.15rem 0.4rem;
    border-radius: 0.3rem;
    color: #fff;
  }
  .act-allow {
    background: #16a34a;
  }
  .act-deny {
    background: #dc2626;
  }
  .act-extend {
    background: #2563eb;
  }
  .sched-sum {
    font-size: 0.85rem;
    color: #374151;
  }
  .pushbar {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
    background: #15182a;
    color: #dfe2f2;
    border-radius: 0.75rem;
    padding: 1rem 1.25rem;
  }
  @media (max-width: 60rem) {
    .pushbar {
      grid-template-columns: 1fr;
    }
  }
  .pushbar h3 {
    color: #cdd2e6;
  }
  .changes,
  .clients {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .change {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .kind {
    text-transform: uppercase;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.35rem;
    border-radius: 0.3rem;
    flex: 0 0 auto;
  }
  .kind-added {
    background: #14532d;
    color: #bbf7d0;
  }
  .kind-removed {
    background: #7f1d1d;
    color: #fecaca;
  }
  .kind-changed {
    background: #1e3a8a;
    color: #bfdbfe;
  }
  .summary {
    color: #dfe2f2;
  }
  .no-changes {
    margin: 0;
    color: #9aa3c0;
    font-size: 0.9rem;
  }
  .client {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.6rem;
    font-size: 0.85rem;
    align-items: baseline;
  }
  .host {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 600;
  }
  .client .meta,
  .client .queue {
    color: #9aa3c0;
    font-size: 0.8rem;
  }
  .note {
    margin: 0.6rem 0 0;
    color: #9aa3c0;
    font-size: 0.78rem;
  }
  .card .note {
    color: #6b7280;
  }
  .push-muted {
    margin: 0;
    color: #9aa3c0;
    font-size: 0.9rem;
  }
  .push-error {
    margin: 0;
    color: #fecaca;
    font-size: 0.9rem;
    grid-column: 1 / -1;
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
  .push-actions {
    grid-column: 1 / -1;
    border-top: 1px solid #2a2f48;
    padding-top: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .push-btn {
    align-self: flex-start;
    padding: 0.5rem 0.9rem;
    border: 0;
    border-radius: 0.4rem;
    background: #2563eb;
    color: #fff;
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .push-btn:hover:not(:disabled) {
    background: #1d4ed8;
  }
  .push-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .push-hint {
    margin: 0;
    color: #9aa3c0;
    font-size: 0.78rem;
    max-width: 44rem;
  }
  .push-hint strong {
    color: #cdd2e6;
  }
  .push-results {
    list-style: none;
    margin: 0.2rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .push-result {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .pstatus {
    text-transform: uppercase;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.35rem;
    border-radius: 0.3rem;
    flex: 0 0 auto;
  }
  .pstatus-pushed {
    background: #14532d;
    color: #bbf7d0;
  }
  .pstatus-queued {
    background: #78350f;
    color: #fde68a;
  }
  .pstatus-failed {
    background: #7f1d1d;
    color: #fecaca;
  }
  .perr {
    color: #9aa3c0;
    font-size: 0.8rem;
  }
</style>
