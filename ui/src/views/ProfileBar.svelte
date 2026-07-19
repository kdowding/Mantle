<script lang="ts">
  // Profile bar — the agent's HUD. Identity on the left (avatar + chroma name
  // + tagline), instrument clusters on the right in two tiers: an ambient row
  // (persona / local-model state — conversation state, not configuration)
  // above two framed hud-panels (INFERENCE / VOICE). The context gauge moved
  // to the ContextBar above the composer.
  import { ui, chat, prefs, getFeature } from '../lib/state.svelte';
  import { cycleThinking, toggleReasoning, toggleMemory, effortLevels, fastModeAvailable, toggleFastMode, modelMeta } from '../lib/inference';
  import { personas, selectPersona } from '../lib/personas.svelte';
  import { openWorkspace } from '../rooms/workspace/workspace.svelte'; // [room] trigger
  import VoiceControls from '../rooms/voice/VoiceControls.svelte'; // [room] bolt-on
  import LocalStatusChip from '../rooms/local/LocalStatusChip.svelte'; // [room] bolt-on
  import CallControls from '../rooms/call/CallControls.svelte'; // [room] bolt-on
  import BackendPicker from './BackendPicker.svelte';
  import Popover from '../components/Popover.svelte';
  import { cipher } from '../lib/cipher';

  let { name, tagline }: { name: string; tagline: string } = $props();

  let personaOpen = $state(false);
  // ≤768px the whole control cluster collapses behind a summary chip
  // (ported from the old .mobile-controls-toggle); desktop CSS ignores it.
  let mobileControlsOpen = $state(false);
  let imgFailed = $state(false);

  const avatarUrl = $derived(ui.profile?.avatarUrl ?? null);
  const short = (s: string): string => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
  const mobileSummary = $derived(prefs.model ? modelMeta(prefs.model).name : '-');
  // The effort chip cycles the current model's supported levels; disable it when
  // a model exposes no reasoning knob (only "off", e.g. grok-build).
  const effortDisabled = $derived(effortLevels().length <= 1);
  // Fast mode is codex-only and per-model — the chip HIDES (not disables) off
  // that set so the inference row doesn't carry a dead control for other
  // backends. The stored preference survives and re-applies when eligible.
  const fastAvailable = $derived(fastModeAvailable());
  // The memory pack can't inject when Englyph is off/unreachable — gate the chip
  // on the live readiness model (undefined while it loads ⇒ left enabled).
  const memFeature = $derived(getFeature('memory'));
  const memDisabled = $derived(!!memFeature && !memFeature.ready);
  // Lean install: with voice AND realtime both off there is nothing the voice
  // panel can do — hide the whole panel rather than show two dead chips.
  const voicePanelOn = $derived(
    (getFeature('voice')?.enabled ?? false) || (getFeature('realtime')?.enabled ?? false),
  );

  function pickPersona(key: string): void {
    selectPersona(key);
    personaOpen = false;
  }

  // Navigation lands you on the conversation — fold the mobile dropdown away
  // (it used to stay open across a session switch, covering the new chat).
  $effect(() => {
    void chat.sessionId;
    void ui.currentAgentId;
    mobileControlsOpen = false;
  });
</script>

