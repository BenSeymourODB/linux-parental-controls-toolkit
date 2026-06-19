<!--
  Admin login screen (#53). Collects the single-admin credentials and hands
  them to the parent's `onsubmit` callback; the parent owns the `/api/auth`
  call and feeds back `pending` / `error`. Kept presentational so it stays
  trivially covered by `svelte-check` and the build.
-->
<script lang="ts">
  interface Props {
    /** Called with the entered credentials; parent performs the login call. */
    onsubmit: (username: string, password: string) => void;
    /** True while a login request is in flight (disables the form). */
    pending?: boolean;
    /** A UI-safe error message from the last failed attempt, if any. */
    error?: string | null;
  }

  let { onsubmit, pending = false, error = null }: Props = $props();

  let username = $state("");
  let password = $state("");

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    onsubmit(username, password);
  }
</script>

<main class="login">
  <form class="card" onsubmit={handleSubmit} aria-busy={pending}>
    <h1>Parental Controls</h1>
    <p class="subtitle">Sign in to the admin dashboard</p>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <label>
      <span>Username</span>
      <input
        type="text"
        name="username"
        autocomplete="username"
        bind:value={username}
        disabled={pending}
        required
      />
    </label>

    <label>
      <span>Password</span>
      <input
        type="password"
        name="password"
        autocomplete="current-password"
        bind:value={password}
        disabled={pending}
        required
      />
    </label>

    <button type="submit" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </button>
  </form>
</main>

<style>
  .login {
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
    width: min(22rem, 90vw);
    padding: 2rem;
    background: #fff;
    border-radius: 0.75rem;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
  }
  h1 {
    margin: 0;
    font-size: 1.4rem;
  }
  .subtitle {
    margin: 0 0 0.5rem;
    color: #6b7280;
    font-size: 0.9rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: #374151;
  }
  input {
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    font-size: 1rem;
  }
  button {
    margin-top: 0.5rem;
    padding: 0.6rem;
    border: none;
    border-radius: 0.4rem;
    background: #2563eb;
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .error {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border-radius: 0.4rem;
    background: #fef2f2;
    color: #b91c1c;
    font-size: 0.85rem;
  }
</style>
