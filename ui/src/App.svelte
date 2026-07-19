<script lang="ts">
  import { onMount } from 'svelte';
  import { ui, chat } from './lib/state.svelte';
  import { connectWs } from './lib/ws';
  import { loadAgents, selectAgent } from './lib/agents';
  import { auth, checkAuth, logout } from './lib/auth.svelte';
  import { quote, startQuoteRotation } from './lib/quotes.svelte';
  import { personas } from './lib/personas.svelte';
  import AuthGate from './views/AuthGate.svelte';
  import BootScreen from './views/BootScreen.svelte';
  import { crtLoss, crtAcquire, accordionSlide } from './lib/crt';
  import AgentSelect from './views/AgentSelect.svelte';
  import Chat from './views/Chat.svelte';
  import OnboardingState from './views/OnboardingState.svelte';
  import Sessions from './views/Sessions.svelte';
  import ProfileBar from './views/ProfileBar.svelte';
  import Lightbox from './components/Lightbox.svelte';
  import DocViewer from './components/DocViewer.svelte';
  import TextViewer from './components/TextViewer.svelte';
  import ConfirmHost from './components/ConfirmHost.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import CronPanel from './rooms/cron/CronPanel.svelte'; // [room] bolt-on
  import AgentsHost from './rooms/agents/AgentsHost.svelte'; // [room] bolt-on
  import WorkspaceHost from './rooms/workspace/WorkspaceHost.svelte'; // [room] bolt-on
  import VoiceHost from './rooms/voice/VoiceHost.svelte'; // [room] bolt-on
  import LocalHost from './rooms/local/LocalHost.svelte'; // [room] bolt-on
  import ChannelSidebar from './rooms/channel/ChannelSidebar.svelte'; // [room] second sidebar (channel mode)
  import ToolsPanel from './rooms/tools/ToolsPanel.svelte'; // [room] bolt-on (systems group)
  import SystemsDeck from './views/SystemsDeck.svelte'; // [stage swap] subsystem management
  import { lsGet, lsSet } from './lib/storage';
  import SkillsPanel from './rooms/skills/SkillsPanel.svelte'; // [room] bolt-on
  import ChannelView from './rooms/channel/ChannelView.svelte'; // [room] stage swap
  import CallOverlay from './rooms/call/CallOverlay.svelte'; // [room] stage swap
  import SettingsModal from './rooms/settings/SettingsModal.svelte'; // [room] bolt-on
  import ToastHost from './rooms/activity/ToastHost.svelte'; // [room] bolt-on
  import FxLayer from './rooms/settings/FxLayer.svelte'; // [room] stage backdrop
  import { channel, openChannelView, closeChannelView, channelModeSaved } from './rooms/channel/channel.svelte';
  import { call } from './rooms/call/call.svelte';
  import { agentModals } from './rooms/agents/agents.svelte'; // [room] sidebar triggers
  import { settings } from './rooms/settings/settings.svelte';
  import { local } from './rooms/local/local.svelte'; // [room] sidebar trigger (models modal)
  import { setOpen as setMusicOpen } from './rooms/music/music.svelte';

  let error = $state<string | null>(null);
  const currentAgent = $derived(ui.agents.find((a) => a.id === ui.currentAgentId) ?? null);

  // // systems — the accordion grouping the agent's subsystem panels
  // (tools / skills / cron). Collapsed it's one row; expanded,
  // each member is its own accordion to drill into. Persisted.
  let systemsOpen = $state(lsGet('mantle-systems-open') === 'true');
  function toggleSystems(): void {
    systemsOpen = !systemsOpen;
    lsSet('mantle-systems-open', String(systemsOpen));
  }

  // The systems deck and the channel view share the stage — mutually
  // exclusive; whichever opens evicts the other (both settle in one flush).
  $effect(() => {
    if (channel.open) ui.deckTab = null;
  });
  $effect(() => {
    if (ui.deckTab) closeChannelView();
  });

  // The systems deck remembers its open tab across reloads (mirrors channel
  // mode) so a refresh while assisting lands you back on the same page with the
  // dock + its persisted conversation, not in chat. Gated on the boot restore
  // so the initial null doesn't erase the saved tab before it's read.
  const LS_DECK_TAB = 'mantle-deck-tab';
  let deckTabRestored = false;
  $effect(() => {
    const t = ui.deckTab;
    if (!deckTabRestored) return;
    lsSet(LS_DECK_TAB, t ?? '');
  });

  // Boot moment — once per tab session, never under reduced-motion. The
  // sessionStorage flag means dev reloads skip it after the first.
  let booting = $state(
    typeof sessionStorage !== 'undefined' && !sessionStorage.getItem('mantle-booted')
    && !(typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches),
  );
  function bootDone(): void {
    booting = false;
    try { sessionStorage.setItem('mantle-booted', '1'); } catch { /* best-effort */ }
  }

  // Auth is the boot chokepoint: nothing connects or fetches until the
  // session cookie checks out (the gate renders instead of the shell, so no
  // room mounts fire 401ing requests behind the wall).
  onMount(() => { void checkAuth(); });

  let booted = false;
  $effect(() => {
    if (auth.stage !== 'ready' || booted) return;
    booted = true;
    connectWs();
    loadAgents(true)
      .then(() => {
        // Reload lands where you were — channel mode restores itself (the store
        // remembers the last channel too), else the systems deck reopens to its
        // last tab. Mutually exclusive, so only one wins.
        if (channelModeSaved()) void openChannelView();
        else {
          const t = lsGet(LS_DECK_TAB);
          if (t === 'skills' || t === 'tools' || t === 'cron') ui.deckTab = t;
        }
        deckTabRestored = true;
      })
      .catch((e: unknown) => {
        error = e instanceof Error ? e.message : String(e);
      });
  });

  // Tagline quote rotation — re-picks immediately on agent profile or persona
  // change (read here so the effect restarts), then every 60s.
  $effect(() => {
    void ui.profile;
    void personas.current;
    return startQuoteRotation();
  });

  // ── Mobile chrome ──────────────────────────────────────────────────────────
  // ≤768px the sidebar is an off-canvas drawer (hamburger opens; backdrop /
  // close button / Esc / navigation closes). Desktop CSS ignores the flag.
  let sidebarOpen = $state(false);
  const isMobile = (): boolean => window.innerWidth <= 768;

  function onShellKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && sidebarOpen) sidebarOpen = false;
  }

  // Navigating (session select / new session / agent switch / channel) lands
  // you on the conversation: close the drawer, and on mobile also collapse
  // the music overlay (desktop's persistent open state is untouched).
  // CAUTION: don't READ music.open here — it would become a dependency and
  // the effect would re-run on open, closing the player the moment the spine
  // is tapped (found live). setMusicOpen(false) is a write, not a read.
  $effect(() => {
    void chat.sessionId;
    void ui.currentAgentId;
    void channel.open;
    sidebarOpen = false;
    if (isMobile()) setMusicOpen(false);
  });