<header class="profile-bar">
  <div class="pb-avatar">
    {#if avatarUrl && !imgFailed}
      <img src={avatarUrl} alt="" onerror={() => (imgFailed = true)} />
    {:else}
      <div class="pb-avatar-fallback">{(name || '?').charAt(0).toUpperCase()}</div>
    {/if}
    <span class="pb-scan" aria-hidden="true"></span>
  </div>
  <div class="info">
    <!-- cipher: the name scramble-decodes on every agent retune; aria-label
         gives AT the stable name instead of the glyph noise -->
    <!-- svelte-ignore a11y_missing_content — the action fills it at mount -->
    <h1 class="pb-name" aria-label={name} use:cipher={name}></h1>
    {#if tagline}<p class="pb-tagline">{tagline}</p>{/if}
  </div>

  <button
    class="mobile-controls-toggle"
    type="button"
    aria-expanded={mobileControlsOpen}
    title="Session controls"
    onclick={() => (mobileControlsOpen = !mobileControlsOpen)}
  >
    <span class="mc-summary">{mobileSummary}</span>
    <span class="mc-chev" class:open={mobileControlsOpen}>▼</span>
  </button>

  <div class="controls" class:mobile-open={mobileControlsOpen}>
    <div class="pb-top">
      {#if personas.available}
        <!-- Purple is intentional + fixed: personas are ambient conversation
             state, visually distinct from the agent-accent inference chrome. -->
        <Popover bind:open={personaOpen} width={280}>
          {#snippet trigger({ toggle, open })}
            <button class="chip persona" class:open type="button" onclick={toggle} title="Active persona">
              ◈ {personas.current ?? 'default'} <span class="chev" class:open>▾</span>
            </button>
          {/snippet}
          <div class="p-list">
            {#each Object.entries(personas.profiles) as [key, profile] (key)}
              <button class="p-row" class:active={key === personas.current} type="button" onclick={() => pickPersona(key)}>
                <span class="p-name">{key}</span>
                {#if profile.description}<span class="p-desc">{short(profile.description)}</span>{/if}
              </button>
            {/each}
          </div>
        </Popover>
      {/if}
      <LocalStatusChip />
    </div>

    <div class="pb-panels">
      <div class="hud-panel pb-panel">
        <span class="hud-tag">inference</span>
        <BackendPicker />
        <div class="pb-chiprow">
          <button class="chip" class:active={prefs.thinkingLevel !== 'off'} type="button" disabled={effortDisabled} onclick={cycleThinking} title="Reasoning effort - cycles the levels this model supports; remembered per model">
            ◆ <span class="chip-lbl">effort</span> <span class="chip-val">{prefs.thinkingLevel === 'medium' ? 'med' : prefs.thinkingLevel}</span>
          </button>
          {#if fastAvailable}
            <button class="chip" class:active={prefs.fastMode} type="button" onclick={toggleFastMode} title="Fast mode - ~1.5x speed at a higher credit burn (codex priority tier)">
              ▸ <span class="chip-lbl">fast</span> <span class="chip-val">{prefs.fastMode ? 'on' : 'off'}</span>
            </button>
          {/if}
          <button class="chip" class:active={prefs.showReasoning} type="button" onclick={toggleReasoning} title="Show reasoning blocks in the transcript (display only - effort controls whether the model thinks)">
            ◉ <span class="chip-lbl">reasoning</span> <span class="chip-val">{prefs.showReasoning ? 'on' : 'off'}</span>
          </button>
          <button class="chip" class:active={prefs.memoryPack && !memDisabled} type="button" disabled={memDisabled} onclick={toggleMemory} title={memDisabled ? (memFeature?.setupHint ?? memFeature?.detail ?? 'Memory is unavailable') : 'Inject the pre-inference Englyph memory pack'}>
            ⊙ <span class="chip-lbl">memory</span> <span class="chip-val">{memDisabled ? 'off' : (prefs.memoryPack ? 'on' : 'off')}</span>
          </button>
          <button class="chip" type="button" onclick={openWorkspace} title="Workspace files + system prompt">
            ▤ <span class="chip-lbl">files</span>
          </button>
        </div>
      </div>
      {#if voicePanelOn}
        <div class="hud-panel pb-panel">
          <span class="hud-tag">voice</span>
          <VoiceControls />
          <CallControls />
        </div>
      {/if}
    </div>
  </div>
</header>

<style>
  .profile-bar {
    /* Opaque bar color — the hud-tags paint this behind themselves to "cut"
       the panel borders, so it must be a flat color, not texture. */
    --pb-bg: #0c0c13;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 24px;
    background: var(--pb-bg);
    --hud-tag-bg: var(--pb-bg);
    border-bottom: 1px solid var(--border-strong);
    flex-shrink: 0;
    position: relative;
  }
  /* Accent seam under the bar — fades out to the right. */
  .profile-bar::after {
    content: '';
    position: absolute;
    left: 0;
    bottom: -1px;
    height: 1px;
    width: 38%;
    background: linear-gradient(to right, var(--accent), transparent);
    pointer-events: none;
  }

  .pb-avatar { flex-shrink: 0; width: 52px; height: 52px; position: relative; overflow: hidden; }
  /* Rare scan-line transit — a 2px accent line crosses the
     avatar once every 55s; invisible 99% of the cycle. */
  .pb-scan {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 2px;
    background: var(--agent-accent);
    box-shadow: 0 0 8px var(--agent-accent-glow);
    opacity: 0;
    animation: pb-scanline 55s linear infinite;
    pointer-events: none;
  }
  @keyframes pb-scanline {
    0%, 98.6% { transform: translateY(-3px); opacity: 0; }
    98.7%     { transform: translateY(-3px); opacity: 0.85; }
    100%      { transform: translateY(54px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pb-scan { display: none; }
  }
  .pb-avatar img,
  .pb-avatar-fallback {
    width: 52px;
    height: 52px;
    object-fit: cover;
    display: block;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    border: 1.5px solid var(--agent-accent);
    box-shadow: 0 0 14px var(--agent-accent-dim);
  }
  .pb-avatar-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 24px;
    color: var(--agent-accent);
    background: var(--agent-accent-dim);
  }

  /* Floor the identity column — the control cluster wraps to more rows
     instead of crushing the name/tagline into a sliver. */
  .info { min-width: 180px; flex: 1; }

  /* Chromatic-aberration name — pink/cyan split on the agent glow, with the
     brief two-frame glitch every 9s (the lobby card runs the same signature). */
  .pb-name {
    margin: 0;
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 700;
    letter-spacing: 3px;
    line-height: 1.1;
    text-transform: uppercase;
    color: var(--text-primary);
    display: inline-block;
    position: relative;
    padding-bottom: 3px;
    text-shadow:
      -1px 0 0 rgba(255, 45, 124, 0.45),
      1px 0 0 rgba(0, 200, 255, 0.45),
      0 0 18px var(--agent-accent-glow);
    animation: pb-name-glitch 9s infinite;
  }
  /* Angular accent slash under the name. */
  .pb-name::after {
    content: '';
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    width: 34px;
    background: var(--agent-accent);
    transform: skewX(-30deg);
    box-shadow: 0 0 8px var(--agent-accent-glow);
  }
  @keyframes pb-name-glitch {
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
    .pb-name { animation: none; }
  }

  .pb-tagline {
    margin: 3px 0 0;
    color: var(--text-muted);
    font-size: 13px;
    font-style: italic;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ── Right side: ambient row above the framed clusters ─────────────────── */
  .controls {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 9px;
    flex-shrink: 1;
    min-width: 0;
  }
  .pb-top { display: flex; align-items: center; gap: 10px; min-height: 22px; }
  .pb-panels { display: flex; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }

  .pb-panel {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 8px 6px;
  }
  .pb-chiprow { display: flex; align-items: center; gap: 2px; }

  /* Chips inside a panel drop their frames — the panel does the containment.
     :global reaches the room clusters (voice/call) without forking them. */
  .pb-panel :global(.chip) {
    background: transparent;
    border-color: transparent;
  }
  .pb-panel :global(.chip:hover:not(:disabled)) {
    background: var(--accent-faint);
    border-color: transparent;
    color: var(--text-primary);
  }
  .pb-panel :global(.chip.active) {
    background: var(--accent-dim);
    border-color: transparent;
    color: var(--accent);
  }
  .pb-panel :global(.bp-trigger) {
    background: transparent;
    border-color: transparent;
  }
  .pb-panel :global(.bp-trigger:hover) { background: var(--accent-faint); }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 9px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .chip:hover:not(:disabled) { border-color: var(--accent); color: var(--text-secondary); }
  .chip:disabled { opacity: 0.4; cursor: default; }
  .chip.active { border-color: var(--accent); color: var(--accent); background: var(--accent-faint); }

  /* Toggle chips read as `LABEL value` HUD pairs — the label names the knob
     (a bare glyph + "on" said nothing), the value is the dimmer live state. */
  .chip-val { opacity: 0.72; }

  .chip.persona { border-color: rgba(184, 61, 255, 0.3); color: var(--accent-purple); background: transparent; }
  .chip.persona:hover, .chip.persona.open {
    border-color: var(--accent-purple);
    background: var(--accent-purple-dim);
    color: var(--accent-purple);
  }
  .chev { font-size: 8px; transition: transform 0.15s; }
  .chev.open { transform: rotate(180deg); }

  .p-list { display: flex; flex-direction: column; gap: 2px; }
  .p-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 7px 9px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .p-row:hover { background: var(--accent-purple-dim); }
  .p-row.active { border-left-color: var(--accent-purple); background: var(--accent-purple-dim); }
  .p-name {
    font-family: var(--font-display);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-primary);
  }
  .p-row.active .p-name { color: var(--accent-purple); }
  .p-desc { font-size: 10.5px; color: var(--text-muted); }

  /* ── Mobile (≤768px) — compact bar, controls behind a summary chip ────── */
  .mobile-controls-toggle { display: none; }

  @media (max-width: 768px) {
    .profile-bar {
      position: relative;
      align-items: center;
      gap: 8px;
      min-height: 56px;
      padding: 7px 10px 7px 54px; /* clear the fixed hamburger button */
    }
    .pb-avatar { display: none; } /* identity lives in the lobby card on phones */
    .info { min-width: 0; }
    .pb-name { font-size: 16px; letter-spacing: 2px; animation: none; padding-bottom: 2px; }
    .pb-name::after { width: 22px; }
    .pb-tagline { display: none; }

    .mobile-controls-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      max-width: 58%;
      padding: 7px 10px;
      background: var(--bg-input);
      border: 1px solid var(--border-strong);
      color: var(--text-secondary);
      font-family: var(--font-display);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      cursor: pointer;
    }
    .mc-summary { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mc-chev { font-size: 8px; transition: transform 0.15s; }
    .mc-chev.open { transform: rotate(180deg); }

    /* The cluster becomes a dropdown sheet anchored below the bar; the
       hud-panels stack full-width with their labels (+ chip words) visible. */
    .controls { display: none; }
    .controls.mobile-open {
      display: flex;
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      z-index: 20;
      align-items: stretch;
      gap: 14px;
      padding: 14px 10px 12px;
      background: var(--bg-secondary);
      --hud-tag-bg: var(--bg-secondary);
      border-bottom: 1px solid var(--border-strong);
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.45);
      max-height: calc(100dvh - 70px);
      overflow-y: auto;
    }
    .controls.mobile-open .pb-top { flex-wrap: wrap; }
    .controls.mobile-open .pb-panels { flex-direction: column; gap: 16px; }
    .controls.mobile-open .pb-panel { flex-wrap: wrap; padding: 12px 10px 10px; }
    .controls.mobile-open .pb-chiprow { flex-wrap: wrap; gap: 4px; }
    .chip { padding: 8px 11px; } /* touch targets */
  }
</style>
