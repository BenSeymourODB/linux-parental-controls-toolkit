<!--
  /app landing — the entry point of the mobile/PWA surface.

  This slice (#112) wires the **per-user PIN login**: a child enters their user
  number + PIN and gets a session scoped to only their own data. The live
  per-child status (time left, limits, next transition, rewards) renders into
  the signed-in state in #110, the parent home + quick-grant screens in #111,
  all reading from `/api/*`.

  Like the /admin page, the frontend is built with `adapter-static` and Fastify
  serves only `/app` → `app.html`; the whole surface lives on this one
  prerendered page and re-derives auth state from `/api/app/session` on load.
  Prerendering runs in Node where `browser` is false, so the session probe and
  every `/api` call are guarded to the browser.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { browser } from "$app/environment";
  import { ApiError } from "$lib/api/client.js";
  import { fetchAppSession, pinLogin, pinLogout } from "$lib/api/app-session.js";
  import type { PinSessionResponse } from "$lib/api/contract.js";
  import AppStatusView from "$lib/views/AppStatusView.svelte";

  // `null` while the initial session probe is in flight.
  let session = $state<PinSessionResponse | null>(null);

  // Login form state.
  let userId = $state("");
  let pin = $state("");
  let loginError = $state<string | null>(null);
  let loginPending = $state(false);

  let authenticated = $derived(session?.authenticated === true);

  onMount(probeSession);

  async function probeSession(): Promise<void> {
    if (!browser) {
      return;
    }
    try {
      session = await fetchAppSession();
    } catch (err) {
      // An unconfigured-auth 503 or a 401 both mean "show the PIN screen".
      session = { authenticated: false };
      if (err instanceof ApiError) {
        if (!err.unauthorized && err.status !== 503) {
          loginError = err.message;
        }
      } else {
        loginError = "Unable to reach the server. Please try again.";
      }
    }
  }

  async function handleLogin(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
      loginError = "Enter your user number.";
      return;
    }
    loginPending = true;
    loginError = null;
    try {
      session = await pinLogin({ userId: id, pin });
      pin = "";
    } catch (err) {
      loginError =
        err instanceof ApiError && err.status === 429
          ? "Too many tries. Wait a little while, then try again."
          : "That user number or PIN didn't match. Try again.";
    } finally {
      loginPending = false;
    }
  }

  async function handleLogout(): Promise<void> {
    try {
      session = await pinLogout();
    } catch {
      // Logout is best-effort; drop to the login screen regardless.
      session = { authenticated: false };
    }
    userId = "";
    pin = "";
  }
</script>

{#if session === null}
  <p class="loading" role="status">Loading…</p>
{:else if authenticated}
  <AppStatusView />
  <div class="signout-row">
    <button type="button" class="link" onclick={handleLogout}>Sign out</button>
  </div>
{:else}
  <section class="login" aria-labelledby="login-title">
    <h1 id="login-title">Sign in</h1>
    <p class="sub">Enter your user number and PIN to see your screen time.</p>
    <form onsubmit={handleLogin}>
      <label>
        User number
        <input
          type="number"
          inputmode="numeric"
          min="1"
          step="1"
          bind:value={userId}
          autocomplete="username"
          required
        />
      </label>
      <label>
        PIN
        <input
          type="password"
          inputmode="numeric"
          bind:value={pin}
          autocomplete="current-password"
          required
        />
      </label>
      {#if loginError}
        <p class="error" role="alert">{loginError}</p>
      {/if}
      <button type="submit" disabled={loginPending}>
        {loginPending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  </section>
{/if}

<style>
  .loading {
    text-align: center;
    color: var(--muted);
    padding: 32px 8px;
  }

  .login {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 28px 18px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }

  .signout-row {
    display: flex;
    justify-content: center;
    margin-top: 16px;
  }

  h1 {
    margin: 4px 0 0;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .sub {
    margin: 0;
    font-size: 13.5px;
    color: var(--muted);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 4px;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  input {
    font: inherit;
    font-size: 16px; /* >=16px so iOS Safari doesn't zoom on focus */
    padding: 11px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
    color: var(--text);
  }

  input:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
    border-color: var(--primary);
  }

  button[type="submit"] {
    font: inherit;
    font-weight: 700;
    font-size: 15px;
    padding: 12px;
    border: 0;
    border-radius: 10px;
    background: var(--primary);
    color: #fff;
    cursor: pointer;
  }

  button[type="submit"]:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .link {
    align-self: center;
    background: none;
    border: 0;
    color: var(--primary);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 8px;
  }

  .error {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--red);
  }
</style>
