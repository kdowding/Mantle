<!-- Auth gate — full-screen login / first-run setup card. Rendered by
     App.svelte INSTEAD of the shell while unauthenticated (the Svelte
     equivalent of the old "don't run init() until the cookie checks out" —
     no room mounts, no 401ing fetches behind the wall). Port of
     ui/index.html#auth-overlay + app.js::showAuthGate/submitAuth. -->
<script lang="ts">
  import { auth, submitAuth } from '../lib/auth.svelte';

  const setupMode = $derived(auth.stage === 'setup');

  let username = $state('');
  let password = $state('');
  let confirm = $state('');
  let error = $state('');
  let busy = $state(false);

  async function onSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = '';
    const err = await submitAuth(setupMode, username.trim(), password, confirm);
    busy = false;
    if (err) error = err;
    // success: auth.stage flipped to 'ready' — App swaps this view for the shell
  }
</script>

<div class="auth-overlay">
  <div class="auth-card">
    <div class="auth-brand">rev://MANTLE</div>
    <h1 class="auth-title">{setupMode ? 'Create your login' : 'Sign in'}</h1>
    <p class="auth-subtitle">
      {setupMode
        ? 'First-run setup - choose a username and password to lock down this instance.'
        : 'Enter your credentials to access this instance.'}
    </p>
    <form class="auth-form" autocomplete="on" onsubmit={onSubmit}>
      <label class="auth-label" for="auth-username">Username</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="auth-input"
        id="auth-username"
        type="text"
        name="username"
        autocomplete="username"
        autocapitalize="none"
        spellcheck="false"
        required
        autofocus
        bind:value={username}
      />
      <label class="auth-label" for="auth-password">Password</label>
      <input
        class="auth-input"
        id="auth-password"
        type="password"
        name="password"
        autocomplete={setupMode ? 'new-password' : 'current-password'}
        required
        bind:value={password}
      />
      {#if setupMode}
        <label class="auth-label" for="auth-confirm">Confirm password</label>
        <input
          class="auth-input"
          id="auth-confirm"
          type="password"
          name="confirm"
          autocomplete="new-password"
          bind:value={confirm}
        />
      {/if}
      {#if error}
        <div class="auth-error" role="alert">{error}</div>
      {/if}
      <button class="auth-submit" type="submit" disabled={busy}>
        {busy ? (setupMode ? 'Creating…' : 'Signing in…') : (setupMode ? 'Create account' : 'Sign in')}
      </button>
    </form>
    {#if setupMode}
      <div class="auth-footnote">Lost it later? Delete .mantle/auth/users.json to reset first-run setup.</div>
    {/if}
  </div>
</div>

<style>
  /* Carried from ui/styles-auth.css — cyberpunk shell: clip-path corner cuts,
     no border-radius, teal accent, deep-black fields. */
  .auth-overlay {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background:
      radial-gradient(120% 120% at 12% 0%, rgba(0, 212, 170, 0.10), transparent 55%),
      radial-gradient(120% 120% at 100% 100%, rgba(184, 61, 255, 0.10), transparent 55%),
      rgba(8, 8, 13, 0.94);
    backdrop-filter: blur(6px);
  }

  .auth-card {
    width: 100%;
    max-width: 380px;
    padding: 32px 30px 26px;
    background: var(--bg-elevated, #0f0f17);
    border: 1px solid var(--accent-edge);
    clip-path: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px));
    box-shadow:
      0 24px 60px rgba(0, 0, 0, 0.55),
      0 0 40px var(--accent-glow);
  }

  .auth-brand {
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: var(--accent);
    opacity: 0.85;
    margin-bottom: 18px;
  }

  .auth-title {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 0.5px;
    color: var(--text-primary);
    margin: 0 0 6px;
  }

  .auth-subtitle {
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-muted);
    margin: 0 0 22px;
  }

  .auth-form { display: flex; flex-direction: column; gap: 0; }

  .auth-label {
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 12px 0 5px;
  }

  .auth-input {
    width: 100%;
    padding: 11px 13px;
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text-primary);
    background: var(--bg-primary);
    border: 1px solid var(--border-strong);
    clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .auth-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent), 0 0 16px var(--accent-glow);
  }

  .auth-error {
    margin-top: 14px;
    padding: 9px 12px;
    font-size: 12.5px;
    line-height: 1.45;
    color: #ff6b9d;
    background: rgba(255, 45, 124, 0.10);
    border-left: 2px solid var(--accent-pink);
  }

  .auth-submit {
    margin-top: 22px;
    padding: 12px 16px;
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: #07120f;
    background: var(--accent);
    border: none;
    cursor: pointer;
    clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
    transition: filter 0.15s ease, box-shadow 0.15s ease;
  }
  .auth-submit:hover { filter: brightness(1.1); box-shadow: 0 0 20px var(--accent-glow); }
  .auth-submit:disabled { opacity: 0.6; cursor: default; filter: none; box-shadow: none; }

  .auth-footnote {
    margin-top: 16px;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text-faint, #5a5a68);
  }
</style>
