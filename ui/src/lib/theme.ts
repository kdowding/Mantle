// Agent accent cascade — ported from app.js setAgentAccentColor. Pointing the
// theme-wide accent + border vars at the active agent's color cascades the
// agent's identity through the whole UI (bubbles, borders, avatar, scrollbar…).
// Re-applied on every agent switch.

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function applyAccent(hex: string | null | undefined): void {
  const color = hex || '#00d4aa';
  const root = document.documentElement.style;

  // Per-agent semantic vars (avatar borders, labels, etc.).
  root.setProperty('--agent-accent', color);
  root.setProperty('--agent-accent-dim', hexToRgba(color, 0.1));
  root.setProperty('--agent-accent-glow', hexToRgba(color, 0.25));

  // Theme-wide accent overrides — most surfaces read these.
  root.setProperty('--accent', color);
  root.setProperty('--accent-faint', hexToRgba(color, 0.05));
  root.setProperty('--accent-dim', hexToRgba(color, 0.1));
  root.setProperty('--accent-soft', hexToRgba(color, 0.12));
  root.setProperty('--accent-edge', hexToRgba(color, 0.2));
  root.setProperty('--accent-glow', hexToRgba(color, 0.25));
  root.setProperty('--border', hexToRgba(color, 0.08));
  root.setProperty('--border-strong', hexToRgba(color, 0.18));
}
