<!--
  The /admin surface (#53).

  Architecture note: the frontend is built with `adapter-static`, and the
  Fastify static mount (#40) serves only `/admin` → `admin.html`. URL-routed
  deep pages plus an SPA fallback (and the asset-base fix that needs) are #59's
  scope and are deferred. So the whole admin experience lives on this one
  prerendered page and switches between views with client-side state: a hard
  refresh always lands here and re-derives auth state from `/api/auth/session`.

  Prerendering runs in Node where `browser` is false, so the session probe and
  every `/api` call are guarded to the browser; the prerendered output is just
  the static shell.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { browser } from "$app/environment";
  import { ApiError } from "$lib/api/client.js";
  import { fetchSession, login, logout } from "$lib/api/auth.js";
  import type { SessionResponse } from "$lib/api/contract.js";
  import AppShell, { type NavItem } from "$lib/components/AppShell.svelte";
  import LoginForm from "$lib/components/LoginForm.svelte";
  import DashboardView from "$lib/views/DashboardView.svelte";
  import UsersView from "$lib/views/UsersView.svelte";
  import UserGroupsView from "$lib/views/UserGroupsView.svelte";
  import ClientsView from "$lib/views/ClientsView.svelte";
  import ClientHealthView from "$lib/views/ClientHealthView.svelte";
  import ActivitiesView from "$lib/views/ActivitiesView.svelte";
  import ActivityGroupsView from "$lib/views/ActivityGroupsView.svelte";
  import BudgetsView from "$lib/views/BudgetsView.svelte";
  import SchedulesView from "$lib/views/SchedulesView.svelte";
  import PolicyPreviewView from "$lib/views/PolicyPreviewView.svelte";
  import GroupSchedulesView from "$lib/views/GroupSchedulesView.svelte";
  import ExceptionsView from "$lib/views/ExceptionsView.svelte";
  import NotificationsView from "$lib/views/NotificationsView.svelte";
  import LinksView from "$lib/views/LinksView.svelte";
  import IntegrationTokensView from "$lib/views/IntegrationTokensView.svelte";
  import AuditLogView from "$lib/views/AuditLogView.svelte";

  // `null` while the initial session probe is in flight.
  let session = $state<SessionResponse | null>(null);
  let loginError = $state<string | null>(null);
  let loginPending = $state(false);

  // Only the sections actually implemented in this slice are listed, so the
  // nav never points at a not-yet-built editor.
  const navItems: NavItem[] = [
    { id: "dashboard", label: "Dashboard" },
    { id: "users", label: "Users" },
    { id: "user-groups", label: "User Groups" },
    { id: "clients", label: "Clients" },
    { id: "client-health", label: "Client Health" },
    { id: "links", label: "User ↔ Client links" },
    { id: "activities", label: "Activities" },
    { id: "activity-groups", label: "Activity Groups" },
    { id: "budgets", label: "Budgets" },
    { id: "schedules", label: "Schedules" },
    { id: "policy-preview", label: "Policy preview" },
    { id: "group-schedules", label: "Group Schedules" },
    { id: "exceptions", label: "Exceptions" },
    { id: "notifications", label: "Notifications" },
    { id: "integrations", label: "Integrations" },
    { id: "audit", label: "Audit log" },
  ];
  let activeView = $state<string>("dashboard");

  let authenticated = $derived(session?.authenticated === true);
  let username = $derived(session?.username ?? "admin");

  onMount(probeSession);

  async function probeSession(): Promise<void> {
    if (!browser) {
      return;
    }
    try {
      session = await fetchSession();
    } catch (err) {
      // An unconfigured-auth 500 or a 401 both mean "show the login screen".
      session = { authenticated: false };
      if (err instanceof ApiError) {
        if (!err.unauthorized && err.status !== 500) {
          loginError = err.message;
        }
      } else {
        // A network/transport failure (fetch rejects) — don't leave the login
        // screen unexplained.
        loginError = "Unable to reach the server. Please try again.";
      }
    }
  }

  async function handleLogin(user: string, password: string): Promise<void> {
    loginPending = true;
    loginError = null;
    try {
      session = await login({ username: user, password });
      activeView = "dashboard";
    } catch (err) {
      loginError = err instanceof ApiError ? err.message : "Unable to sign in. Please try again.";
    } finally {
      loginPending = false;
    }
  }

  async function handleLogout(): Promise<void> {
    try {
      await logout();
    } finally {
      session = { authenticated: false };
      loginError = null;
    }
  }
</script>

<svelte:head>
  <title>Admin · Parental Controls</title>
</svelte:head>

{#if session === null}
  <main class="loading"><p>Loading…</p></main>
{:else if !authenticated}
  <LoginForm onsubmit={handleLogin} pending={loginPending} error={loginError} />
{:else}
  <AppShell
    items={navItems}
    active={activeView}
    {username}
    onnavigate={(id) => (activeView = id)}
    onlogout={handleLogout}
  >
    {#if activeView === "users"}
      <UsersView />
    {:else if activeView === "user-groups"}
      <UserGroupsView />
    {:else if activeView === "clients"}
      <ClientsView />
    {:else if activeView === "client-health"}
      <ClientHealthView />
    {:else if activeView === "links"}
      <LinksView />
    {:else if activeView === "activities"}
      <ActivitiesView />
    {:else if activeView === "activity-groups"}
      <ActivityGroupsView />
    {:else if activeView === "budgets"}
      <BudgetsView />
    {:else if activeView === "schedules"}
      <SchedulesView />
    {:else if activeView === "policy-preview"}
      <PolicyPreviewView />
    {:else if activeView === "group-schedules"}
      <GroupSchedulesView />
    {:else if activeView === "exceptions"}
      <ExceptionsView />
    {:else if activeView === "notifications"}
      <NotificationsView />
    {:else if activeView === "integrations"}
      <IntegrationTokensView />
    {:else if activeView === "audit"}
      <AuditLogView />
    {:else}
      <DashboardView {username} onnavigate={(id) => (activeView = id)} />
    {/if}
  </AppShell>
{/if}

<style>
  .loading {
    display: flex;
    min-height: 100vh;
    align-items: center;
    justify-content: center;
    color: #6b7280;
  }
  :global(body) {
    margin: 0;
    font-family:
      system-ui,
      -apple-system,
      "Segoe UI",
      Roboto,
      sans-serif;
  }
</style>
