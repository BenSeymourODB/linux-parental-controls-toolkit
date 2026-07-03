<!--
  Dashboard system-service status strip (#321).

  A compact, at-a-glance row showing the health of the two server-side services
  the dashboard orchestrates — the first-run Ansible venv bootstrap (#39) and
  the managed AdGuard Home process (#96). Both back-end endpoints already exist
  and are admin-gated; this is a frontend-only ambient indicator.

  Self-contained: it loads both statuses once on mount (no background polling —
  the states are stable once settled), maps each to a colour-coded pill, and
  surfaces the `detail` field of any non-green service on hover/click. The
  AdGuard pill is hidden entirely when managed mode is not enabled (its absence
  is the default, not a problem to flag). A failed status fetch shows a red pill
  carrying the error, so a broken endpoint is visible rather than silently blank.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import type {
    AdGuardManagedStatusResponse,
    AnsibleVenvStatusResponse,
  } from "$lib/api/contract.js";
  import { fetchAdGuardManagedStatus, fetchAnsibleStatus } from "$lib/api/system.js";

  type Tone = "green" | "amber" | "red";

  interface Pill {
    key: "ansible" | "adguard";
    /** Service name shown on the pill. */
    label: string;
    /** Human-readable state text. */
    state: string;
    tone: Tone;
    /** Extra context surfaced on hover / click; null when there is nothing to add. */
    detail: string | null;
  }

  let loading = $state(true);
  let ansible = $state<AnsibleVenvStatusResponse | null>(null);
  let ansibleError = $state<string | null>(null);
  let adguard = $state<AdGuardManagedStatusResponse | null>(null);
  let adguardError = $state<string | null>(null);
  /** Key of the pill whose detail is currently expanded, if any. */
  let expandedKey = $state<string | null>(null);

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    loading = true;
    // Load both independently so one failing endpoint doesn't blank the other.
    const [a, g] = await Promise.allSettled([fetchAnsibleStatus(), fetchAdGuardManagedStatus()]);
    if (a.status === "fulfilled") {
      ansible = a.value;
      ansibleError = null;
    } else {
      ansible = null;
      ansibleError = messageOf(a.reason);
    }
    if (g.status === "fulfilled") {
      adguard = g.value;
      adguardError = null;
    } else {
      adguard = null;
      adguardError = messageOf(g.reason);
    }
    loading = false;
  }

  function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : "Status unavailable";
  }

  const ANSIBLE_STATE_LABEL: Record<string, string> = {
    idle: "Idle",
    bootstrapping: "Bootstrapping",
    ready: "Ready",
    unavailable: "Unavailable",
  };
  const ADGUARD_STATE_LABEL: Record<string, string> = {
    idle: "Idle",
    fetching: "Fetching",
    starting: "Starting",
    running: "Running",
    stopped: "Stopped",
    failed: "Failed",
  };

  function ansibleTone(state: string): Tone {
    if (state === "ready") return "green";
    if (state === "unavailable") return "red";
    return "amber"; // idle | bootstrapping — in progress
  }

  function adguardTone(state: string | null): Tone {
    if (state === "running") return "green";
    if (state === "stopped" || state === "failed") return "red";
    return "amber"; // idle | fetching | starting | null — in progress / unknown
  }

  /** Compose the AdGuard detail line, appending a non-zero restart count. */
  function adguardDetail(s: AdGuardManagedStatusResponse): string | null {
    const parts: string[] = [];
    if (s.detail) parts.push(s.detail);
    if (s.restarts !== null && s.restarts > 0) {
      parts.push(`${s.restarts} restart${s.restarts === 1 ? "" : "s"}`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  let ansiblePill = $derived<Pill>(
    ansibleError !== null
      ? { key: "ansible", label: "Ansible", state: "Error", tone: "red", detail: ansibleError }
      : ansible !== null
        ? {
            key: "ansible",
            label: "Ansible",
            state: ANSIBLE_STATE_LABEL[ansible.state] ?? ansible.state,
            tone: ansibleTone(ansible.state),
            detail: ansible.detail,
          }
        : { key: "ansible", label: "Ansible", state: "Unknown", tone: "amber", detail: null },
  );

  // AdGuard: hidden entirely when managed mode is not enabled; a fetch error
  // still shows a red pill so a broken endpoint isn't invisible.
  let adguardPill = $derived<Pill | null>(
    adguardError !== null
      ? { key: "adguard", label: "AdGuard Home", state: "Error", tone: "red", detail: adguardError }
      : adguard !== null && adguard.enabled
        ? {
            key: "adguard",
            label: "AdGuard Home",
            state: adguard.state
              ? (ADGUARD_STATE_LABEL[adguard.state] ?? adguard.state)
              : "Unknown",
            tone: adguardTone(adguard.state),
            detail: adguardDetail(adguard),
          }
        : null,
  );

  let pills = $derived([ansiblePill, adguardPill].filter((p): p is Pill => p !== null));

  function toggle(key: string): void {
    expandedKey = expandedKey === key ? null : key;
  }
</script>

{#if loading}
  <div class="system-status skeleton" role="status" aria-label="Loading system status">
    <span class="pill pill-skeleton"></span>
    <span class="pill pill-skeleton"></span>
  </div>
{:else if pills.length > 0}
  <section class="system-status" aria-label="System service status">
    {#each pills as pill (pill.key)}
      {@const interactive = pill.tone !== "green" && pill.detail !== null}
      <div class="pill-wrap">
        {#if interactive}
          <button
            class={`pill tone-${pill.tone}`}
            title={pill.detail}
            aria-expanded={expandedKey === pill.key}
            aria-controls={`detail-${pill.key}`}
            onclick={() => toggle(pill.key)}
          >
            <span class="dot" aria-hidden="true"></span>
            <span class="name">{pill.label}</span>
            <span class="state">{pill.state}</span>
          </button>
          {#if expandedKey === pill.key}
            <p id={`detail-${pill.key}`} class="detail" role="note">{pill.detail}</p>
          {/if}
        {:else}
          <span class={`pill tone-${pill.tone}`} title={pill.detail ?? undefined}>
            <span class="dot" aria-hidden="true"></span>
            <span class="name">{pill.label}</span>
            <span class="state">{pill.state}</span>
          </span>
        {/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .system-status {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }
  .pill-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid transparent;
    border-radius: 999px;
    font-size: 0.8rem;
    font-family: inherit;
    line-height: 1.2;
  }
  /* The interactive (non-green) pill is a button; keep it visually a pill. */
  button.pill {
    cursor: pointer;
  }
  .name {
    font-weight: 600;
    color: #374151;
  }
  .state {
    color: #4b5563;
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex: none;
  }
  .tone-green {
    background: #ecfdf5;
    border-color: #a7f3d0;
  }
  .tone-green .dot {
    background: #059669;
  }
  .tone-amber {
    background: #fffbeb;
    border-color: #fde68a;
  }
  .tone-amber .dot {
    background: #d97706;
  }
  .tone-red {
    background: #fef2f2;
    border-color: #fecaca;
  }
  .tone-red .dot {
    background: #dc2626;
  }
  .detail {
    margin: 0;
    max-width: 22rem;
    padding: 0.4rem 0.55rem;
    border-radius: 0.4rem;
    background: #f3f4f6;
    color: #4b5563;
    font-size: 0.78rem;
    line-height: 1.4;
  }
  /* Loading skeleton: neutral pill-shaped placeholders, no broken empty row. */
  .pill-skeleton {
    width: 8rem;
    height: 1.6rem;
    background: linear-gradient(90deg, #eef1f4 25%, #e2e6ea 50%, #eef1f4 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -200% 0;
    }
  }
</style>
