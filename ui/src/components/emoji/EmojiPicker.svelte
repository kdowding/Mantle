<script lang="ts">
  // Emoji picker popover — ONE continuous scroll of every category (sticky
  // section headers), category tabs that JUMP to their section, and search
  // across the name index + category labels. Replaces the per-category pane
  // (which made the set feel tiny and the navigation awkward). Data
  // lazy-loads from /emoji-data.json on first open; picking inserts via
  // onpick and keeps the picker open; outside click / Esc closes.
  import { tick } from 'svelte';
  import Popover from '../Popover.svelte';
  import { recents, addRecent } from './recents.svelte';

  interface EmojiCategory {
    id: string;
    label: string;
    icon: string;
    emojis: string[];
  }
  interface EmojiData {
    categories: EmojiCategory[];
    searchIndex?: Record<string, string>;
  }

  let { onpick }: { onpick: (emoji: string) => void } = $props();

  let open = $state(false);
  let data = $state<EmojiData | null>(null);
  let failed = $state(false);
  let query = $state('');
  let scrollEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (open && !data && !failed) void load();
  });

  async function load(): Promise<void> {
    try {
      const res = await fetch('/emoji-data.json');
      if (!res.ok) throw new Error(String(res.status));
      data = (await res.json()) as EmojiData;
    } catch {
      failed = true;
    }
  }

  // Sections — recents first (when any), then every category.
  interface Section { id: string; label: string; icon: string; emojis: string[] }
  const sections = $derived.by<Section[]>(() => {
    const out: Section[] = [];
    if (recents.list.length > 0) out.push({ id: 'recent', label: 'Recent', icon: '🕒', emojis: recents.list });
    for (const c of data?.categories ?? []) out.push({ id: c.id, label: c.label, icon: c.icon, emojis: c.emojis });
    return out;
  });

  // Search — name index hits first (exact intent), then whole categories
  // whose label matches (broad intent).
  const searchResults = $derived.by<string[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (e: string): boolean => {
      if (seen.has(e)) return out.length < 160;
      seen.add(e);
      out.push(e);
      return out.length < 160;
    };
    for (const [name, e] of Object.entries(data.searchIndex ?? {})) {
      if (name.includes(q) && !push(e)) return out;
    }
    for (const cat of data.categories) {
      if (!cat.label.toLowerCase().includes(q)) continue;
      for (const e of cat.emojis) if (!push(e)) return out;
    }
    return out;
  });

  function pick(emoji: string): void {
    addRecent(emoji);
    onpick(emoji);
  }

  async function jumpTo(id: string): Promise<void> {
    query = '';
    await tick(); // sections re-render before we look the header up
    scrollEl?.querySelector(`[data-sect="${id}"]`)?.scrollIntoView({ block: 'start' });
  }
</script>

<Popover bind:open align="left" up width={416}>
  {#snippet trigger({ toggle, open: isOpen })}
    <button class="emoji-btn" class:open={isOpen} type="button" aria-label="Emoji picker" onclick={toggle}>☻</button>
  {/snippet}

  <div class="picker">
    <input class="search" type="text" placeholder="search emoji…" spellcheck="false" autocomplete="off" bind:value={query} />
    <div class="tabs">
      {#if recents.list.length > 0}
        <button class="tab" type="button" title="Recent" onclick={() => void jumpTo('recent')}>🕒</button>
      {/if}
      {#each data?.categories ?? [] as cat (cat.id)}
        <button class="tab" type="button" title={cat.label} onclick={() => void jumpTo(cat.id)}>{cat.icon}</button>
      {/each}
    </div>

    <div class="scroll" bind:this={scrollEl}>
      {#if query.trim()}
        <div class="grid">
          {#each searchResults as emoji (emoji)}
            <button class="cell" type="button" onclick={() => pick(emoji)}>{emoji}</button>
          {/each}
          {#if searchResults.length === 0}
            <div class="empty">{data ? 'No results' : failed ? 'Failed to load emoji data' : 'Loading…'}</div>
          {/if}
        </div>
      {:else}
        {#each sections as sect (sect.id)}
          <div class="sect-head" data-sect={sect.id}>// {sect.label}</div>
          <div class="grid">
            <!-- index keys: the source data repeats a few emojis within a category -->
            {#each sect.emojis as emoji, i (`${sect.id}:${i}`)}
              <button class="cell" type="button" onclick={() => pick(emoji)}>{emoji}</button>
            {/each}
          </div>
        {/each}
        {#if sections.length === 0}
          <div class="empty">{failed ? 'Failed to load emoji data' : 'Loading…'}</div>
        {/if}
      {/if}
    </div>
  </div>
</Popover>

<style>
  .emoji-btn {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 17px;
    line-height: 1;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: border-color 0.2s, background 0.2s, color 0.2s;
  }
  .emoji-btn:hover, .emoji-btn.open { border-color: var(--accent); background: var(--accent-faint); color: var(--accent); }

  .picker { display: flex; flex-direction: column; gap: 7px; }

  .search {
    width: 100%;
    padding: 7px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 13px;
  }
  .search:focus { outline: none; border-color: var(--accent); }
  .search::placeholder { color: var(--text-muted); font-family: var(--font-terminal); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }

  .tabs { display: flex; gap: 1px; }
  .tab {
    flex: 1;
    height: 28px;
    background: transparent;
    border: none;
    border-bottom: 2px solid var(--border);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 0.12s, border-color 0.12s, background 0.12s;
  }
  .tab:hover { opacity: 1; border-bottom-color: var(--accent); background: var(--accent-faint); }

  .scroll { max-height: 340px; overflow-y: auto; }

  .sect-head {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-secondary);
    font-family: var(--font-display);
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--text-muted);
    padding: 7px 2px 4px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 1px;
  }
  .cell {
    aspect-ratio: 1;
    background: transparent;
    border: none;
    font-size: 21px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.1s, transform 0.1s;
  }
  .cell:hover { background: var(--accent-faint); transform: scale(1.18); }

  .empty {
    grid-column: 1 / -1;
    padding: 18px 8px;
    text-align: center;
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
</style>
