<script lang="ts">
  import { onMount } from 'svelte';
  import { ui, chat, composer, sessions, getFeature } from '../lib/state.svelte';
  import { sendChat, stopTurn } from '../lib/ws';
  import { tryCommand } from '../lib/commands';
  import { setOnWriteGlobal, clearOnWriteGlobal } from '../lib/stream';
  import { ChatScroll } from '../lib/chat-scroll.svelte';
  import { addFile } from '../lib/attachments';
  import CallResumeBar from '../rooms/call/CallResumeBar.svelte'; // [room] composer swap
  import MusicRail from '../rooms/music/MusicRail.svelte'; // [room] bolt-on beside the messages
  import Message from './Message.svelte';
  import MessageInput from './MessageInput.svelte';
  import ContextBar from './ContextBar.svelte';
  import EmptyState from './EmptyState.svelte';

  // [room] calls: a call-mode session replays as normal bubbles, but you
  // continue it by calling back in — the composer swaps for the resume bar.
  const isCallSession = $derived(
    !!chat.sessionId && sessions.list.find((s) => s.id === chat.sessionId)?.isCall === true,
  );

  // Last-turn actions: retry surfaces on the final assistant bubble, edit on
  // the final real user bubble (notes never anchor) — only while idle.
  const lastAssistantId = $derived.by(() => {
    if (chat.isStreaming || !chat.sessionId) return null;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'assistant') return chat.messages[i].id;
    }
    return null;
  });
  const lastUserId = $derived.by(() => {
    if (chat.isStreaming || !chat.sessionId) return null;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m.role === 'user' && !m.origin) return m.id;
    }
    return null;
  });

  let scroller: HTMLDivElement;
  let dragDepth = 0;

  function onDragEnter(e: DragEvent): void {
    e.preventDefault();
    dragDepth++;
    composer.dragging = true;
  }
  function onDragOver(e: DragEvent): void {
    e.preventDefault();
  }
  function onDragLeave(e: DragEvent): void {
    e.preventDefault();
    dragDepth--;
    if (dragDepth <= 0) { dragDepth = 0; composer.dragging = false; }
  }
  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragDepth = 0;
    composer.dragging = false;
    for (const f of e.dataTransfer?.files ?? []) addFile(f);
  }

  // ── Scroll model (claude.ai-style) ─────────────────────────────────────────
  // Send anchors YOUR prompt near the top (the ::after spacer provides the
  // room); the reply grows below, and tail-follow only engages once content
  // passes the fold. Scrolling up releases the follow; returning to the
  // bottom re-arms it. Session load jumps to the CONTENT bottom (never into
  // the spacer — the old port scrolled to scrollHeight and landed on a 60dvh
  // void). The spacer only exists during an active exchange (streaming or
  // just-sent), so finished transcripts have no phantom scroll room at all.
  // The claude.ai-style scroll model (anchor-on-send, opt-in tail-follow, the ▼
  // chip, the glide) lives in the shared ChatScroll so the assist dock + channel
  // behave identically. This view keeps only its session-switch / entrance /
  // send-detection orchestration around those primitives.
  const sc = new ChatScroll(() => scroller);
  let prevSessionId: string | null = null;
  let prevLen = 0;
  // Session switch sets this; the transcript arrives ASYNC after the
  // sessionId flips, so the landing scroll waits for the messages batch.
  let pendingLoadScroll = false;

  const lastIsUser = $derived.by(() => {
    const last = chat.messages[chat.messages.length - 1];
    return last ? last.role === 'user' : false;
  });
  // Once a send anchors in this view, the tail room PERSISTS (claude.ai keeps
  // the scroll room after the reply finishes — collapsing it would clamp
  // scrollTop and yank an anchored reader mid-read). sc.reset() on a session
  // switch clears it, so cold replays still land void-free.
  const hasTail = $derived(chat.isStreaming || lastIsUser || sc.anchorHold);

  // Kept for the send-anchor fallback — the just-sent prompt's element when the
  // data-mid query misses; the shared controller does the actual scrolling.
  function lastMessageEl(): HTMLElement | null {
    if (!scroller) return null;
    for (let i = scroller.children.length - 1; i >= 0; i--) {
      const el = scroller.children[i] as HTMLElement;
      if (el.classList.contains('message')) return el;
    }
    return null;
  }

  // ── Quote-reply ────────────────────────────────────────────────────────────
  // Select text inside an assistant turn → a floating "quote" chip; clicking
  // it prepends the selection as a `>` block in the composer.
  let quote = $state<{ x: number; y: number; text: string } | null>(null);

  function onMouseUp(): void {
    // Defer a tick — the selection isn't final until after mouseup.
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
      if (!text || text.length < 3 || !sel) { quote = null; return; }
      const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
      if (!anchor?.closest('.message.assistant')) { quote = null; return; }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const host = scroller.getBoundingClientRect();
      quote = {
        x: Math.max(40, Math.min(host.width - 40, r.left + r.width / 2 - host.left)),
        y: Math.max(30, r.top - host.top),
        text,
      };
    }, 0);
  }
  function applyQuote(): void {
    if (!quote) return;
    const block = quote.text.split('\n').map((l) => `> ${l}`).join('\n');
    composer.draft = `${block}\n\n${composer.draft}`;
    quote = null;
    window.getSelection()?.removeAllRanges();
    (document.querySelector('textarea.message-input') as HTMLTextAreaElement | null)?.focus();
  }
  function onScroll(): void {
    quote = null; // the selection rect scrolled away with the content
    sc.onScroll();
  }

  onMount(() => {
    // Every reveal island (the chat singleton + voice's audio-paced part) drives
    // the pinned-follow through the shared controller. clearOnWriteGlobal only
    // nulls OUR hook, so the channel view taking it over during the CRT stage
    // swap isn't clobbered by this view's delayed cleanup.
    const hook = (): void => sc.onWrite();
    setOnWriteGlobal(hook);
    return () => clearOnWriteGlobal(hook);
  });

  // (The session-swap CRT collapse lived here — replaced by the per-message
  // window-restore + typewriter entrance, choreographed in lib/sessions.ts
  // and rendered by Message.svelte's entrance classes.)

  // Agent retune sweep — a quick dim seam crosses the CONVERSATION pane on
  // agent switch (and once on mount). Scoped here so it never crosses the
  // profile bar / composer. CAUTION: sweepKey++ would READ sweepKey inside
  // the effect and loop it on itself — the plain counter keeps writes blind.
  let sweepKey = $state(0);
  let sweepCounter = 0;
  $effect(() => {
    void ui.currentAgentId;
    sweepKey = ++sweepCounter;
  });

  $effect(() => {
    const len = chat.messages.length;
    const sid = chat.sessionId;
    if (sid !== prevSessionId) {
      // Session switched — the transcript batch lands async after this.
      prevSessionId = sid;
      prevLen = len;
      pendingLoadScroll = true;
      sc.reset(); // fresh view: no tail room; a mid-glide switch stops gliding
      if (len > 0) { pendingLoadScroll = false; sc.landAtBottom(); }
      return;
    }
    if (len > prevLen) {
      // Only a real transcript LOAD lands here with pendingLoadScroll armed AND
      // not streaming. A brand-new session's FIRST send also arms it — creating
      // the session flips chat.sessionId null→id in its own flush (before the
      // rows push), tripping the session-switch branch above — but a send sets
      // isStreaming (a load resets it false in selectSession/newSession), so it
      // falls through to the anchor instead of landAtBottom, which would scroll
      // the just-sent prompt off the top into the tail spacer (the "first turn
      // lands in a void" bug).
      if (pendingLoadScroll && !chat.isStreaming) {
        pendingLoadScroll = false;
        const hasEntrance = chat.messages.some((m) => m.entranceOrder != null);
        const el = hasEntrance
          ? (scroller?.querySelector('.message.entrance') as HTMLElement | null)
          : null;
        // Entrance load parks at the TOP of the entrance set (the windows pop
        // and type IN PLACE); otherwise land on the content bottom (transform-
        // immune — the stage mounts under a CRT scale).
        if (el) sc.parkAt(el);
        else sc.landAtBottom();
      } else {
        pendingLoadScroll = false;
        // A send pushes the user message AND the assistant placeholder in ONE
        // flush, so the last message is never the prompt — scan the added slice
        // for it and anchor its actual node. (On a first send the switch branch
        // reset prevLen to 0, so the slice starts at 0 and still finds it.)
        const sent = chat.messages.slice(prevLen, len).find((m) => m.role === 'user' && !m.origin && !m.divider);
        const el = sent
          ? ((scroller?.querySelector(`[data-mid="${sent.id}"]`) as HTMLElement | null) ?? lastMessageEl())
          : null;
        if (el) sc.anchorSend(el);
      }
      // A reply opening does NOT arm the tail-follow — claude.ai semantics: the
      // view holds at your anchored prompt while the reply grows below the fold.
    }
    prevLen = len;
  });
