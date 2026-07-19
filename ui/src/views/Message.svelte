<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { ui, serverConfig, prefs, type ChatMessage } from '../lib/state.svelte';
  import { retryTurn, editLastTurn } from '../lib/ws';
  import { selectBackend } from '../lib/inference';
  import { fmtClock, fmtTokens, fmtDuration } from '../lib/format';
  import { voice, replay, replayMessage, messageReplayText } from '../rooms/voice/voice.svelte'; // [room] voice replay
  import MessageShell from '../components/MessageShell.svelte';
  import StreamingText from '../components/StreamingText.svelte';
  import ThinkingBlock from '../components/ThinkingBlock.svelte';
  import ToolCalls from '../components/ToolCalls.svelte';
  import Attachments from '../components/Attachments.svelte';
  import Popover from '../components/Popover.svelte';

  // showRetry/showEdit surface on the LAST assistant / user message only
  // (Chat.svelte decides) — retry re-runs the reply, edit reloads the prompt.
  let { message, showRetry = false, showEdit = false }: {
    message: ChatMessage;
    showRetry?: boolean;
    showEdit?: boolean;
  } = $props();

  // [room] voice replay: speaker chip on every finalized assistant bubble
  // whenever playback is possible (warm chatterbox or xAI) — the toggle's
  // on/off only governs new replies; replay is a different intent.
  const canRetry = $derived(showRetry && !message.voiceLive);
  const canReplay = $derived(
    message.role === 'assistant' && !message.streaming && !message.voiceLive && !message.blank
    && ((voice.sidecarReady && voice.ttsLoaded) || voice.xaiAvailable)
    && messageReplayText(message).length > 0,
  );
  const replayPlaying = $derived(replay.msgId === message.id);

  // Copy — live runs mirror their source onto part.raw (the island owns the
  // DOM); replay parts carry .text. Joined like the voice replay does.
  const copySource = $derived(
    message.parts
      .filter((p) => p.kind === 'text')
      .map((p) => (p.kind === 'text' ? (p.raw ?? p.text ?? '') : ''))
      .join('\n\n')
      .trim(),
  );
  const canCopy = $derived(message.role === 'assistant' && !message.streaming && copySource.length > 0);
  let copied = $state(false);
  function copyMessage(): void {
    if (!copySource) return;
    void navigator.clipboard.writeText(copySource).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1200);
    });
  }

  // 2a is single-agent live chat, so the assistant identity is the current
  // agent's profile (falling back to the agent roster). Per-message identity
  // for transcript replay / channel comes with those increments.
  const agentName = $derived(
    ui.profile?.name ?? ui.agents.find((a) => a.id === ui.currentAgentId)?.name ?? '',
  );
  const avatarUrl = $derived(ui.profile?.avatarUrl ?? null);

  // Entry animations run only on FRESH messages (just created — live sends
  // and replies). Replayed transcripts mount instantly: fifty bubbles
  // decode-flashing at once is a wall, and the blur pass × N isn't free.
  // Init-only on purpose (untrack): freshness is decided at mount.
  const fresh = untrack(() => (Date.now() - (message.ts ?? 0)) < 3000);

  // Session-entrance is a ONE-TIME show: animate the pop + typewriter only on
  // the first mount. entranceConsumed (stamped in onMount) makes a remount —
  // returning from the systems/channel stage swap, which unmounts Chat —
  // render the bubble statically instead of replaying the pop or blanking its
  // island text. Init-only via untrack, mirroring `fresh`.
  const showEntrance = untrack(() => message.entranceOrder != null && !message.entranceConsumed);
  onMount(() => { if (showEntrance) message.entranceConsumed = true; });

  // Header meta — clock always (when known); tokens/speed/duration are
  // live-turn only (transcripts don't store usage).
  const metaBits = $derived.by(() => {
    const bits: string[] = [];
    const clock = fmtClock(message.ts);
    if (clock) bits.push(clock);
    if (message.usage?.out) bits.push(`${fmtTokens(message.usage.out)} tok`);
    if (message.usage?.tokPerSec) bits.push(`${Math.round(message.usage.tokPerSec)} t/s`);
    if (message.durationMs && message.durationMs > 500) bits.push(fmtDuration(message.durationMs));
    return bits;
  });

  // Retry-with-backend — pick a different configured backend for the re-run.
  let retryPickOpen = $state(false);
  const retryBackends = $derived(serverConfig.backends.filter((b) => b.configured));
  function retryWith(backendId: string): void {
    retryPickOpen = false;
    if (backendId !== prefs.backendId) selectBackend(backendId);
    void retryTurn();
  }

  // Compaction's synthetic user message ('[Prior conversation context,
  // compacted]\n\n<summary>') renders as a divider, not a bubble that reads
  // as something the user typed. Click to read the summary it carries.
  const COMPACTION_PREFIX = '[Prior conversation context, compacted]';
  const isCompaction = $derived(message.role === 'user' && message.text.startsWith(COMPACTION_PREFIX));
  const compactionSummary = $derived(isCompaction ? message.text.slice(COMPACTION_PREFIX.length).trim() : '');
  let compactionOpen = $state(false);
  let deliveryOpen = $state(false);
