// localStorage with failure swallowed (private mode, quota) — persistence is
// always best-effort in this app, never load-bearing.
export function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function lsRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
