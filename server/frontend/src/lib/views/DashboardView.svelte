<!--
  Admin landing view (#53). A lightweight welcome panel for the foundation
  slice; the burndown charts and live status are Phase 5 / 8b and land with
  their own roadmap items.
-->
<script lang="ts">
  interface Props {
    username: string;
    /** Jump to a section by id (wired to the shell nav). */
    onnavigate: (id: string) => void;
  }
  let { username, onnavigate }: Props = $props();
</script>

<section>
  <h1>Welcome, {username}</h1>
  <p class="lead">
    This is the admin dashboard for the parental-controls toolkit. Manage supervised users below;
    more editors (clients, activities, budgets, schedules) and live usage charts arrive in later
    milestones.
  </p>
  <button onclick={() => onnavigate("users")}>Manage users →</button>
</section>

<style>
  h1 {
    margin: 0 0 0.5rem;
    font-size: 1.4rem;
  }
  .lead {
    max-width: 42rem;
    color: #4b5563;
    line-height: 1.5;
  }
  button {
    margin-top: 1rem;
    padding: 0.55rem 0.9rem;
    border: none;
    border-radius: 0.4rem;
    background: #2563eb;
    color: #fff;
    font-size: 0.95rem;
    cursor: pointer;
  }
</style>
