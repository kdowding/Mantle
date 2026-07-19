<script lang="ts">
  // The channel stage: a Discord-style room — a read-only status bar (#title ·
  // member count · volley/memory chips) over the message stream and the
  // composer (mention autocomplete + emoji + whisper + send / jump-in).
  // Every channel CONTROL lives in ChannelSidebar; this surface is the show.
  // Replaces the 1:1 chat in App's stage while channel.open.
  import { tick, untrack } from 'svelte';
  import { chat } from '../../lib/state.svelte';
  import { ChatScroll } from '../../lib/chat-scroll.svelte';
  import { setOnWriteGlobal, clearOnWriteGlobal } from '../../lib/stream';
  import Popover from '../../components/Popover.svelte';
  import EmojiPicker from '../../components/emoji/EmojiPicker.svelte';
  import {
    channel, closeChannelView, sendChannelMessage, jumpIn, retryChannelTurn,
    registerChannelWs, toggleWhisperTarget, clearWhisper,
    scanMention, agentById, type MentionMatch,
  } from './channel.svelte';
  import ChannelMessage from './ChannelMessage.svelte';
  import MusicRail from '../music/MusicRail.svelte'; // [room] same containment as Chat's row

  let draft = $state('');
  let ta = $state<HTMLTextAreaElement>();
  let scroller = $state<HTMLDivElement>();
  let asideOpen = $state(false);

  const whisperNames = $derived(channel.whisperTo.map((id) => agentById(id)?.name ?? id));

  // Claim channel_* events on the ws seam while the view lives.
  $effect(() => registerChannelWs());

  // Selecting a 1:1 session / new session in the sidebar leaves channel view.
  const initialSession = untrack(() => chat.sessionId);
  $effect(() => {
    if (chat.sessionId !== initialSession) closeChannelView();
  });

  const meta = $derived(channel.meta);
  const isMobile = () => window.innerWidth <= 768;
  const lastUserKey = $derived.by(() => {
    if (channel.sending) return null;
    for (let i = channel.msgs.length - 1; i >= 0; i--) {
      if (channel.msgs[i].kind === 'user') return channel.msgs[i].key;
    }
    return null;
  });

  // ── Mention autocomplete ────────────────────────────────────────────────────
  let mentions = $state<MentionMatch[]>([]);
  let mentionIdx = $state(0);
  let mentionAt = 0;

  function rescanMention(): void {
    if (!ta) return;
    const scan = scanMention(draft, ta.selectionStart ?? draft.length);
    if (scan.kind === 'suggest') {
      // During a whisper, only the aside's members can take the floor —
      // suggesting anyone else would be a dead @ (server filters it anyway).
      mentions = channel.whisperTo.length > 0
        ? scan.matches.filter((m) => channel.whisperTo.includes(m.id))
        : scan.matches;
      mentionIdx = 0;
      mentionAt = scan.atIdx;
    } else {
      mentions = [];
    }
  }

  function applyMention(m: MentionMatch): void {
    if (!ta) return;
    const pos = ta.selectionStart ?? draft.length;
    draft = `${draft.slice(0, mentionAt)}@${m.id} ${draft.slice(pos)}`;
    mentions = [];
    const cur = mentionAt + m.id.length + 2;
    void tick().then(() => {
      ta?.focus();
      if (ta) ta.selectionStart = ta.selectionEnd = cur;
    });
  }

  function autogrow(): void {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }

  function send(): void {
    const text = draft.trim();
    if (!text || channel.sending) return;
    void sendChannelMessage(text);
    draft = '';
    mentions = [];
    if (ta) ta.style.height = 'auto';
    // sendChannelMessage pushes the user row synchronously — anchor it near the
    // top once the DOM has it; the agents' replies stream below, free to scroll.
    void tick().then(() => {
      const rows = scroller?.querySelectorAll('.message.user');
      const el = rows && rows.length ? (rows[rows.length - 1] as HTMLElement) : null;
      if (el) sc.anchorSend(el);
    });
  }

  function onKeydown(e: KeyboardEvent): void {
    if (mentions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionIdx = (mentionIdx + 1) % mentions.length; return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionIdx = (mentionIdx - 1 + mentions.length) % mentions.length; return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentions[mentionIdx]); return; }
      if (e.key === 'Escape') { mentions = []; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      send();
    }
  }

  function insertEmoji(emoji: string): void {
    const start = ta?.selectionStart ?? draft.length;
    const end = ta?.selectionEnd ?? draft.length;
    draft = draft.slice(0, start) + emoji + draft.slice(end);
    void tick().then(() => {
      ta?.focus();
      if (ta) ta.selectionStart = ta.selectionEnd = start + emoji.length;
    });
  }

  // Shared claude.ai-style scroll model — anchor-on-send, opt-in tail-follow,
  // the ▼ chip — identical to the 1:1 chat and assist dock.
  const sc = new ChatScroll(() => scroller);

  // Channel switch → reset; the first settle after the switch lands at the
  // bottom (transform-immune — the stage mounts under a CRT scale that squashes
  // rects, which otherwise left the load stuck at the top).
  let chanLoadPending = false;
  let prevChanId: string | null = null;
  $effect(() => {
    const id = channel.activeId;
    if (id !== prevChanId) { prevChanId = id; sc.reset(); chanLoadPending = true; }
  });
  // New rows grow the stream; land at the bottom on the first settle after a
  // switch, then follow the tail when pinned, else show the ▼ chip.
  $effect(() => {
    void channel.msgs.length;
    const loading = channel.loading;
    void tick().then(() => {
      if (chanLoadPending) {
        if (!loading) { chanLoadPending = false; if (channel.msgs.length > 0) sc.landAtBottom(); }
        return;
      }
      sc.onWrite();
    });
  });
  // A speaker mid-reply grows via reveal-island writes (no new row) — the global
  // hook drives the same follow. clearOnWriteGlobal only nulls OUR hook, so the
  // 1:1 chat reclaiming it during the CRT stage swap isn't clobbered.
  $effect(() => {
    const hook = (): void => sc.onWrite();
    setOnWriteGlobal(hook);
    return () => clearOnWriteGlobal(hook);
  });

  const lastChanIsUser = $derived(channel.msgs[channel.msgs.length - 1]?.kind === 'user');
  const hasTail = $derived(channel.sending || lastChanIsUser || sc.anchorHold);
