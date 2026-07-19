// Auth gate state + flows — the Svelte port of app.js's checkAuthAndBoot /
// submitAuth / mantleLogout. Single chokepoint: App.svelte renders the shell
// (and connects the WS, loads agents) only once `auth.stage === 'ready'`.
// The session cookie is HttpOnly, so JS never handles the token — it rides on
// same-origin fetches + the WS upgrade automatically.

export const auth = $state({
  stage: 'checking' as 'checking' | 'login' | 'setup' | 'ready',
  // Hides the sign-out control when the wall is off (MANTLE_AUTH_DISABLED /
  // config.server.auth.enabled=false).
  disabled: false,
});

interface SessionPayload {
  authenticated?: boolean;
  setupRequired?: boolean;
  authDisabled?: boolean;
}

export async function checkAuth(): Promise<void> {
  let data: SessionPayload;
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    data = (await res.json()) as SessionPayload;
  } catch {
    // Server unreachable — boot anyway and let the shell's own loads surface it.
    auth.stage = 'ready';
    return;
  }
  if (data?.authenticated) {
    auth.disabled = !!data.authDisabled;
    auth.stage = 'ready';
    return;
  }
  auth.stage = data?.setupRequired ? 'setup' : 'login';
}

// Returns an error message to show inline, or null on success (the cookie is
// set; the caller flips nothing — `auth.stage` is already 'ready').
export async function submitAuth(
  setupMode: boolean,
  username: string,
  password: string,
  confirm: string,
): Promise<string | null> {
  if (!username || !password) return 'Username and password are required.';
  if (setupMode) {
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (password !== confirm) return 'Passwords do not match.';
  }
  try {
    const res = await fetch(setupMode ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      return data.error ?? (setupMode ? 'Could not create account.' : 'Invalid username or password.');
    }
    auth.stage = 'ready';
    return null;
  } catch {
    return 'Network error - is the server running?';
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch { /* ignore — the reload still lands us at the login gate */ }
  location.reload();
}
