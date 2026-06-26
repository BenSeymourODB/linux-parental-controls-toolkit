<!--
  First-run dependency setup progress screen.

  Shown after the admin logs in when the Ansible venv bootstrap is still
  in progress. Presentational: the parent owns polling and passes the
  current status snapshot. Three states:

  - bootstrapping / idle  → indeterminate progress bar + informational copy
  - bootstrapping / idle + timed out → same bar + "Continue" escape hatch
  - unavailable           → error detail + "Continue to dashboard" escape hatch

  The "continue" escape hatch matters because Ansible is required only for
  the client-configuration features; the rest of the dashboard is usable
  without it.

  A 5-minute internal timeout surfaces the escape hatch even while still
  bootstrapping/idle, guarding against a permanently-stalled install that
  would otherwise pin the admin on this screen indefinitely.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import type { AnsibleVenvStatusResponse } from "$lib/api/contract.js";

  interface Props {
    status: AnsibleVenvStatusResponse;
    /** Called when the user accepts an error/timeout and wants to proceed to the dashboard. */
    oncontinue: () => void;
  }

  let { status, oncontinue }: Props = $props();

  // Surface the escape hatch after 5 minutes of bootstrapping/idle with no
  // terminal transition — guards against a silently-stalled install.
  const TIMEOUT_MS = 5 * 60 * 1000;
  let timedOut = $state(false);

  onMount(() => {
    if (status.state !== "unavailable") {
      const handle = setTimeout(() => {
        timedOut = true;
      }, TIMEOUT_MS);
      return () => clearTimeout(handle);
    }
  });
</script>

<main class="setup">
  <div class="card">
    <h1>Parental Controls</h1>
    <h2>First-time setup</h2>

    {#if status.state === "unavailable"}
      <p class="error" role="alert">
        Ansible setup failed: {status.detail ?? "An unknown error occurred."}
      </p>
      <p class="note">
        Client configuration features (running Ansible playbooks on managed machines) won't work
        until Ansible is installed. You can continue to the dashboard now; retrying setup requires
        restarting the container with network access to PyPI.
      </p>
      <button onclick={oncontinue}>Continue to dashboard</button>
    {:else}
      <div class="bar-track" role="progressbar" aria-label="Installing Ansible…">
        <div class="bar-fill"></div>
      </div>
      {#if timedOut}
        <p class="warning" role="status">
          Ansible is taking longer than expected. Client configuration features won't be available
          until it finishes, but you can use the rest of the dashboard now.
        </p>
        <button onclick={oncontinue}>Continue to dashboard</button>
      {:else}
        <p class="status">
          Installing Ansible — this only happens once and may take a few minutes.
        </p>
      {/if}
    {/if}
  </div>
</main>

<style>
  .setup {
    display: flex;
    min-height: 100vh;
    align-items: center;
    justify-content: center;
    background: #f3f4f6;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: min(28rem, 90vw);
    padding: 2rem;
    background: #fff;
    border-radius: 0.75rem;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
  }
  h1 {
    margin: 0;
    font-size: 1.4rem;
  }
  h2 {
    margin: 0 0 0.25rem;
    font-size: 1rem;
    font-weight: 600;
    color: #374151;
  }
  .bar-track {
    width: 100%;
    height: 6px;
    background: #e5e7eb;
    border-radius: 3px;
    overflow: hidden;
    margin: 0.25rem 0;
  }
  .bar-fill {
    height: 100%;
    width: 45%;
    background: #2563eb;
    border-radius: 3px;
    animation: shuttle 1.4s ease-in-out infinite alternate;
  }
  @keyframes shuttle {
    from {
      margin-left: 0;
    }
    to {
      margin-left: 55%;
    }
  }
  .status {
    margin: 0;
    color: #6b7280;
    font-size: 0.875rem;
  }
  .warning {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border-radius: 0.4rem;
    background: #fffbeb;
    color: #92400e;
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .error {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border-radius: 0.4rem;
    background: #fef2f2;
    color: #b91c1c;
    font-size: 0.85rem;
  }
  .note {
    margin: 0;
    color: #6b7280;
    font-size: 0.85rem;
    line-height: 1.5;
  }
  button {
    margin-top: 0.25rem;
    padding: 0.6rem;
    border: none;
    border-radius: 0.4rem;
    background: #2563eb;
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
  }
  button:hover {
    background: #1d4ed8;
  }
</style>
