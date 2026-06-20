<!--
  /app landing — the entry point of the mobile/PWA surface. This ships the
  installable, offline-capable app *shell* (#109); the live per-child status
  (time left, limits, next transition, rewards) renders here in #110, the
  parent home + quick-grant screens in #111, all reading from `/api/*`.
-->
<section class="welcome" aria-labelledby="welcome-title">
  <div class="ring" aria-hidden="true"></div>
  <h1 id="welcome-title">Welcome</h1>
  <p>
    This is your screen-time app. Your time left, today's limits and the rewards
    you've earned will show up here.
  </p>
  <p class="note">Add it to your home screen to open it like an app.</p>
</section>

<style>
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 12px;
    padding: 32px 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }

  .ring {
    width: 96px;
    height: 96px;
    border-radius: 50%;
    border: 12px solid var(--surface-3);
    border-top-color: var(--primary);
  }

  h1 {
    margin: 4px 0 0;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  p {
    margin: 0;
    max-width: 30ch;
    font-size: 14px;
    color: var(--muted);
  }

  .note {
    font-size: 12.5px;
    color: var(--faint);
  }
</style>
