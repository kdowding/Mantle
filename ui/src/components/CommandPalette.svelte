<script lang="ts">
  // Ctrl+K command palette — one fuzzy switcher over agents, the current
  // agent's sessions, app actions, and slash commands. Mounted once from App;
  // it registers its own global hotkey (Ctrl/Cmd+K toggles, Esc closes).
  import { tick } from 'svelte';
  import { ui, sessions, composer } from '../lib/state.svelte';
  import { selectAgent } from '../lib/agents';
  import { selectSession, newSession } from '../lib/sessions';
  import { tryCommand, listCommands } from '../lib/commands';
  import { formatTimeAgo } from '../lib/format';
  import { settings } from '../rooms/settings/settings.svelte'; // [room] action targets
  import { local } from '../rooms/local/local.svelte';
  import { openWorkspace } from '../rooms/workspace/workspace.svelte';
  import { setOpen as setMusicOpen } from '../rooms/music/music.svelte';

  let open = $state(false);
  let query = $state('');
  let active = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  interface Item {
    kind: 'agent' | 'session' | 'action' | 'command';
    label: string;
    hint: string;
    accent?: string;
    run: () => void;
  }

  function allItems(): Item[] {
    const items: Item[] = [];
    for (const a of ui.agents) {
      items.push({
        kind: 'agent',
        label: a.name,
        hint: a.id === ui.currentAgentId ? 'agent · current' : 'agent · switch',
        accent: a.accentColor,
        run: () => void selectAgent(a.id),
      });
    }
    items.push(
      { kind: 'action', label: 'New session', hint: 'action', run: () => newSession() },
      { kind: 'action', label: 'Settings', hint: 'action', run: () => (settings.open = true) },
      { kind: 'action', label: 'Local models', hint: 'action', run: () => (local.open = true) },
      { kind: 'action', label: 'Workspace files', hint: 'action · prompt sources', run: () => openWorkspace() },
      { kind: 'action', label: 'Music player', hint: 'action · open rail', run: () => setMusicOpen(true) },
    );
    for (const s of sessions.list) {
      const t = (s.title || 'Untitled').replace(/^\[Cron\]\s*/, '');
      items.push({
        kind: 'session',
        label: t,
        hint: `session · ${formatTimeAgo(s.lastMessageAt)}`,
        run: () => void selectSession(s.id),
      });
    }
    for (const c of listCommands()) {
      items.push({
        kind: 'command',
        label: c.usage,
        hint: c.description,
        run: () => {
          if (!tryCommand(`/${c.name}`)) {
            composer.draft = `/${c.name} `;
            (document.querySelector('textarea.message-input') as HTMLTextAreaElement | null)?.focus();
          }
        },
      });
    }
    return items;
  }

  // Subsequence fuzzy score — prefix beats word-start beats scattered; null
  // when the query isn't a subsequence at all.
  function score(label: string, q: string): number | null {
    const l = label.toLowerCase();
    if (!q) return 0;
    if (l.startsWith(q)) return 1000 - l.length;
    const idx = l.indexOf(q);
    if (idx !== -1) return 500 - idx;
    let li = 0;
    let s = 0;
    for (const ch of q) {
      const found = l.indexOf(ch, li);
      if (found === -1) return null;
      s += found === li ? 3 : 1; // contiguous runs score higher
      li = found + 1;
    }
    return s;
  }

  const results = $derived.by(() => {
    if (!open) return [];
    const q = query.trim().toLowerCase();
    const scored = allItems()
      .map((item) => ({ item, s: score(item.label, q) }))
      .filter((x): x is { item: Item; s: number } => x.s !== null);
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 12).map((x) => x.item);
  });

  $effect(() => {
    void results.length;
    active = 0;
  });

  async function openPalette(): Promise<void> {
    open = true;
    query = '';
    active = 0;
    await tick();
    inputEl?.focus();
  }
  function close(): void {
    open = false;
  }
  function runItem(item: Item | undefined): void {
    if (!item) return;
    close();
    item.run();
  }

  function onWindowKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (open) close();
      else void openPalette();
    } else if (open && e.key === 'Escape') {
      e.stopImmediatePropagation(); // the palette owns this Esc — drawers/modals stay put
      close();
    }
  }

  function onInputKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, results.length - 1);
      scrollActiveIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      scrollActiveIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(results[active]);
    }
  }
  function scrollActiveIntoView(): void {
    void tick().then(() => listEl?.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' }));
  }

  const KIND_GLYPH: Record<Item['kind'], string> = {
    agent: '◉',
    session: '▤',
    action: '▸',
    command: '/',
  };
</script>

<svelte:window onkeydowncapture={onWindowKey} />

{#if open}
  <div class="pal-overlay" role="dialog" aria-modal="true" aria-label="Command palette">
    <button class="pal-backdrop" type="button" aria-label="Close" onclick={close}></button>
    <div class="palette">
      <div class="pal-input-row">
        <span class="pal-glyph">❯</span>
        <input
          bind:this={inputEl}
          bind:value={query}
          class="pal-input"
          type="text"
          placeholder="agents · sessions · actions · commands…"
          spellcheck="false"
          autocomplete="off"
          onkeydown={onInputKey}
        />
        <span class="pal-key">esc</span>
      </div>
      <div class="pal-list" bind:this={listEl}>
        {#each results as item, i (item.kind + item.label)}
          <button
            class="row"
            class:active={i === active}
            type="button"
            style={item.accent ? `--pal-accent: ${item.accent}` : ''}
            onclick={() => runItem(item)}
            onmouseenter={() => (active = i)}
          >
            <span class="row-glyph" class:agent={item.kind === 'agent'}>{KIND_GLYPH[item.kind]}</span>
            <span class="row-label">{item.label}</span>
            <span class="row-hint">{item.hint}</span>
          </button>
        {/each}
        {#if results.length === 0}
          <div class="pal-empty">No matches.</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .pal-overlay {
    position: fixed;
    inset: 0;
    z-index: 95;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 14vh;
  }
  .pal-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(10, 10, 15, 0.75);
    border: none;
    cursor: default;
  }

  .palette {
    position: relative;
    width: min(580px, calc(100vw - 24px));
    background: var(--bg-secondary);
    border: 1px solid var(--accent-edge);
    clip-path: polygon(0 0, calc(100% - var(--cut-lg)) 0, 100% var(--cut-lg), 100% 100%, var(--cut-lg) 100%, 0 calc(100% - var(--cut-lg)));
    filter: drop-shadow(0 14px 34px rgba(0, 0, 0, 0.6));
    animation: pal-rise 0.16s ease-out;
  }
  @keyframes pal-rise {
    from { opacity: 0; transform: translateY(-8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .palette { animation: none; }
  }

  .pal-input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-strong);
  }
  .pal-glyph {
    font-family: var(--font-terminal);
    color: var(--accent);
    text-shadow: 0 0 8px var(--accent-glow);
  }
  .pal-input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 15px;
  }
  .pal-input:focus { outline: none; }
  .pal-input::placeholder { color: var(--text-muted); font-size: 13px; }
  .pal-key {
    flex-shrink: 0;
    font-family: var(--font-terminal);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-muted);
    border: 1px solid var(--border);
    padding: 2px 6px;
  }

  .pal-list { max-height: 46vh; overflow-y: auto; padding: 6px; }

  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    text-align: left;
    cursor: pointer;
  }
  .row.active {
    background: var(--accent-faint);
    border-left-color: var(--pal-accent, var(--accent));
  }
  .row-glyph {
    flex-shrink: 0;
    width: 16px;
    font-family: var(--font-terminal);
    font-size: 11px;
    color: var(--pal-accent, var(--accent));
    opacity: 0.8;
  }
  .row-label {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-size: 13.5px;
  }
  .row-hint {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    font-family: var(--font-terminal);
    font-size: 9.5px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .pal-empty { padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px; }
</style>
