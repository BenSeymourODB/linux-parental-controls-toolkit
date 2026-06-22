<!--
  First-run dependency setup progress screen.

  Shown after the admin logs in when the Ansible venv bootstrap is still
  in progress. Presentational: the parent owns polling and passes the
  current status snapshot. Two states:

  - bootstrapping / idle  → indeterminate progress bar + informational copy
  - unavailable           → error detail + "Continue to dashboard" escape hatch

  The "continue" escape hatch matters because Ansible is required only for
  the client-configuration features; the rest of the dashboard is usable
  without it.
-->
<script lang="ts">
  import type { AnsibleVenvStatusResponse } from "$lib/api/contract.js";

  interface Props {
    status: AnsibleVenvStatusResponse;
    /** Called when the user accepts an error and wants to proceed to the dashboard. */
    oncontinue: () => void;
  }

  let { status, oncontinue }: Props = $props();
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
      <p class="status">
        Installing Ansible — this only happens once and may take a few minutes.
      </p>
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
