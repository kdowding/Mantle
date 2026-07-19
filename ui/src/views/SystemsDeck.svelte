<script lang="ts">
  // The systems deck — the full-page management surface for the current
  // agent's subsystems, one stage view with tabs (the channel-view pattern:
  // same stage slot, same CRT swap). The sidebar's // systems panels stay the
  // glance/quick-action tier; anything needing more than one click drills in
  // here. Future tabs (providers/keys, MCP management) slot into TABS.
  import { ui } from '../lib/state.svelte';
  import SkillsDeck from '../rooms/skills/SkillsDeck.svelte'; // [room] tab content
  import ToolsDeck from '../rooms/tools/ToolsDeck.svelte'; // [room] tab content
  import CronDeck from '../rooms/cron/CronDeck.svelte'; // [room] tab content
  import PersonalityDeck from '../rooms/personality/PersonalityDeck.svelte'; // [room] tab content
  import AssistDock from '../rooms/assist/AssistDock.svelte'; // [room] embedded helper
  import { assist } from '../rooms/assist/assist.svelte';
  import { deckTabIn, deckTabOut } from '../lib/crt';
  import { anyPopoverOpen } from '../lib/overlays.svelte';

  const TABS = ['skills', 'tools', 'cron', 'personality'] as const;
  type DeckTab = (typeof TABS)[number];

  const agentName = $derived(ui.agents.find((a) => a.id === ui.currentAgentId)?.name ?? '');

  // Tab swap direction (+1 toward a later tab, -1 earlier) — the lateral CRT
  // re-tune follows the click. Set synchronously before deckTab so the {#key}
  // block's in/out transitions read the new direction in the same flush.
  let dir = $state(1);
  function selectTab(tab: DeckTab): void {
    const cur = ui.deckTab ? TABS.indexOf(ui.deckTab) : -1;
    dir = TABS.indexOf(tab) >= cur ? 1 : -1;
    ui.deckTab = tab;
  }

  // Sliding active-tab marker — a HUD selector line that glides between tabs
  // (CSS transition on transform/width) instead of the highlight teleporting.
  let tabEls = $state<Record<string, HTMLButtonElement | undefined>>({});
  let mk = $state({ left: 0, width: 0 });
  function measure(): void {
    const el = ui.deckTab ? tabEls[ui.deckTab] : undefined;
    if (el) mk = { left: el.offsetLeft, width: el.offsetWidth };
  }
  $effect(() => {
    void ui.deckTab; void ui.currentAgentId; // re-measure on tab/agent change
    measure();
  });

  function onKey(e: KeyboardEvent): void {
    // Esc closes the deck — but never from inside a field (the skill editor's
    // unsaved buffer would silently vanish; fields handle their own Esc), and
    // never when a dropdown is open (it owns Esc first — closes itself, then a
    // second Esc closes the deck).
    if (e.key !== 'Escape') return;
    if (anyPopoverOpen()) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    ui.deckTab = null;
  }
</script>

<svelte:window onkeydown={onKey} onresize={measure} />

<div class="deck">
  <header class="deck-bar">
    <h1 class="deck-title">// systems<span class="deck-agent"> · {agentName}</span></h1>
    <nav class="deck-tabs">
      {#each TABS as tab (tab)}
        <button class="deck-tab" class:active={ui.deckTab === tab} type="button" bind:this={tabEls[tab]} onclick={() => selectTab(tab)}>
          {tab}
        </button>
      {/each}
      <span class="deck-tab-marker" style="transform: translateX({mk.left}px); width: {mk.width}px"></span>
    </nav>
    <button
      class="deck-assist"
      class:active={assist.open}
      type="button"
      title="Chat with the agent about what's open - staged edits, accept/discard"
      onclick={() => (assist.open = !assist.open)}
    >✦ assist</button>
    <button class="deck-close" type="button" title="Back to chat (Esc)" onclick={() => (ui.deckTab = null)}>×</button>
  </header>

  <div class="deck-body">
    <div class="deck-main">
      {#key ui.deckTab}
        <div class="deck-pane" in:deckTabIn={{ dir }} out:deckTabOut={{ dir }}>
          {#if ui.deckTab === 'skills'}
            <SkillsDeck />
          {:else if ui.deckTab === 'tools'}
            <ToolsDeck />
          {:else if ui.deckTab === 'cron'}
            <CronDeck />
          {:else if ui.deckTab === 'personality'}
            <PersonalityDeck />
          {/if}
        </div>
      {/key}
    </div>
    {#if assist.open}
      <AssistDock />
    {/if}
  </div>
</div>

<style>
  .deck {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .deck-bar {
    display: flex;
    align-items: center;
    gap: 22px;
    padding: 12px 22px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    min-height: 54px;
  }
  .deck-title {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 17px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--text-primary);
    text-shadow: 1px 0 var(--accent-pink), -1px 0 var(--accent);
    white-space: nowrap;
  }
  .deck-agent { color: var(--accent); text-shadow: none; }

  .deck-tabs { display: flex; gap: 7px; flex: 1; min-width: 0; position: relative; }
  /* HUD selector — glides between the active tabs instead of teleporting. */
  .deck-tab-marker {
    position: absolute;
    bottom: -2px;
    left: 0;
    height: 2px;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-glow), 0 0 2px var(--accent);
    pointer-events: none;
    transition: transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1), width 0.28s cubic-bezier(0.22, 0.61, 0.36, 1);
  }
  @media (prefers-reduced-motion: reduce) { .deck-tab-marker { transition: none; } }
  .deck-tab {
    padding: 7px 18px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .deck-tab:hover { color: var(--text-secondary); border-color: var(--border-strong); }
  .deck-tab.active {
    color: var(--accent);
    border-color: var(--accent-edge);
    background: var(--accent-dim);
    text-shadow: 0 0 8px var(--accent-glow);
  }

  .deck-close {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: color 0.15s, border-color 0.15s;
  }
  .deck-close:hover { color: var(--accent-pink); border-color: var(--accent-pink); }

  .deck-assist {
    flex-shrink: 0;
    padding: 7px 16px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .deck-assist:hover { color: var(--text-secondary); border-color: var(--border-strong); }
  .deck-assist.active {
    color: var(--accent);
    border-color: var(--accent-edge);
    background: var(--accent-dim);
    text-shadow: 0 0 8px var(--accent-glow);
  }

  .deck-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: row;
    padding: 18px 22px 20px;
    gap: 16px;
  }
  /* Grid (not flex) so a {#key} swap stacks the outgoing + incoming panes in
     one cell — the lateral re-tune slides them over each other, never shoving. */
  .deck-main { flex: 1; min-width: 0; min-height: 0; display: grid; }
  .deck-pane { grid-area: 1 / 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

  @media (max-width: 768px) {
    .deck-bar { gap: 10px; padding: 10px 12px 10px 54px; /* clear the hamburger */ flex-wrap: wrap; }
    .deck-tabs { order: 10; flex-basis: 100%; overflow-x: auto; }
    .deck-tab-marker { display: none; } /* tabs wrap/scroll on mobile — marker math is horizontal-only */
    .deck-tab { padding: 6px 12px; font-size: 11px; }
    .deck-body { padding: 12px; }
  }
</style>