</script>

<div class="chat" ondragenter={onDragEnter} ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop} role="presentation">
  {#if composer.dragging}
    <div class="drop-overlay">Drop files to attach</div>
  {/if}
  <!-- The conversation row: messages beside the music rail. The rail lives
       BETWEEN the profile bar and the composer (the old UI's containment) —
       opening it shrinks the messages pane, never the composer. -->
  <div class="chat-row">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions — mouseup only observes text selection (quote chip), it adds no interaction -->
    <div class="messages" class:has-tail={hasTail} role="log" bind:this={scroller} onwheel={(e) => sc.onWheel(e)} ontouchmove={() => sc.onTouchMove()} onscroll={onScroll} onmouseup={onMouseUp}>
      {#each chat.messages as m (m.id)}
        <Message message={m} showRetry={m.id === lastAssistantId} showEdit={m.id === lastUserId} />
      {/each}
      {#if chat.messages.length === 0}
        <EmptyState />
      {/if}
    </div>
    {#if getFeature('music')?.enabled}<MusicRail />{/if}
    {#key sweepKey}
      <div class="agent-sweep" aria-hidden="true"></div>
    {/key}
    {#if sc.showJump}
      <button
        class="jump-latest"
        type="button"
        title="Jump to the latest message"
        onclick={() => sc.jumpToBottom()}
      >▼ latest</button>
    {/if}
    {#if quote}
      <button
        class="quote-chip"
        type="button"
        style="left: {quote.x}px; top: {quote.y - 34}px"
        title="Quote the selection in your reply"
        onclick={applyQuote}
      >❝ quote</button>
    {/if}
  </div>
  {#if isCallSession}
    <CallResumeBar />
  {:else}
    <ContextBar />
    <MessageInput
      onsend={(text) => { if (!tryCommand(text)) void sendChat(text); }}
      onstop={stopTurn}
      streaming={chat.isStreaming}
    />
  {/if}
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    position: relative;
  }

  .drop-overlay {
    position: absolute;
    inset: 12px;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    background: var(--accent-faint);
    border: 2px dashed var(--accent);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 18px;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  /* Messages beside the music rail; the rail manages its own width. */
  .chat-row {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative; /* anchors the music rail's mobile overlay (inset 0) */
  }

  .messages {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 18px max(24px, calc((100% - var(--chat-column-max)) / 2));
    display: flex;
    flex-direction: column;
    gap: 8px;
    /* HUD side rails in the dead margins — vertical seams + inward tick
       marks flanking the conversation column. Painted as backgrounds on the
       scroller so they hold still while content scrolls; at narrow widths
       the calc() positions land off-canvas and they vanish on their own. */
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
     gap; replies/notes/tools inside an exchange stay tight. */
  .messages > :global(.message.user:not(:first-child)) { margin-top: 20px; }

  /* Agent retune sweep — a dim seam crossing just the conversation pane,
     quick enough to register without demanding attention. */
  .agent-sweep {
    position: absolute;
    inset: 0;
    z-index: 6;
    overflow: hidden;
    pointer-events: none;
  }
  .agent-sweep::after {
    content: '';
    position: absolute;
    top: 0;
    left: -2px;
    width: 2px;
    height: 100%;
    background: linear-gradient(to bottom, transparent, var(--accent) 30%, var(--accent) 70%, transparent);
    opacity: 0.35;
    box-shadow: 0 0 10px var(--accent-dim);
    animation: agent-sweep 0.42s cubic-bezier(0.45, 0, 0.55, 1) forwards;
  }
  @keyframes agent-sweep {
    0%   { transform: translateX(0); }
    100% { transform: translateX(100vw); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .agent-sweep { display: none; }
  }

  /* Floating jump-back chip — appears once the reader scrolls away from the
     latest content; anchored above the composer, centered on the messages. */
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
    animation: jump-rise 0.2s ease-out;
    transition: background 0.15s, border-color 0.15s;
  }
  .jump-latest:hover { background: var(--accent-dim); border-color: var(--accent); }
  @keyframes jump-rise {
    from { opacity: 0; transform: translate(-50%, 6px); }
    to   { opacity: 1; transform: translate(-50%, 0); }
  }

  /* Quote-selection chip — floats above the selection. */
  .quote-chip {
    position: absolute;
    transform: translateX(-50%);
    z-index: 9;
    padding: 4px 11px;
    background: var(--bg-secondary);
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), 0 0 10px var(--accent-dim);
    animation: jump-rise 0.15s ease-out;
  }
  .quote-chip:hover { background: var(--accent-dim); border-color: var(--accent); }

  /* Trailing scroll room so a just-sent prompt can anchor near the top while
     its reply grows — only during an active exchange. A flex pseudo-child
     contributes to scrollHeight without inflating the box; finished
     transcripts get no phantom room. */
  .messages.has-tail:has(:global(.message))::after {
    content: '';
    display: block;
    flex: 0 0 max(320px, calc(100dvh - 260px));
    pointer-events: none;
  }

  @media (max-width: 768px) {
    .messages { padding: 14px 12px; gap: 12px; }
  }
</style>
