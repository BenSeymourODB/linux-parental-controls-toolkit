<!--
  Authenticated admin shell (#53): a fixed sidebar with the section nav and the
  signed-in admin + logout, plus the main content area for the active view.
  Sections are passed in so the orchestrator owns which views exist (only the
  ones actually implemented in this slice are wired); this avoids dead nav
  links to not-yet-built editors.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  /** One selectable section in the sidebar. */
  export interface NavItem {
    id: string;
    label: string;
  }

  interface Props {
    items: NavItem[];
    /** The currently active section id. */
    active: string;
    /** The signed-in admin's username, shown in the sidebar footer. */
    username: string;
    onnavigate: (id: string) => void;
    onlogout: () => void;
    /** The active view's content. */
    children: Snippet;
  }

  let { items, active, username, onnavigate, onlogout, children }: Props = $props();
</script>

<div class="layout">
  <aside class="sidebar">
    <div class="brand">Parental Controls</div>
    <nav>
      {#each items as item (item.id)}
        <button
          class="nav-item"
          class:active={item.id === active}
          aria-current={item.id === active ? "page" : undefined}
          onclick={() => onnavigate(item.id)}
        >
          {item.label}
        </button>
      {/each}
    </nav>
    <div class="account">
      <span class="username" title={username}>{username}</span>
      <button class="logout" onclick={onlogout}>Sign out</button>
    </div>
  </aside>
  <main class="content">
    {@render children()}
  </main>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 15rem 1fr;
    min-height: 100vh;
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1rem;
    background: #111827;
    color: #e5e7eb;
  }
  .brand {
    margin-bottom: 1rem;
    font-weight: 600;
    font-size: 1.05rem;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1;
  }
  .nav-item {
    text-align: left;
    padding: 0.5rem 0.6rem;
    border: none;
    border-radius: 0.4rem;
    background: transparent;
    color: inherit;
    font-size: 0.95rem;
    cursor: pointer;
  }
  .nav-item:hover {
    background: #1f2937;
  }
  .nav-item.active {
    background: #2563eb;
    color: #fff;
  }
  .account {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding-top: 1rem;
    border-top: 1px solid #1f2937;
  }
  .username {
    font-size: 0.85rem;
    color: #9ca3af;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .logout {
    padding: 0.45rem;
    border: 1px solid #374151;
    border-radius: 0.4rem;
    background: transparent;
    color: #e5e7eb;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .logout:hover {
    background: #1f2937;
  }
  .content {
    padding: 1.5rem 2rem;
    background: #f9fafb;
  }
</style>