</script>

<div class="channel">
  <header class="bar">
    <button class="mgmt-btn" type="button" title="Channels & roster" aria-label="Open channel sidebar" onclick={() => (channel.mgmtOpen = true)}>⌗</button>
    <h1 class="title"><span class="t-hash">#</span>{meta?.title ?? 'channel'}</h1>
    {#if meta}
      <!-- read-only telemetry — every control lives in the channel sidebar -->
      <span class="bar-chip">{meta.participants.length} member{meta.participants.length === 1 ? '' : 's'}</span>
      {#if meta.volley?.enabled}
        <span class="bar-chip on" title="Volley on ({meta.volley.style ?? 'free'}) - agents riff for up to {meta.volley.maxTurns} turns">⇄ volley {meta.volley.maxTurns}</span>
      {/if}
      {#if meta.memoryPack}
        <span class="bar-chip on" title="Memory pack on - each speaker recalls before replying">⊙ memory</span>
      {/if}
    {/if}
  </header>

  <div class="body-row">
    <div
      class="stream"
      class:has-tail={hasTail}
      role="log"
      bind:this={scroller}
      onscroll={() => sc.onScroll()}
      onwheel={(e) => sc.onWheel(e)}
      ontouchmove={() => sc.onTouchMove()}
    >
      {#each channel.msgs as msg (msg.key)}
        <ChannelMessage {msg} />
        {#if msg.key === lastUserKey && msg.key === channel.msgs[channel.msgs.length - 1]?.key}
          <button class="msg-action" type="button" title="Re-run this message" onclick={() => void retryChannelTurn()}>↻ retry</button>
        {/if}
      {/each}
      {#if channel.loading}
        <div class="empty">Loading…</div>
      {:else if channel.msgs.length === 0}
        <div class="empty">{channel.activeId ? 'No messages yet. Say something to kick it off.' : 'Pick a channel - or create one to start a hangout.'}</div>
      {/if}
    </div>
    <MusicRail />
    {#if sc.showJump}
      <button class="jump-latest" type="button" title="Jump to the latest message" onclick={() => sc.jumpToBottom()}>▼ latest</button>
    {/if}
  </div>

  {#if channel.volleyMeter}
    <div class="meter">
      ⇄ volley · {channel.volleyMeter.remaining} turn{channel.volleyMeter.remaining === 1 ? '' : 's'} left
      {#if channel.volleyMeter.nextUp}· next: {agentById(channel.volleyMeter.nextUp)?.name ?? channel.volleyMeter.nextUp}{/if}
    </div>
  {/if}

  <div class="composer">
    {#if mentions.length > 0}
      <div class="mention-pop">
        {#each mentions as m, i (m.id)}
          <button
            class="mp-row"
            class:active={i === mentionIdx}
            type="button"
            style:--m-accent={m.accent ?? 'var(--accent)'}
            onmousedown={(e) => { e.preventDefault(); applyMention(m); }}
            onmouseenter={() => (mentionIdx = i)}
          >
            <span class="mp-name">{m.name}</span>
            <span class="mp-id">@{m.id}</span>
          </button>
        {/each}
      </div>
    {/if}

    <div class="controls">
      <EmojiPicker onpick={insertEmoji} />
      <Popover bind:open={asideOpen} width={230}>
        {#snippet trigger({ toggle })}
          <button
            class="aside-btn"
            class:on={channel.whisperTo.length > 0}
            type="button"
            title="Whisper - pull agents aside; the rest of the room won't see it"
            onclick={toggle}
          >⌐ {channel.whisperTo.length > 0 ? `aside · ${whisperNames.join(' + ')}` : 'aside'}</button>
        {/snippet}
        <div class="a-panel">
          <div class="a-head">whisper to…</div>
          {#each meta?.participants ?? [] as pid (pid)}
            {@const a = agentById(pid)}
            <button class="a-row" class:sel={channel.whisperTo.includes(pid)} type="button" onclick={() => toggleWhisperTarget(pid)}>
              <span class="a-check">{channel.whisperTo.includes(pid) ? '✓' : ''}</span>
              <span class="a-name" style:color={a?.accentColor}>{a?.name ?? pid}</span>
            </button>
          {/each}
          {#if channel.whisperTo.length > 0}
            <button class="a-clear" type="button" onclick={() => { clearWhisper(); asideOpen = false; }}>back to public</button>
          {/if}
          <div class="a-hint">Only you and the chosen agents see these messages - the rest of the room never knows they happened.</div>
        </div>
      </Popover>
      <textarea
        bind:this={ta}
        bind:value={draft}
        rows="1"
        class:whisper={channel.whisperTo.length > 0}
        placeholder={channel.sending
          ? 'AGENTS HAVE THE FLOOR…'
          : channel.whisperTo.length > 0
            ? `WHISPER TO ${whisperNames.join(' + ').toUpperCase()}…`
            : '@MENTION AN AGENT…'}
        disabled={!channel.activeId}
        oninput={() => { autogrow(); rescanMention(); }}
        onkeydown={onKeydown}
      ></textarea>
      {#if channel.sending}
        <button class="jump" type="button" onclick={jumpIn} title="Stop the volley - take the floor">■ jump in</button>
      {:else}
        <button class="send" type="button" onclick={send} disabled={!draft.trim() || !channel.activeId} aria-label="Send">▶</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .channel { display: flex; flex-direction: column; height: 100%; min-height: 0; }

  /* Status bar — title + read-only chips; deliberately control-free. */
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    min-height: 54px;
  }
  .title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 20px;
    letter-spacing: 1px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t-hash { color: var(--accent); text-shadow: 0 0 10px var(--accent-glow); margin-right: 1px; }

  .bar-chip {
    flex-shrink: 0;
    padding: 2px 9px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .bar-chip.on { color: var(--accent); border-color: var(--accent-edge); background: var(--accent-faint); }

  /* ⌗ — opens the channel sidebar drawer; the sidebar is persistent on
     desktop so the button only exists ≤768px. */
  .mgmt-btn {
    display: none;
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .mgmt-btn:hover { border-color: var(--accent); color: var(--accent); }

  /* The conversation row: stream beside the music rail (Chat.svelte's
     containment — opening the rail shrinks the stream, never the composer). */
  .body-row {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative; /* anchors the music rail's mobile overlay (inset 0) */
  }

  .stream {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 18px max(24px, calc((100% - var(--chat-column-max)) / 2));
    display: flex;
    flex-direction: column;
    gap: 8px;
    /* HUD side rails in the dead margins — same seams + tick marks as the
       1:1 chat scroller, so the room reads as the same surface. */
    background:
      linear-gradient(to bottom, transparent, var(--border-strong) 14%, var(--border-strong) 86%, transparent)
        left calc(50% - (var(--chat-column-max) / 2) - 30px) top / 1px 100% no-repeat,
      repeating-linear-gradient(to bottom, var(--accent-edge) 0 1px, transparent 1px 30px)
        left calc(50% - (var(--chat-column-max) / 2) - 29px) top 14px / 6px calc(100% - 28px) no-repeat,
      linear-gradient(to bottom, transparent, var(--border-strong) 14%, var(--border-strong) 86%, transparent)
        left calc(50% + (var(--chat-column-max) / 2) + 30px) top / 1px 100% no-repeat,
      repeating-linear-gradient(to bottom, var(--accent-edge) 0 1px, transparent 1px 30px)
        left calc(50% + (var(--chat-column-max) / 2) + 24px) top 14px / 6px calc(100% - 28px) no-repeat;
  }
  /* Exchange rhythm — a user turn opens a new exchange, so it gets the wide
     gap; the replies inside an exchange stay tight (1:1 parity). */
  .stream > :global(.message.user:not(:first-child)) { margin-top: 20px; }
  .empty { margin: auto; color: var(--text-muted); font-family: var(--font-display); letter-spacing: 1px; }

  /* Tail room so a just-sent message can anchor near the top while replies
     stream below — only during an active exchange (claude.ai parity, shared
     with the 1:1 chat + assist dock). */
  .stream.has-tail::after {
    content: '';
    display: block;
    flex: 0 0 max(320px, calc(100dvh - 260px));
    pointer-events: none;
  }
  /* ▼ jump-to-latest chip — identical to the 1:1 chat's. */
  .jump-latest {
    position: absolute;
    bottom: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9;
    padding: 6px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5), 0 0 12px var(--accent-dim);
  }
  .jump-latest:hover { background: var(--accent-dim); border-color: var(--accent); }

  .meter {
    flex-shrink: 0;
    align-self: center;
    padding: 4px 14px;
    margin-bottom: 4px;
    border: 1px solid var(--accent-edge);
    background: var(--accent-faint);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .composer {
    position: relative;
    padding: 12px 20px 16px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .controls { display: flex; gap: 10px; align-items: flex-end; }
  textarea {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-bottom: 2px solid var(--text-muted);
    color: var(--text-primary);
    padding: 10px 14px;
    font-family: var(--font-sans);
    font-size: 14px;
    resize: none;
    max-height: 180px;
    line-height: 1.5;
  }
  textarea:focus { outline: none; border-bottom-color: var(--accent); }
  textarea::placeholder { color: var(--text-muted); font-family: var(--font-display); letter-spacing: 1px; }
  textarea:disabled { opacity: 0.5; }
  /* Whisper mode — the composer itself goes "off the record" so it's
     impossible to forget the aside is still on. */
  textarea.whisper {
    border: 1px dashed var(--accent-edge);
    border-bottom: 2px dashed var(--accent);
    background:
      repeating-linear-gradient(
        135deg,
        color-mix(in srgb, var(--accent) 3.5%, transparent) 0 8px,
        transparent 8px 18px
      ),
      var(--bg-input);
  }

  .aside-btn {
    height: 38px;
    flex-shrink: 0;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 10px;
    background: transparent;
    border: 1px dashed var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .aside-btn:hover { border-color: var(--accent); color: var(--accent); }
  .aside-btn.on { border-color: var(--accent); color: var(--accent); background: var(--accent-faint); }

  .a-panel { display: flex; flex-direction: column; gap: 2px; padding: 2px; }
  .a-head {
    font-family: var(--font-display);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-muted);
    padding: 4px 8px 3px;
  }
  .a-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 9px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    text-align: left;
    cursor: pointer;
    font-size: 13px;
  }
  .a-row:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .a-row.sel { background: var(--accent-faint); border-left-color: var(--accent); }
  .a-check { width: 12px; color: var(--accent); font-size: 11px; }
  .a-name { font-family: var(--font-display); letter-spacing: 0.5px; }
  .a-clear {
    margin: 4px 6px 2px;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
  }
  .a-clear:hover { border-color: var(--accent); color: var(--accent); }
  .a-hint { font-size: 11px; color: var(--text-muted); line-height: 1.45; padding: 4px 8px 5px; }

  .send, .jump {
    height: 38px;
    flex-shrink: 0;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    font-size: 13px;
  }
  .send { width: 38px; background: transparent; border: 1px solid var(--accent); color: var(--accent); }
  .send:hover:not(:disabled) { background: var(--accent-dim); }
  .send:disabled { opacity: 0.4; cursor: default; }
  .jump {
    padding: 0 14px;
    background: transparent;
    border: 1px solid var(--error);
    color: var(--error);
    font-family: var(--font-display);
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  .jump:hover { background: rgba(255, 45, 124, 0.15); }

  .mention-pop {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 70px;
    z-index: 30;
    min-width: 220px;
    padding: 4px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-strong);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .mp-row {
    display: flex;
    align-items: baseline;
    gap: 9px;
    width: 100%;
    padding: 6px 9px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    text-align: left;
    cursor: pointer;
  }
  .mp-row.active { background: var(--accent-faint); border-left-color: var(--m-accent); }
  .mp-name { font-family: var(--font-display); font-size: 13px; color: var(--m-accent); letter-spacing: 0.5px; }
  .mp-id { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }

  /* ── Mobile (≤768px) — the ⌗ button stands in for the persistent sidebar ── */
  @media (max-width: 768px) {
    .bar {
      gap: 8px;
      padding: 9px 10px 8px 54px; /* clear the fixed hamburger */
      min-height: 56px;
    }
    .title { font-size: 16px; letter-spacing: 1.5px; }
    .mgmt-btn { display: flex; }
    .bar-chip { display: none; } /* tight bar — state lives in the drawer */
    .bar-chip.on { display: inline-block; } /* keep the active-state signals */
    .stream { padding: 14px 12px; gap: 12px; }
  }
</style>