</script>

{#if message.divider}
  <div class="message new-divider" aria-label="New messages since your last visit">
    <span class="nd-line"></span>
    <span class="nd-label">new since you left</span>
    <span class="nd-line"></span>
  </div>
{:else if message.origin === 'delivery'}
  <div class="message delivery">
    <button class="comp-row" type="button" title="A background/cron task delivered this while you were away" onclick={() => (deliveryOpen = !deliveryOpen)}>
      <span class="comp-line dl"></span>
      <span class="comp-label dl">⌁ background delivery {deliveryOpen ? '▾' : '▸'}</span>
      <span class="comp-line dl"></span>
    </button>
    {#if deliveryOpen}
      <div class="comp-summary dl">{message.text}</div>
    {/if}
  </div>
{:else if isCompaction}
  <div class="message compaction">
    <button class="comp-row" type="button" title="Older messages were summarized to keep the context inside the window" onclick={() => (compactionOpen = !compactionOpen)}>
      <span class="comp-line"></span>
      <span class="comp-label">⌁ context compacted {compactionOpen ? '▾' : '▸'}</span>
      <span class="comp-line"></span>
    </button>
    {#if compactionOpen}
      <div class="comp-summary">{compactionSummary}</div>
    {/if}
  </div>
{:else if message.origin === 'note'}
  <div class="message note" class:queued={message.noteState === 'queued'}>
    <span class="note-chip">{message.noteState === 'queued' ? 'note · queued' : 'note'}</span>
    <span class="note-text">{message.text}</span>
  </div>
{:else if message.role === 'user'}
  <MessageShell role="user" {fresh} entranceOrder={showEntrance ? (message.entranceOrder ?? null) : null} dataMid={message.id}>
    {#if message.attachments.length > 0}<Attachments items={message.attachments} />{/if}
    {#if message.text}<div class="user-text">{message.text}</div>{/if}
    {#snippet actions()}
      {#if showEdit}
        <button class="msg-action" type="button" title="Edit and resend this prompt" onclick={editLastTurn}>✎ edit</button>
      {/if}
    {/snippet}
  </MessageShell>
{:else if message.role === 'system'}
  <div class="message system" class:error={message.error}>
    <div class="system-note">{message.text}</div>
  </div>
{:else}
  <MessageShell
    role="assistant"
    name={agentName}
    {avatarUrl}
    meta={metaBits.join(' · ')}
    live={message.streaming}
    blank={message.blank}
    {fresh}
    entranceOrder={showEntrance ? (message.entranceOrder ?? null) : null}
  >
    {#each message.parts as part (part.id)}
      {#if part.kind === 'thinking'}
        <ThinkingBlock {part} />
      {:else}
        <StreamingText streaming={part.active} text={part.text} island={part.island} ghost={part.ghost} entrance={showEntrance} />
      {/if}
    {/each}
    {#if message.attachments.length > 0}
      <Attachments items={message.attachments} />
    {/if}
    {#if message.tools.length > 0}
      <ToolCalls {message} />
    {/if}
    {#if message.blank}
      <div class="blank-response-note">No response - try again.</div>
    {/if}
    {#if message.voiceLive}
      <!-- Voice room contract: audio still draining for this turn. -->
      <div class="voice-responding">
        <span class="vr-dot"></span><span class="vr-dot"></span><span class="vr-dot"></span>
        <span class="vr-label">Responding</span>
      </div>
    {/if}
    {#snippet actions()}
      {#if canCopy || canReplay || canRetry}
        <div class="msg-actions">
          {#if canCopy}
            <button
              class="msg-action"
              class:playing={copied}
              type="button"
              title="Copy reply text"
              onclick={copyMessage}
            >{copied ? '✓ copied' : '⧉ copy'}</button>
          {/if}
          {#if canReplay}
            <button
              class="msg-action"
              class:playing={replayPlaying}
              type="button"
              title={replayPlaying ? 'Stop playback' : 'Replay voice'}
              onclick={() => void replayMessage(message)}
            >{replayPlaying ? '■ stop' : '♬ voice'}</button>
          {/if}
          {#if canRetry}
            <button class="msg-action" type="button" title="Re-run this response" onclick={() => void retryTurn()}>↻ retry</button>
            <Popover bind:open={retryPickOpen} up width={210}>
              {#snippet trigger({ toggle })}
                <button class="msg-action" type="button" title="Re-run on a different backend" onclick={toggle}>▾</button>
              {/snippet}
              <div class="rp-section">retry with</div>
              {#each retryBackends as b (b.id)}
                <button class="rp-row" class:active={b.id === prefs.backendId} type="button" onclick={() => retryWith(b.id)}>
                  {b.label}
                </button>
              {/each}
            </Popover>
          {/if}
        </div>
      {/if}
    {/snippet}
  </MessageShell>
{/if}

<style>
  /* The bubble chrome (user/assistant) lives in components/MessageShell — the
     styles below cover the seam/notice rows this view still authors itself. */
  .message {
    max-width: 100%;
    line-height: 1.6;
    display: flex;
    gap: 12px;
  }

  .blank-response-note {
    color: var(--text-muted);
    font-style: italic;
    font-size: 13px;
    margin-top: 4px;
  }

  /* Retry-with-backend popover rows. */
  .rp-section {
    font-family: var(--font-display);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-muted);
    padding: 4px 8px 3px;
  }
  .rp-row {
    display: block;
    width: 100%;
    padding: 6px 9px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: var(--text-primary);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .rp-row:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .rp-row.active { color: var(--accent); border-left-color: var(--accent); background: var(--accent-faint); }

  /* Steer-while-busy note — compact, amber-edged, sits inside the turn flow.
     Queued = dimmed until the loop's note_delivered confirms the fold-in. */
  .message.note {
    align-self: flex-end;
    align-items: baseline;
    gap: 8px;
    max-width: 70%;
    padding: 5px 12px;
    background: rgba(255, 184, 77, 0.04);
    border: 1px solid rgba(255, 184, 77, 0.18);
    border-right: 2px solid var(--accent-reason);
    transition: opacity 0.3s;
  }
  .message.note.queued { opacity: 0.55; }
  .note-chip {
    flex-shrink: 0;
    font-family: var(--font-display);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--accent-reason);
  }
  .note-text {
    font-size: 13px;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    min-width: 0;
  }

  /* Voice playback indicator — three soft pulsing dots while audio drains. */
  .voice-responding {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 8px;
  }
  .vr-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--agent-accent);
    animation: vr-pulse 1.2s ease-in-out infinite;
  }
  .vr-dot:nth-child(2) { animation-delay: 0.2s; }
  .vr-dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes vr-pulse {
    0%, 100% { opacity: 0.25; transform: scale(0.85); }
    50% { opacity: 1; transform: scale(1); }
  }
  .vr-label {
    margin-left: 5px;
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-muted);
  }

  /* Compaction divider — a quiet seam in the conversation; expands to the
     summary that replaced the compacted turns. */
  .message.compaction { max-width: 100%; width: 100%; display: block; }
  .comp-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 2px 0;
  }
  .comp-line { flex: 1; height: 1px; background: linear-gradient(to right, transparent, var(--accent-reason-dim) 30%, var(--accent-reason-dim) 70%, transparent); }
  .comp-label {
    flex-shrink: 0;
    font-family: var(--font-terminal);
    font-size: 9.5px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent-reason);
    opacity: 0.75;
    transition: opacity 0.15s;
  }
  .comp-row:hover .comp-label { opacity: 1; }
  .comp-summary {
    margin: 6px auto 2px;
    max-width: 640px;
    padding: 8px 14px;
    border-left: 2px solid var(--accent-reason);
    background: var(--accent-reason-dim);
    color: var(--text-secondary);
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre-wrap;
  }

  /* "New since you left" divider — accent seam at the unread boundary. */
  .message.new-divider {
    max-width: 100%;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 2px 0;
  }
  .nd-line { flex: 1; height: 1px; background: linear-gradient(to right, transparent, var(--accent-edge) 30%, var(--accent-edge) 70%, transparent); }
  .nd-label {
    flex-shrink: 0;
    font-family: var(--font-terminal);
    font-size: 9.5px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--accent);
    text-shadow: 0 0 8px var(--accent-glow);
  }

  /* Background-delivery seam — teal variant of the compaction row. */
  .message.delivery { max-width: 100%; width: 100%; display: block; }
  .comp-line.dl { background: linear-gradient(to right, transparent, var(--accent-dim) 30%, var(--accent-dim) 70%, transparent); }
  .comp-label.dl { color: var(--accent); }
  .comp-summary.dl {
    border-left-color: var(--accent);
    background: var(--accent-faint);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  /* System / error notice — centered, muted. */
  .message.system {
    align-self: center;
    max-width: 70%;
  }
  .system-note {
    color: var(--text-muted);
    font-size: 13px;
    text-align: center;
    white-space: pre-line; /* /help and /status notes are multiline */
  }
  .message.system.error .system-note { color: var(--error); }
</style>