</script>

<svelte:window onkeydown={onShellKey} />

{#if booting}
  <BootScreen ondone={bootDone} />
{/if}

{#if auth.stage === 'checking'}
  <!-- pre-auth blank: avoid flashing either the gate or the shell -->
{:else if auth.stage !== 'ready'}
  <AuthGate />
{:else}
<div class="shell" class:channel-mode={channel.open}>
  <button class="mobile-menu-btn" type="button" aria-label="Open menu" onclick={() => (sidebarOpen = true)}>
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">
      <line x1="2" y1="4" x2="16" y2="4" />
      <line x1="2" y1="9" x2="16" y2="9" />
      <line x1="2" y1="14" x2="16" y2="14" />
    </svg>
  </button>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="sidebar-backdrop" class:active={sidebarOpen} onclick={() => (sidebarOpen = false)}></div>
  <aside class="sidebar" class:mobile-open={sidebarOpen}>
    <div class="brand">
      <span class="brand-name">rev://<span class="brand-accent">MANTLE</span></span>
      <button class="mobile-sidebar-close" type="button" aria-label="Close menu" onclick={() => (sidebarOpen = false)}>×</button>
    </div>
    <div class="ws" class:on={ui.wsConnected}>
      <span class="dot"></span>
      <span class="ws-text">{ui.wsConnected ? 'link:online' : 'link:connecting'}</span>
      {#if ui.agents.length > 0}<span class="ws-count">{ui.agents.length} agent{ui.agents.length === 1 ? '' : 's'}</span>{/if}
    </div>

    <!-- Surface switch: 1:1 chat vs the channel hangouts. Channel mode brings
         its own sidebar (ChannelSidebar) in beside this one. -->
    <div class="mode-tabs">
      <button
        class="mode-tab"
        class:active={!channel.open}
        type="button"
        aria-pressed={!channel.open}
        onclick={() => { if (channel.open) closeChannelView(); ui.deckTab = null; }}
      ><span class="mt-glyph">◇</span> chat</button>
      <button
        class="mode-tab"
        class:active={channel.open}
        type="button"
        aria-pressed={channel.open}
        onclick={() => { if (!channel.open) void openChannelView(); }}
      ><span class="mt-glyph">⌗</span> channels</button>
    </div>

    <div class="side-sect">
      <span class="side-sect-label">// agents</span>
      <button class="side-sect-btn" type="button" title="New agent" aria-label="New agent" onclick={() => (agentModals.create = true)}>+</button>
    </div>
    <div class="agents">
      <AgentSelect
        agents={ui.agents}
        active={currentAgent}
        onSelect={(id) => void selectAgent(id)}
        onEdit={(id) => (agentModals.editId = id)}
      />
    </div>

    {#if currentAgent}
      <div class="systems">
        <button class="side-toggle systems-head" type="button" title="Agent systems - tools, skills, cron" onclick={toggleSystems}>
          <span class="arrow" class:open={systemsOpen}>▸</span>
          <span class="label">// systems</span>
        </button>
        {#if systemsOpen}
          <div class="systems-body" transition:accordionSlide>
            <ToolsPanel />
            <SkillsPanel />
            <CronPanel />
          </div>
        {/if}
      </div>
      <Sessions />
    {/if}
    <div class="side-foot">
      <button class="foot-btn" type="button" title="Settings" onclick={() => (settings.open = true)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="8" cy="8" r="2.5" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41" />
        </svg>
      </button>
      <button class="foot-btn" type="button" title="Local models - runtime, settings, HF browser" onclick={() => (local.open = true)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <rect x="4" y="4" width="8" height="8" />
          <rect x="6.6" y="6.6" width="2.8" height="2.8" />
          <path d="M6 1v3M10 1v3M6 12v3M10 12v3M1 6h3M1 10h3M12 6h3M12 10h3" />
        </svg>
      </button>
      {#if !auth.disabled}
        <button class="foot-btn" type="button" title="Sign out" onclick={() => void logout()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
            <path d="M10.5 11l3-3-3-3" />
            <path d="M13.5 8H6" />
          </svg>
        </button>
      {/if}
      <span class="foot-stamp">rev://mantle</span>
    </div>
  </aside>

  {#if channel.open}
    <ChannelSidebar />
  {/if}

  <main class="stage">
    <FxLayer />
    {#if chat.isStreaming}
      <div class="stream-beam" aria-hidden="true"></div>
    {/if}
    <!-- View swap rides the CRT transitions (signal loss → reacquire): the
         channel and the 1:1 chat are stacked in one grid cell so the
         collapsing view and the expanding one never push each other. -->
    <div class="stage-content">
      {#if error}
        <div class="error">Failed to load: {error}</div>
      {:else if ui.deckTab}
        <div class="stage-view" in:crtAcquire|global out:crtLoss|global>
          <SystemsDeck />
        </div>
      {:else if channel.open}
        <div class="stage-view" in:crtAcquire|global out:crtLoss|global>
          <ChannelView />
        </div>
      {:else if currentAgent}
        <div class="stage-view" in:crtAcquire|global out:crtLoss|global>
          <ProfileBar name={ui.profile?.name ?? currentAgent.name} tagline={quote.text || (ui.profile?.tagline ?? '')} />
          <div class="chat-wrap">
            {#if call.active}
              <CallOverlay />
            {:else}
              <Chat />
            {/if}
          </div>
        </div>
      {:else if ui.configLoaded}
        <div class="stage-view" in:crtAcquire|global out:crtLoss|global>
          <OnboardingState
            onConnectProvider={() => { settings.tab = 'providers'; settings.open = true; }}
            onCreateAgent={() => (agentModals.create = true)}
          />
        </div>
      {:else}
        <div class="placeholder">Loading…</div>
      {/if}
    </div>
  </main>
</div>

<Lightbox />
<DocViewer />
<TextViewer />
<ConfirmHost />
<SettingsModal />
<AgentsHost />
<WorkspaceHost />
<VoiceHost />
<LocalHost />
<ToastHost />
<CommandPalette />
{/if}

<style>
  .shell { display: grid; grid-template-columns: 300px 1fr; height: 100vh; position: relative; z-index: 1; }
  /* Channel mode docks the channel sidebar as a second column (Discord's
     channel list); the CRT stage swap masks the instant track change. */
  .shell.channel-mode { grid-template-columns: 300px 264px 1fr; }

  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 14px;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border-strong);
    min-height: 0;
    position: relative;
  }
  /* Neon edge — a vertical accent seam on the sidebar's right edge. */
  .sidebar::after {
    content: '';
    position: absolute;
    top: 0;
    right: -1px;
    bottom: 0;
    width: 1px;
    background: linear-gradient(to bottom, var(--accent) 0%, transparent 18%, transparent 82%, var(--accent-edge) 100%);
    pointer-events: none;
  }

  /* Brand — same chroma treatment as the agent name, but static (the agent
     name carries the motion; the brand is a permanent fixture). */
  .brand {
    display: flex;
    align-items: baseline;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 18px;
    letter-spacing: 1px;
    flex-shrink: 0;
  }
  .brand-name {
    text-shadow:
      -1px 0 0 rgba(255, 45, 124, 0.35),
      1px 0 0 rgba(0, 200, 255, 0.35);
  }
  .brand-accent { color: var(--accent); text-shadow: 0 0 14px var(--accent-glow); }

  /* Link status — terminal telemetry line. */
  .ws {
    display: flex;
    align-items: center;
    gap: 7px;
    font-family: var(--font-terminal);
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    flex-shrink: 0;
  }
  .ws .dot { width: 6px; height: 6px; background: var(--text-muted); flex-shrink: 0; }
  .ws.on .dot {
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent);
    animation: ws-pulse 2.4s ease-in-out infinite;
  }
  .ws.on .ws-text { color: var(--accent); }
  .ws-count { margin-left: auto; opacity: 0.8; }
  @keyframes ws-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ws.on .dot { animation: none; }
  }

  /* Mode tabs — the chat ↔ channels surface switch. */
  .mode-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; flex-shrink: 0; }
  .mode-tab {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 10px 0;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: color 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s;
  }
  .mode-tab:hover { color: var(--text-secondary); border-color: var(--border-strong); }
  .mode-tab.active {
    color: var(--accent);
    border-color: var(--accent-edge);
    background: var(--accent-dim);
    box-shadow: inset 0 0 14px var(--accent-faint), 0 0 10px var(--accent-faint);
    text-shadow: 0 0 8px var(--accent-glow);
  }
  .mt-glyph { font-size: 13px; }

  /* ── // systems — the subsystem accordion group ───────────────────────── */
  .systems { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; }
  /* Group header outranks the child `// section` rows: a framed, full-width
     bar (the children keep the quiet underlined grammar). */
  .systems .systems-head {
    width: 100%;
    padding: 9px 11px;
    border: 1px solid var(--border);
    background: linear-gradient(180deg, var(--accent-faint), transparent);
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  }
  .systems .systems-head:hover { border-color: var(--accent-edge); }
  /* Children indent behind a rail so the hierarchy reads at a glance. */
  .systems-body {
    display: flex;
    flex-direction: column;
    gap: 13px;
    margin: 10px 0 0 5px;
    padding: 2px 0 2px 11px;
    border-left: 1px solid var(--border-strong);
    overflow-y: auto;
    min-height: 0;
    max-height: 56vh;
  }
  /* Sessions flexes to fill; don't let an expanded systems group crush it. */
  .sidebar > :global(.sessions) { min-height: 130px; }

  .agents { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }

  /* footer row pinned to the sidebar's bottom — global actions (sign out;
     the settings gear joins it with the settings room) */
  .side-foot { margin-top: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; padding-top: 10px; }
  .foot-btn {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    cursor: pointer;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px);
    transition: color 0.15s, border-color 0.15s;
  }
  .foot-btn:hover { color: var(--accent); border-color: var(--accent-edge); }
  .foot-stamp {
    margin-left: auto;
    font-family: var(--font-terminal);
    font-size: 9px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--text-muted);
    opacity: 0.45;
  }

  /* position:relative anchors the fx layer (z 0); content sits above it.
     CAUTION: these rules create stacking contexts on the stage children — the
     profile bar must outrank the chat row (old UI: z:5) or its popovers get
     trapped under the DOM-later .chat-wrap (found live: the backend picker
     rendered behind the messages). */
  /* min-width:0 — a grid item's auto minimum would let wide message content
     (code blocks, tables) push the stage past the viewport on phones. */
  .stage { display: flex; flex-direction: column; height: 100vh; min-height: 0; min-width: 0; position: relative; }
  .stage > :global(:not(.fx-layer)) { position: relative; z-index: 1; }
  .stage :global(header.profile-bar) { z-index: 5; }
  /* The view stack — both sides of a CRT swap occupy the same grid cell so
     the outgoing collapse never displaces the incoming view. */
  .stage-content { flex: 1; min-height: 0; display: grid; }
  .stage-content > :global(*) { grid-area: 1 / 1; min-height: 0; min-width: 0; }
  .stage-view { display: flex; flex-direction: column; min-height: 0; min-width: 0; position: relative; z-index: 1; }
  /* The conversation (or call panel). The music rail now lives INSIDE
     Chat's row (between profile bar and composer), not out here. */
  .chat-wrap { flex: 1; min-height: 0; display: flex; }
  .chat-wrap > :global(*) { flex: 1; min-width: 0; }

  /* Transmission beam — a thin sweep across the stage top while a turn
     streams. Transform-only animation (compositor-cheap). */
  .stream-beam {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    z-index: 6;
    overflow: hidden;
    pointer-events: none;
  }
  .stream-beam::after {
    content: '';
    position: absolute;
    top: 0;
    left: -40%;
    width: 40%;
    height: 100%;
    background: linear-gradient(to right, transparent, var(--accent), transparent);
    animation: beam-sweep 1.6s linear infinite;
  }
  @keyframes beam-sweep {
    to { transform: translateX(350%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .stream-beam::after { animation: none; left: 0; width: 100%; opacity: 0.5; }
  }

  .placeholder { margin: auto; color: var(--text-muted); font-size: 14px; }
  .error { margin: 40px; color: var(--error); font-size: 14px; }

  /* ── Mobile chrome (≤768px) — sidebar becomes an off-canvas drawer ─────── */
  .mobile-menu-btn,
  .mobile-sidebar-close,
  .sidebar-backdrop { display: none; }

  @media (max-width: 768px) {
    /* both selectors — .shell.channel-mode outranks a bare .shell here */
    .shell, .shell.channel-mode { grid-template-columns: 1fr; }

    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      width: min(300px, 86vw);
      z-index: 50;
      transform: translateX(-100%);
      transition: transform 0.3s ease;
      border-right: 1px solid var(--border-strong);
      padding-bottom: calc(16px + env(safe-area-inset-bottom));
      box-shadow: 8px 0 32px rgba(0, 0, 0, 0.5);
    }
    .sidebar.mobile-open { transform: translateX(0); }

    .sidebar-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(10, 10, 15, 0.7);
      z-index: 49;
    }
    .sidebar-backdrop:not(.active) { display: none; }
    .sidebar-backdrop.active { display: block; }

    .mobile-sidebar-close {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-left: auto;
      width: 28px;
      height: 28px;
      background: transparent;
      border: 1px solid var(--border-strong);
      color: var(--text-secondary);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }
    .mobile-sidebar-close:active { color: var(--accent); border-color: var(--accent); }

    .mobile-menu-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      position: fixed;
      top: 10px;
      left: 10px;
      z-index: 10;
      width: 36px;
      height: 36px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-strong);
      color: var(--text-secondary);
      cursor: pointer;
      clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
      transition: color 0.2s, border-color 0.2s, background 0.2s;
    }
    .mobile-menu-btn:active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }

    .stage { height: 100dvh; }
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar { transition: none; }
  }
</style>
