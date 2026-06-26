<!--
  Notifications editor (#105): the `/admin/notifications` surface for a user's
  `NotificationPolicy` (#104). Repeats the per-user editor pattern (load users
  on mount, pick one, load/edit/save its policy) used by the other views (#53).

  A `NotificationPolicy` is 1:1 with a user and shapes the supervised-user
  notification experience (`docs/client-notifications.md`): the master `enabled`
  switch, the `soundProfile` (`off` / `subtle` / `prominent`), and the
  `graceSeconds` end-of-budget countdown (0–60s, 0 disables grace). Every user
  always *has* an effective policy — the server returns the documented defaults
  until the admin customises it — so this view never shows an empty policy, and
  "Reset to defaults" (DELETE) reverts a user to that baseline.

  Per-budget `cadenceOverrides` are a deliberately loose, unpinned structure;
  this view surfaces whether a user has any and lets the admin clear them, but a
  structured cadence editor is a separate piece of work (see the PR for #105).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/client.js";
  import type {
    NotificationPolicyResponse,
    SoundProfile,
    UserResponse,
  } from "$lib/api/contract.js";
  import {
    getNotificationPolicy,
    upsertNotificationPolicy,
    deleteNotificationPolicy,
  } from "$lib/api/notifications.js";
  import { listUsers } from "$lib/api/users.js";

  // Documented bounds + vocabulary (`docs/client-notifications.md`, mirrored by
  // `server/src/policy/notification.ts`'s single-source constants). Hardcoded
  // here because the contract is type-only — no server runtime values cross the
  // bundle boundary — and kept in step with that source.
  const GRACE_SECONDS_MIN = 0;
  const GRACE_SECONDS_MAX = 60;

  const SOUND_PROFILE_OPTIONS: ReadonlyArray<{ value: SoundProfile; label: string }> = [
    { value: "off", label: "Off — no sounds" },
    { value: "subtle", label: "Subtle (default)" },
    { value: "prominent", label: "Prominent" },
  ];

  let users = $state<UserResponse[]>([]);
  let loadingUsers = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  // The user whose policy is being edited, and that policy's loaded state.
  let selectedUserId = $state<number | null>(null);
  let policy = $state<NotificationPolicyResponse | null>(null);
  let loadingPolicy = $state(false);

  // Editable form fields, hydrated from the loaded policy.
  let formEnabled = $state(true);
  let formSoundProfile = $state<SoundProfile>("subtle");
  let formGraceSeconds = $state(15);
  let saving = $state(false);
  let resetting = $state(false);
  let clearingCadence = $state(false);

  onMount(loadUsers);

  async function loadUsers(): Promise<void> {
    loadingUsers = true;
    error = null;
    try {
      users = await listUsers();
    } catch (err) {
      error = messageOf(err);
    } finally {
      loadingUsers = false;
    }
  }

  // (Re)load the selected user's effective policy and hydrate the form. The
  // server always returns a policy (persisted row or documented defaults).
  async function loadPolicy(userId: number): Promise<void> {
    loadingPolicy = true;
    error = null;
    notice = null;
    try {
      const loaded = await getNotificationPolicy(userId);
      policy = loaded;
      formEnabled = loaded.enabled;
      formSoundProfile = loaded.soundProfile;
      formGraceSeconds = loaded.graceSeconds;
    } catch (err) {
      policy = null;
      error = messageOf(err);
    } finally {
      loadingPolicy = false;
    }
  }

  function onSelectUser(): void {
    if (selectedUserId === null) {
      policy = null;
      return;
    }
    void loadPolicy(selectedUserId);
  }

  function userName(id: number): string {
    return users.find((u) => u.id === id)?.displayName ?? `User ${id}`;
  }

  // The grace input is bounded client-side to mirror the server's `CHECK` /
  // zod bound so the admin gets fast feedback instead of a 400.
  let graceInvalid = $derived(
    !Number.isInteger(formGraceSeconds) ||
      formGraceSeconds < GRACE_SECONDS_MIN ||
      formGraceSeconds > GRACE_SECONDS_MAX,
  );

  // Enable Save only when something actually differs from the loaded policy, so
  // a no-op PUT (and its push fan-out) isn't issued on an unchanged form.
  let dirty = $derived(
    policy !== null &&
      (formEnabled !== policy.enabled ||
        formSoundProfile !== policy.soundProfile ||
        formGraceSeconds !== policy.graceSeconds),
  );

  let hasCustomCadence = $derived(policy !== null && policy.cadenceOverrides !== null);

  async function handleSave(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (selectedUserId === null || graceInvalid || !dirty) {
      return;
    }
    saving = true;
    error = null;
    notice = null;
    try {
      policy = await upsertNotificationPolicy(selectedUserId, {
        enabled: formEnabled,
        soundProfile: formSoundProfile,
        graceSeconds: formGraceSeconds,
      });
      notice = `Saved notification settings for ${userName(selectedUserId)}.`;
    } catch (err) {
      error = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function handleReset(): Promise<void> {
    if (selectedUserId === null) {
      return;
    }
    if (!confirm(`Reset ${userName(selectedUserId)} to the default notification settings?`)) {
      return;
    }
    resetting = true;
    error = null;
    notice = null;
    // Capture the outcome message and apply it *after* the reload below —
    // `loadPolicy` clears `notice`, so setting it inside the try would be wiped.
    let outcome: string | null = null;
    try {
      await deleteNotificationPolicy(selectedUserId);
      outcome = `Reset ${userName(selectedUserId)} to the default notification settings.`;
    } catch (err) {
      // A 404 here means "already at defaults" — not an error worth alarming the
      // admin with; just reload and say so.
      if (err instanceof ApiError && err.status === 404) {
        outcome = `${userName(selectedUserId)} was already using the default settings.`;
      } else {
        error = messageOf(err);
      }
    } finally {
      resetting = false;
      // Reload so the form reflects the (now default) effective policy.
      await loadPolicy(selectedUserId);
    }
    // Surface the outcome only when the reload itself didn't error.
    if (outcome !== null && error === null) {
      notice = outcome;
    }
  }

  async function handleClearCadence(): Promise<void> {
    if (selectedUserId === null) {
      return;
    }
    clearingCadence = true;
    error = null;
    notice = null;
    try {
      policy = await upsertNotificationPolicy(selectedUserId, { cadenceOverrides: null });
      notice = `Cleared the custom warning cadence for ${userName(selectedUserId)}.`;
    } catch (err) {
      error = messageOf(err);
    } finally {
      clearingCadence = false;
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
    <h1>Notifications</h1>
    <p class="hint">
      Per-user notification settings for the supervised desktop: the master
      on/off switch, the sound theme, and the end-of-budget grace countdown.
      Changes are pushed to the user's linked clients with the rest of their
      policy.
    </p>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  {#if notice}
    <p class="notice" role="status">{notice}</p>
  {/if}

  {#if loadingUsers}
    <p class="muted">Loading users…</p>
  {:else if users.length === 0}
    <p class="muted">Add a user first — notification settings always belong to a user.</p>
  {:else}
    <label class="field user-picker">
      <span>User</span>
      <select bind:value={selectedUserId} onchange={onSelectUser} aria-label="User">
        <option value={null} disabled selected>Choose a user…</option>
        {#each users as user (user.id)}
          <option value={user.id}>{user.displayName}</option>
        {/each}
      </select>
    </label>

    {#if selectedUserId === null}
      <p class="muted">Choose a user to view and edit their notification settings.</p>
    {:else if loadingPolicy}
      <p class="muted">Loading settings…</p>
    {:else if policy !== null}
      <form class="editor" onsubmit={handleSave}>
        <label class="row toggle">
          <input type="checkbox" bind:checked={formEnabled} aria-label="Notifications enabled" />
          <span>
            <strong>Notifications enabled</strong>
            <small>Master switch — when off, the client shows no toasts or sounds.</small>
          </span>
        </label>

        <label class="row">
          <span class="label">Sound profile</span>
          <select bind:value={formSoundProfile} aria-label="Sound profile">
            {#each SOUND_PROFILE_OPTIONS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>

        <label class="row">
          <span class="label">Grace period (seconds)</span>
          <input
            type="number"
            min={GRACE_SECONDS_MIN}
            max={GRACE_SECONDS_MAX}
            step="1"
            bind:value={formGraceSeconds}
            aria-label="Grace period seconds"
            aria-invalid={graceInvalid}
          />
        </label>
        <p class="sublabel">
          How long the user has after a per-app budget runs out before it is
          force-closed. {GRACE_SECONDS_MIN}–{GRACE_SECONDS_MAX}s; 0 disables the grace countdown.
        </p>
        {#if graceInvalid}
          <p class="warn" role="alert">
            Grace period must be a whole number between {GRACE_SECONDS_MIN} and {GRACE_SECONDS_MAX}.
          </p>
        {/if}

        <div class="cadence">
          {#if hasCustomCadence}
            <p class="muted">
              This user has a custom per-budget warning cadence. Clear it to fall
              back to the built-in 15/5/1-minute warnings.
            </p>
            <button
              type="button"
              class="ghost"
              onclick={handleClearCadence}
              disabled={clearingCadence}
            >
              {clearingCadence ? "Clearing…" : "Clear custom cadence"}
            </button>
          {:else}
            <p class="muted">Using the built-in 15/5/1-minute warning cadence.</p>
          {/if}
        </div>

        <div class="actions">
          <button type="submit" disabled={saving || resetting || graceInvalid || !dirty}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" class="ghost" onclick={handleReset} disabled={saving || resetting}>
            {resetting ? "Resetting…" : "Reset to defaults"}
          </button>
        </div>
      </form>
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
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.75rem;
    color: #6b7280;
  }
  .user-picker {
    margin-bottom: 1.25rem;
    max-width: 20rem;
  }
  select,
  input[type="number"] {
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    background: #fff;
    font-size: 0.9rem;
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 32rem;
    padding: 1.25rem;
    background: #fff;
    border-radius: 0.5rem;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .row .label {
    font-size: 0.85rem;
    font-weight: 600;
    color: #374151;
  }
  .toggle {
    flex-direction: row;
    align-items: start;
    gap: 0.6rem;
  }
  .toggle input {
    margin-top: 0.2rem;
  }
  .toggle span {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .toggle small,
  .sublabel {
    color: #6b7280;
    font-size: 0.8rem;
  }
  .sublabel {
    margin: -0.6rem 0 0;
    max-width: 32rem;
  }
  .cadence {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid #f3f4f6;
  }
  .cadence .muted {
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    padding-top: 0.5rem;
  }
  button {
    padding: 0.5rem 0.9rem;
    border: none;
    border-radius: 0.4rem;
    background: #2563eb;
    color: #fff;
    cursor: pointer;
    font-size: 0.9rem;
    align-self: start;
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
    font-size: 0.9rem;
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
    background: #ecfdf5;
    color: #047857;
    font-size: 0.85rem;
  }
  .warn {
    margin: -0.6rem 0 0;
    color: #b45309;
    font-size: 0.8rem;
  }
</style>
