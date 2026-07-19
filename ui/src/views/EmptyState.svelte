<!-- Empty-state lobby card — pre-session agent identity (avatar + chroma name
     + rotating tagline) with the brand stamp. Port of app.js showEmptyState /
     styles.css .empty-state-card. The old lobby call block is gone on purpose;
     the call chip lives in the profile bar. -->
<script lang="ts">
  import { ui, serverConfig } from '../lib/state.svelte';
  import { quote } from '../lib/quotes.svelte';
  import { cipher } from '../lib/cipher';

  const name = $derived(ui.profile?.name ?? 'MANTLE');
  const initial = $derived((name || '?').charAt(0).toUpperCase());
  // Fall back to the initial if the avatar fails to load — mirrors the profile
  // bar so an agent with no (or a broken) avatar shows the placeholder rather
  // than a broken-image icon.
  let imgFailed = $state(false);
  // No provider connected at all → this agent can't reply yet. Surface it here
  // rather than letting the first send fail silently server-side (the
  // create-agent-before-adding-a-key path).
  const noBackend = $derived(
    serverConfig.backends.length > 0 && serverConfig.backends.every((b) => !b.configured),
  );
</script>

<div class="empty-card">
  <span class="frame-corner tl" aria-hidden="true"></span>
  <span class="frame-corner br" aria-hidden="true"></span>
  <div class="empty-avatar">
    {#if ui.profile?.avatarUrl && !imgFailed}
      <img src={ui.profile.avatarUrl} alt={name} onerror={() => (imgFailed = true)} />
    {:else}
      <div class="empty-avatar-fallback">{initial}</div>
    {/if}
  </div>
  <div class="empty-name" role="heading" aria-level="2" aria-label={name} use:cipher={name}></div>
  {#if quote.text}
    <div class="empty-tagline">{quote.text}</div>
  {/if}
  <div class="empty-divider"></div>
  <div class="empty-brand">rev://<span class="accent">MANTLE</span></div>
  {#if noBackend}
    <div class="empty-warn">No provider connected - add an API key in Settings &rarr; Providers before this agent can reply.</div>
  {:else}
    <div class="empty-prompt">Send a message to begin the session.</div>
    <div class="empty-status">[ awaiting input <span class="cursor">▌</span> ]</div>
  {/if}
</div>

<style>
  /* Carried from ui/styles.css (.empty-state-card and friends). */
  .empty-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 44px 48px;
    max-width: 520px;
    margin: auto;
    text-align: center;
    font-family: var(--font-display);
    letter-spacing: 1px;
    position: relative;
  }

  /* HUD frame corners — the card floats inside bracket marks. */
  .frame-corner {
    position: absolute;
    width: 26px;
    height: 26px;
    pointer-events: none;
  }
  .frame-corner.tl {
    top: 0;
    left: 0;
    border-top: 1px solid var(--accent-edge);
    border-left: 1px solid var(--accent-edge);
  }
  .frame-corner.br {
    right: 0;
    bottom: 0;
    border-right: 1px solid var(--accent-edge);
    border-bottom: 1px solid var(--accent-edge);
  }

  .empty-status {
    margin-top: 6px;
    font-family: var(--font-terminal);
    font-size: 10px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--text-muted);
    opacity: 0.65;
  }
  .empty-status .cursor {
    color: var(--accent);
    animation: empty-cursor-blink 1.1s step-end infinite;
  }
  @keyframes empty-cursor-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .empty-status .cursor { animation: none; }
  }

  .empty-avatar { width: 96px; height: 96px; margin-bottom: 4px; position: relative; }
  .empty-avatar img,
  .empty-avatar-fallback {
    width: 96px;
    height: 96px;
    clip-path: polygon(var(--cut, 12px) 0, 100% 0, 100% calc(100% - var(--cut, 12px)), calc(100% - var(--cut, 12px)) 100%, 0 100%, 0 var(--cut, 12px));
    border: 2px solid var(--agent-accent);
    box-shadow: 0 0 24px var(--agent-accent-glow);
    object-fit: cover;
    display: block;
    /* Presence — the agent breathes while waiting. */
    animation: ava-breathe 5s ease-in-out infinite;
  }
  @keyframes ava-breathe {
    0%, 100% { box-shadow: 0 0 18px var(--agent-accent-dim); }
    50%      { box-shadow: 0 0 34px var(--agent-accent-glow); }
  }
  /* Radar ping — an expanding square ring marking the agent's position. */
  .empty-avatar::after {
    content: '';
    position: absolute;
    inset: -2px;
    border: 1px solid var(--agent-accent);
    opacity: 0;
    animation: ava-ping 4.5s ease-out infinite;
    pointer-events: none;
  }
  @keyframes ava-ping {
    0%, 60% { transform: scale(1); opacity: 0; }
    64%     { opacity: 0.5; }
    100%    { transform: scale(1.45); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .empty-avatar img, .empty-avatar-fallback { animation: none; }
    .empty-avatar::after { display: none; }
  }
  .empty-avatar-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 48px;
    color: var(--agent-accent);
    background: var(--agent-accent-dim);
  }

  /* Chromatic-aberration name — same treatment as the profile bar but bigger
     and centered; brief two-frame glitch punctuation every 9s. */
  .empty-name {
    font-weight: 800;
    font-size: 38px;
    color: var(--text-primary);
    text-transform: uppercase;
    letter-spacing: 6px;
    line-height: 1;
    position: relative;
    display: inline-block;
    padding: 4px 0 12px;
    text-shadow:
      -1px 0 0 rgba(255, 45, 124, 0.45),
      1px 0 0 rgba(0, 200, 255, 0.45),
      0 0 22px var(--agent-accent-glow);
    animation: empty-name-glitch 9s infinite;
    will-change: text-shadow, transform;
  }
  .empty-name::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    height: 2px;
    width: 50%;
    background: linear-gradient(to right, transparent 0%, var(--agent-accent) 30%, var(--agent-accent) 70%, transparent 100%);
  }
  @keyframes empty-name-glitch {
    0%, 93%, 97%, 100% {
      text-shadow:
        -1px 0 0 rgba(255, 45, 124, 0.45),
        1px 0 0 rgba(0, 200, 255, 0.45),
        0 0 18px var(--agent-accent-glow);
      transform: translate(0, 0);
    }
    94% {
      text-shadow:
        -2px 0 0 rgba(255, 45, 124, 0.7),
        2px 0 0 rgba(0, 200, 255, 0.7),
        0 0 20px var(--agent-accent-glow);
      transform: translate(-1px, 0);
    }
    96% {
      text-shadow:
        2px 0 0 rgba(255, 45, 124, 0.7),
        -2px 0 0 rgba(0, 200, 255, 0.7),
        0 0 20px var(--agent-accent-glow);
      transform: translate(1px, 0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .empty-name { animation: none; }
  }

  .empty-tagline {
    font-size: 14px;
    font-weight: 400;
    color: var(--text-secondary);
    font-style: italic;
    letter-spacing: 0.4px;
    line-height: 1.5;
    max-width: 440px;
    margin: 4px 0 8px;
  }
  .empty-divider {
    width: 60%;
    height: 1px;
    margin: 6px 0 4px;
    background: linear-gradient(to right, transparent, var(--border-strong) 30%, var(--border-strong) 70%, transparent);
  }
  .empty-brand {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 3px;
    text-transform: uppercase;
    position: relative;
  }
  .empty-brand .accent { color: var(--accent); }
  /* Ember pair — two amber motes flanking the brand,
     breathing in exact phase inversion. */
  .empty-brand::before,
  .empty-brand::after {
    content: '';
    position: absolute;
    top: 50%;
    width: 3px;
    height: 3px;
    margin-top: -1.5px;
    border-radius: 50%;
    background: var(--accent-reason);
    animation: ember-glow 3.2s ease-in-out infinite;
    pointer-events: none;
  }
  .empty-brand::before { left: -18px; }
  .empty-brand::after { right: -18px; animation-delay: -1.6s; }
  @keyframes ember-glow {
    0%, 100% { opacity: 0.25; filter: blur(1.5px); box-shadow: 0 0 4px 1px var(--accent-reason-dim); }
    50%      { opacity: 0.9; filter: blur(0); box-shadow: 0 0 10px 3px var(--accent-reason-glow); }
  }
  @media (prefers-reduced-motion: reduce) {
    .empty-brand::before, .empty-brand::after { animation: none; opacity: 0.5; }
  }
  .empty-prompt {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    letter-spacing: 1.5px;
    text-transform: uppercase;
    opacity: 0.7;
  }
  .empty-warn {
    max-width: 420px;
    margin-top: 4px;
    padding: 9px 14px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    letter-spacing: 0.3px;
    color: var(--accent-reason);
    border: 1px solid color-mix(in srgb, var(--accent-reason) 45%, transparent);
    background: color-mix(in srgb, var(--accent-reason) 10%, transparent);
  }

  @media (max-width: 768px) {
    .empty-card { padding: 20px 16px; max-width: 100%; }
    .empty-avatar, .empty-avatar img, .empty-avatar-fallback { width: 80px; height: 80px; }
    .empty-avatar-fallback { font-size: 40px; }
    .empty-name { font-size: 28px; letter-spacing: 4px; }
    .empty-tagline { font-size: 13px; }
  }
</style>
