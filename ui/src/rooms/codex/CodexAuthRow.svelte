<!-- Codex auth row — identity / usage status + sign-in/out, shown inside the
     backend picker's popover while the ChatGPT·Codex backend is selected.
     Port of app.js::renderCodexAuthRow (styles from ui/styles.css). -->
<script lang="ts">
  import { codex, fetchCodexStatus, codexLogin, codexLogout } from './codex.svelte';

  $effect(() => {
    void fetchCodexStatus();
  });

  // "X% / Y%" = 5h primary window / 7d secondary; tooltip carries the resets.
  const statusText = $derived.by(() => {
    const s = codex.status;
    if (!s) return '…';
    if (s.loggedIn) {
      const id = s.email || s.accountId?.slice(0, 8) || 'logged in';
      const plan = s.plan ? ` · ${s.plan}` : '';
      const u = s.usage;
      const usage = u && u.primaryUsedPercent != null && u.secondaryUsedPercent != null
        ? ` · ${u.primaryUsedPercent}% / ${u.secondaryUsedPercent}%`
        : '';
      return `${id}${plan}${usage}`;
    }
    if (s.loginInFlight) return 'Waiting for browser sign-in…';
    return 'Not signed in';
  });

  const fmtReset = (s: number): string =>
    s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`;

  const statusTitle = $derived.by(() => {
    const u = codex.status?.usage;
    if (!codex.status?.loggedIn || !u || u.primaryResetAfterSeconds == null || u.secondaryResetAfterSeconds == null) return '';
    return `5h window resets in ${fmtReset(u.primaryResetAfterSeconds)}\n7d window resets in ${fmtReset(u.secondaryResetAfterSeconds)}`;
  });

  const state = $derived(
    codex.status?.loggedIn ? 'in' : codex.status?.loginInFlight ? 'pending' : 'out',
  );

  function onAction(): void {
    if (codex.status?.loggedIn) void codexLogout();
    else void codexLogin();
  }
</script>

<div class="codex-auth-row">
  <span
    class="codex-auth-status"
    class:is-logged-in={state === 'in'}
    class:is-pending={state === 'pending'}
    class:is-logged-out={state === 'out'}
    title={statusTitle}
  >{statusText}</span>
  <button class="codex-auth-btn" type="button" disabled={codex.busy} onclick={onAction}>
    {codex.status?.loggedIn ? 'Sign out' : codex.status?.loginInFlight ? 'Reopen' : 'Sign in'}
  </button>
</div>

<style>
  .codex-auth-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 10px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    font-family: var(--font-display);
    font-size: 12.5px;
    letter-spacing: 0.6px;
  }
  .codex-auth-status {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .codex-auth-status.is-logged-in { color: var(--accent); }
  .codex-auth-status.is-pending { color: var(--accent-purple, #b83dff); }
  .codex-auth-status.is-logged-out { color: var(--accent-pink, #ff2d7c); }
  .codex-auth-btn {
    background: var(--bg-panel, var(--bg-tertiary));
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
    font-weight: 600;
    padding: 4px 9px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .codex-auth-btn:hover:not(:disabled) { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .codex-auth-btn:disabled { opacity: 0.5; cursor: default; }
</style>
