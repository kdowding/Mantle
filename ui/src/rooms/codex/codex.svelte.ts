// Codex (ChatGPT subscription) auth state + flows — port of app.js's
// fetchCodexAuthStatus / handleCodexAuthBtnClick / login polling.
//
// PKCE login runs server-side (mantle hosts the localhost:1455 callback).
// UI flow:
//   1. "Sign in" → POST /api/auth/openai-codex/login → server returns the
//      OpenAI auth URL
//   2. UI opens it in a popup window (new tab if the blocker fires)
//   3. User authorizes → OpenAI redirects to localhost:1455/auth/callback →
//      mantle exchanges the code for tokens and persists them
//   4. UI polls /api/auth/openai-codex/status every 1.5s until loggedIn
//   5. Polling stops; the row re-renders with the identity badge
//
// Cancellation: closing the popup doesn't cancel the server-side OAuth wait
// (it just sits on its 5-min timeout). The polling loop bails out as soon as
// the server reports loginInFlight=false without loggedIn=true.
import { confirmDialog } from '../../components/confirm.svelte';

export interface CodexUsage {
  primaryUsedPercent?: number | null; // 5h window
  secondaryUsedPercent?: number | null; // 7d window
  primaryResetAfterSeconds?: number | null;
  secondaryResetAfterSeconds?: number | null;
}

export interface CodexStatus {
  loggedIn?: boolean;
  loginInFlight?: boolean;
  email?: string;
  accountId?: string;
  plan?: string;
  usage?: CodexUsage;
}

export const codex = $state({
  status: null as CodexStatus | null,
  busy: false,
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
let loginPopup: Window | null = null;

export async function fetchCodexStatus(): Promise<CodexStatus | null> {
  try {
    const res = await fetch('/api/auth/openai-codex/status');
    codex.status = (await res.json()) as CodexStatus;
    return codex.status;
  } catch {
    return null;
  }
}

export async function codexLogin(): Promise<void> {
  if (codex.busy) return;
  codex.busy = true;
  try {
    const res = await fetch('/api/auth/openai-codex/login', { method: 'POST' });
    const data = (await res.json()) as { authUrl?: string; error?: string };
    if (data.error || !data.authUrl) throw new Error(data.error ?? 'no auth URL');
    // Popup preferred; blocked → plain new tab.
    try {
      loginPopup = window.open(data.authUrl, 'codex-login', 'width=620,height=780');
    } catch {
      loginPopup = null;
    }
    if (!loginPopup) window.open(data.authUrl, '_blank', 'noopener');
    await fetchCodexStatus();
    startPolling();
  } catch (e) {
    console.warn('[codex] login failed:', e);
  } finally {
    codex.busy = false;
  }
}

export async function codexLogout(): Promise<void> {
  if (codex.busy) return;
  const ok = await confirmDialog({
    title: 'Sign out of ChatGPT?',
    message: 'You will need to log in again to use the Codex subscription backend.',
    confirmText: 'Sign out',
    danger: true,
  });
  if (!ok) return;
  codex.busy = true;
  try {
    await fetch('/api/auth/openai-codex/logout', { method: 'POST' });
    await fetchCodexStatus();
  } catch (e) {
    console.warn('[codex] logout failed:', e);
  } finally {
    codex.busy = false;
  }
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void (async () => {
      const data = await fetchCodexStatus();
      if (!data) return;
      if (data.loggedIn) {
        stopPolling();
        // Best-effort close — fails silently when the browser objects.
        try { loginPopup?.close?.(); } catch { /* ignore */ }
        loginPopup = null;
      } else if (!data.loginInFlight) {
        // Flow finished without success (timeout or cancel) — stop hammering.
        stopPolling();
      }
    })();
  }, 1500);
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
