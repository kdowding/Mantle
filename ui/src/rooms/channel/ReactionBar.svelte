<script lang="ts">
  // Reaction chips at a bubble's foot — grouped by emoji with counts, the
  // user's own highlighted; clicking a chip toggles your reaction, the "+"
  // (hover-revealed) opens a quick-pick row. Agents react through their
  // channel_react tool; this bar is the user's side of the same store.
  import Popover from '../../components/Popover.svelte';
  import { agentName, toggleUserReaction, type ChannelMsg } from './channel.svelte';

  let { msg }: { msg: ChannelMsg } = $props();
  let pickOpen = $state(false);

  const QUICK = ['👍', '😂', '❤️', '🔥', '👀', '✨'];

  interface Group { emoji: string; count: number; mine: boolean; who: string }
  const groups = $derived.by<Group[]>(() => {
    const m = new Map<string, { count: number; mine: boolean; who: string[] }>();
    for (const r of msg.reactions ?? []) {
      const g = m.get(r.emoji) ?? { count: 0, mine: false, who: [] };
      g.count++;
      if (r.by === 'user') { g.mine = true; g.who.push('you'); }
      else g.who.push(agentName(r.by));
      m.set(r.emoji, g);
    }
    return [...m.entries()].map(([emoji, g]) => ({ emoji, count: g.count, mine: g.mine, who: g.who.join(', ') }));
  });

  // Reactions key off the persisted row id — absent until the row lands.
  const canReact = $derived(!!msg.msgId);

  function toggle(emoji: string): void {
    pickOpen = false;
    void toggleUserReaction(msg, emoji);
  }
</script>

{#if groups.length > 0 || canReact}
  <div class="rx-bar">
    {#each groups as g (g.emoji)}
      <button
        class="rx"
        class:mine={g.mine}
        type="button"
        title={g.who}
        disabled={!canReact}
        onclick={() => toggle(g.emoji)}
      ><span class="rx-e">{g.emoji}</span>{#if g.count > 1}<span class="rx-n">{g.count}</span>{/if}</button>
    {/each}
    {#if canReact}
      <!-- align=left: the bar sits at the column's left edge — a right-aligned
           panel would slide under the sidebar (found live). -->
      <Popover bind:open={pickOpen} align="left" width={186}>
        {#snippet trigger({ toggle: t })}
          <button class="rx-add" class:held={pickOpen} type="button" title="React" onclick={t}>+</button>
        {/snippet}
        <div class="rx-quick">
          {#each QUICK as e (e)}
            <button class="rx-q" type="button" onclick={() => toggle(e)}>{e}</button>
          {/each}
        </div>
      </Popover>
    {/if}
  </div>
{/if}

<style>
  .rx-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 6px; min-height: 0; }

  .rx {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 7px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-strong);
    cursor: pointer;
    font-size: 13px;
    line-height: 1.5;
    transition: border-color 0.12s, background 0.12s;
  }
  .rx:hover:not(:disabled) { border-color: var(--accent); }
  .rx:disabled { cursor: default; }
  .rx.mine { border-color: var(--accent); background: var(--accent-faint); }
  .rx-n { font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary); }

  /* "+" stays invisible until the bubble is hovered (or its picker is open),
     so finished transcripts don't grow a row of stray buttons. */
  .rx-add {
    width: 22px;
    height: 22px;
    background: transparent;
    border: 1px dashed var(--border-strong);
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s, border-color 0.12s, color 0.12s;
  }
  :global(.message-body:hover) .rx-add, .rx-add.held { opacity: 1; }
  .rx-add:hover { border-color: var(--accent); color: var(--accent); }

  .rx-quick { display: flex; gap: 4px; padding: 4px; }
  .rx-q {
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    background: transparent;
    border: 1px solid transparent;
    font-size: 15px;
    cursor: pointer;
  }
  .rx-q:hover { border-color: var(--accent-edge); background: var(--accent-faint); }
</style>
