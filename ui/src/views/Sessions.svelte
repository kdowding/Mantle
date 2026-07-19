<script lang="ts">
  import { tick } from 'svelte';
  import { ui, sessions, chat } from '../lib/state.svelte';
  import { selectSession, newSession, removeSession, renameSession, setSessionPinned } from '../lib/sessions';
  import { isUnread } from '../lib/unread';
  import { formatTimeAgo } from '../lib/format';
  import { confirmDialog } from '../components/confirm.svelte';
  import type { SessionMeta } from '../lib/api';

  let query = $state('');
  let renamingId = $state<string | null>(null);
  let renameText = $state('');
  let renameEl = $state<HTMLInputElement | null>(null);

  function title(s: SessionMeta): string {
    return (s.title || 'Untitled').replace(/^\[Cron\]\s*/, '');
  }

  // Filter (title match) → buckets: pinned first, then recency groups.
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions.list;
    return sessions.list.filter((s) => title(s).toLowerCase().includes(q));
  });

  interface Group { label: string; items: SessionMeta[] }
  const groups = $derived.by(() => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = dayStart.getTime();
    const yesterday = today - 86_400_000;
    const week = today - 6 * 86_400_000;

    const order = ['pinned', 'today', 'yesterday', 'this week', 'earlier'];
    const buckets = new Map<string, SessionMeta[]>();
    for (const s of filtered) {
      const label = s.pinned
        ? 'pinned'
        : (() => {
            const t = new Date(s.lastMessageAt ?? s.createdAt ?? 0).getTime();
            if (t >= today) return 'today';
            if (t >= yesterday) return 'yesterday';
            if (t >= week) return 'this week';
            return 'earlier';
          })();
      const arr = buckets.get(label) ?? [];
      arr.push(s);
      buckets.set(label, arr);
    }
    const out: Group[] = [];
    for (const label of order) {
      const items = buckets.get(label);
      if (items?.length) out.push({ label, items });
    }
    return out;
  });

  async function onDelete(s: SessionMeta): Promise<void> {
    const ok = await confirmDialog({
      title: 'Delete session',
      message: `Delete "${title(s)}"?\nIts transcript is removed permanently.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (ok) void removeSession(s.id);
  }
  async function startRename(s: SessionMeta): Promise<void> {
    renamingId = s.id;
    renameText = title(s);
    await tick();
    renameEl?.focus();
    renameEl?.select();
  }
  function commitRename(): void {
    const id = renamingId;
    const text = renameText.trim();
    renamingId = null;
    if (id && text) void renameSession(id, text);
  }
  function onRenameKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    else if (e.key === 'Escape') { e.stopPropagation(); renamingId = null; }
  }
</script>

<div class="sessions">
  <div class="side-sect">
    <span class="side-sect-label">// sessions</span>
    <button class="side-sect-btn" type="button" title="New session" aria-label="New session" onclick={() => { ui.deckTab = null; newSession(); }}>+</button>
  </div>
  {#if sessions.list.length > 4}
    <input
      class="session-search"
      type="text"
      placeholder="filter…"
      autocomplete="off"
      spellcheck="false"
      bind:value={query}
    />
  {/if}
  <div class="session-list">
    {#each groups as group (group.label)}
      <div class="group-head" class:pinned={group.label === 'pinned'}>
        {group.label === 'pinned' ? '◆ pinned' : group.label}
      </div>
      {#each group.items as s (s.id)}
        <div class="session-item" class:active={s.id === chat.sessionId}>
          {#if renamingId === s.id}
            <input
              class="rename-input"
              type="text"
              bind:this={renameEl}
              bind:value={renameText}
              onkeydown={onRenameKey}
              onblur={() => (renamingId = null)}
            />
          {:else}
            <button class="session-main" type="button" onclick={() => selectSession(s.id)} ondblclick={() => void startRename(s)}>
              <div class="session-title">
                {#if s.id !== chat.sessionId && isUnread(s)}<span class="unread-dot" title="New activity since you last looked"></span>{/if}
                {#if s.pinned}<span class="pin-mark" aria-hidden="true">◆</span>{/if}
                {title(s)}
              </div>
              <div class="session-meta">
                {formatTimeAgo(s.lastMessageAt)}{s.messageCount ? ` · ${s.messageCount} msgs` : ''}
              </div>
            </button>
            <div class="row-actions">
              <button class="row-btn" type="button" title={s.pinned ? 'Unpin' : 'Pin to top'} aria-label={s.pinned ? 'Unpin session' : 'Pin session'} onclick={() => void setSessionPinned(s.id, !s.pinned)}>◆</button>
              <button class="row-btn" type="button" title="Rename" aria-label="Rename session" onclick={() => void startRename(s)}>✎</button>
              <button class="row-btn del" type="button" title="Delete session" aria-label="Delete session" onclick={() => onDelete(s)}>×</button>
            </div>
          {/if}
        </div>
      {/each}
    {/each}
    {#if sessions.list.length === 0}
      <div class="muted">No sessions yet</div>
    {:else if filtered.length === 0}
      <div class="muted">No matches for “{query}”</div>
    {/if}
  </div>
</div>

<style>
  .sessions { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }

  .session-search {
    flex-shrink: 0;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-left: 2px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 13px;
    padding: 7px 10px;
    transition: border-color 0.15s;
  }
  .session-search:focus { outline: none; border-color: var(--accent-edge); border-left-color: var(--accent); }
  .session-search::placeholder { color: var(--text-muted); font-family: var(--font-terminal); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }

  .session-list { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; min-height: 0; flex: 1; }

  .group-head {
    font-family: var(--font-terminal);
    font-size: 10px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--text-muted);
    opacity: 0.7;
    padding: 6px 2px 1px;
    flex-shrink: 0;
  }
  .group-head:first-child { padding-top: 0; }
  .group-head.pinned { color: var(--accent); opacity: 0.85; }

  .session-item {
    display: flex;
    align-items: stretch;
    border: 1px solid transparent;
    border-left: 2px solid transparent;
    transition: border-color 0.15s, background 0.15s;
    flex-shrink: 0;
  }
  .session-item:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .session-item.active { background: var(--accent-faint); border-color: var(--accent-edge); border-left-color: var(--accent); }

  .session-main {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    color: var(--text-primary);
    text-align: left;
    padding: 9px 11px;
    cursor: pointer;
  }
  .session-title {
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .session-meta { font-size: 10.5px; color: var(--text-muted); margin-top: 2px; font-family: var(--font-terminal); letter-spacing: 0.5px; }

  .pin-mark { color: var(--accent); font-size: 10px; flex-shrink: 0; }

  .unread-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent-glow);
  }

  /* Hover action cluster — pin / rename / delete. */
  .row-actions { display: flex; align-items: center; flex-shrink: 0; }
  .row-btn {
    width: 24px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 12.5px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, color 0.15s;
    padding: 0;
  }
  .session-item:hover .row-btn { opacity: 0.55; }
  .row-btn:hover { color: var(--accent); opacity: 1; }
  .row-btn.del { font-size: 17px; }
  .row-btn.del:hover { color: var(--error); }

  .rename-input {
    flex: 1;
    min-width: 0;
    margin: 4px 6px;
    background: var(--bg-input);
    border: 1px solid var(--accent-edge);
    color: var(--text-primary);
    font-size: 13px;
    padding: 3px 7px;
  }
  .rename-input:focus { outline: none; border-color: var(--accent); }

  .muted { color: var(--text-muted); font-size: 12px; padding: 8px 2px; }

  /* Touch has no hover — keep the row actions faintly visible. */
  @media (max-width: 768px) {
    .row-btn { opacity: 0.4; }
  }
</style>
