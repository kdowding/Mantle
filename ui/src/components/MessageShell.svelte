<script lang="ts">
  // The conversation bubble SHELL — the "transmission block" chrome shared by
  // the 1:1 chat (views/Message.svelte) and the channel room
  // (rooms/channel/ChannelMessage.svelte): the assistant header (avatar chip ·
  // name · rule · meta), the accent rail + wash, the user input-echo box, and
  // every entry/live animation. Content stays caller-authored via
  // snippets — the shell renders chrome, never message semantics.
  //
  // Per-bubble accent: pass `accent` (a hex color) and the shell scopes the
  // --agent-accent family to THIS bubble — the channel renders each speaker in
  // their own color while the 1:1 chat inherits the global cascade (theme.ts).
  import type { Snippet } from 'svelte';

  let {
    role,
    name = '',
    avatarUrl = null,
    accent = '',
    meta = '',
    live = false,
    fresh = false,
    blank = false,
    whisper = false,
    entranceOrder = null,
    dataMid = '',
    children,
    actions,
    headExtra,
  }: {
    role: 'assistant' | 'user';
    name?: string;
    avatarUrl?: string | null;
    accent?: string;
    meta?: string;
    live?: boolean;
    fresh?: boolean;
    blank?: boolean;
    // Private-aside treatment (channel whispers): dashed rail + faint hatch.
    whisper?: boolean;
    entranceOrder?: number | null;
    dataMid?: string;
    children: Snippet;
    actions?: Snippet;
    headExtra?: Snippet;
  } = $props();

  let imgFailed = $state(false);

  // Scope the accent var family to this bubble when the caller overrides it.
  const accentVars = $derived(
    accent
      ? `--agent-accent: ${accent}; ` +
        `--agent-accent-dim: color-mix(in srgb, ${accent} 10%, transparent); ` +
        `--agent-accent-glow: color-mix(in srgb, ${accent} 25%, transparent)`
      : '',
  );

  const entranceStyle = $derived(entranceOrder != null ? `--eo: ${entranceOrder}` : '');
  const styleStr = $derived([accentVars, entranceStyle].filter(Boolean).join('; '));
</script>

{#if role === 'user'}
  <div
    class="message user"
    class:fresh
    class:entrance={entranceOrder != null}
    data-mid={dataMid || undefined}
    style={styleStr || undefined}
  >
    <div class="message-body" class:whisper>
      {@render children()}
    </div>
    {@render actions?.()}
  </div>
{:else}
  <div
    class="message assistant"
    class:fresh
    class:entrance={entranceOrder != null}
    style={styleStr || undefined}
  >
    <div class="message-body" class:message-blank={blank} class:live class:whisper>
      <!-- Transmission header — tiny avatar chip + name + rule, one line.
           During an entrance this IS the minimized window's title bar. -->
      <div class="msg-head">
        {#if avatarUrl && !imgFailed}
          <img class="msg-ava" src={avatarUrl} alt="" onerror={() => (imgFailed = true)} />
        {:else}
          <span class="msg-ava msg-ava-fb">{(name || '?').charAt(0)}</span>
        {/if}
        <span class="msg-agent-name">{name}</span>
        {@render headExtra?.()}
        <span class="msg-agent-rule"></span>
        {#if meta}
          <span class="msg-meta">{meta}</span>
        {/if}
      </div>
      {@render children()}
      {@render actions?.()}
    </div>
  </div>
{/if}

<style>
  .message {
    /* The column itself (--chat-column-max) is the measure cap —
       assistant turns fill it; user turns stay narrower below. */
    max-width: 100%;
    line-height: 1.6;
    display: flex;
    gap: 12px;
  }

  /* ── Entry animations (.fresh only — replays mount instantly) ──────────────
     Assistant: TRANSMISSION DECODE — the bubble locks in from a soft
     chromatic blur while the accent rail ignites top-to-bottom and fades
     into the static border. User: UPLINK — slides in from the console side
     with a brief charge flash on the right rail. */
  .message.assistant.fresh { animation: msg-decode 0.5s cubic-bezier(0.22, 0.61, 0.36, 1); }
  @keyframes msg-decode {
    0%   { opacity: 0; transform: translateY(16px) scaleY(0.92); filter: blur(8px) saturate(2.2); }
    45%  { opacity: 1; filter: blur(1.5px) saturate(1.4); }
    100% { opacity: 1; transform: translateY(0) scaleY(1); filter: blur(0) saturate(1); }
  }
  .message.assistant.fresh .message-body::after {
    content: '';
    position: absolute;
    left: -2px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--agent-accent);
    box-shadow: 0 0 14px var(--agent-accent), 0 0 26px var(--agent-accent-glow);
    transform-origin: top;
    animation: rail-ignite 0.75s ease-out forwards;
    pointer-events: none;
  }
  @keyframes rail-ignite {
    0%   { transform: scaleY(0); opacity: 1; }
    55%  { transform: scaleY(1); opacity: 1; }
    100% { transform: scaleY(1); opacity: 0; }
  }

  .message.user.fresh { animation: msg-uplink 0.38s cubic-bezier(0.22, 0.61, 0.36, 1); }
  @keyframes msg-uplink {
    from { opacity: 0; transform: translateX(32px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  .message.user.fresh .message-body { animation: uplink-flash 0.7s ease-out; }
  @keyframes uplink-flash {
    0%   { box-shadow: inset -5px 0 22px -4px var(--accent-glow), 0 0 26px var(--accent-glow); }
    100% { box-shadow: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .message.assistant.fresh, .message.user.fresh, .message.user.fresh .message-body { animation: none; }
    .message.assistant.fresh .message-body::after { display: none; }
  }

  /* ── Session-entrance: modal-style CRT pop, in place ──────────────────────
     Each bubble powers on like the modals — a bright line at its own top
     edge snapping to full size — at its stagger slot. Pure transform/filter:
     layout never moves, the view stays planted; the typed text then grows
     the bubble downward (assistant islands start as the pop lands). */
  .message.entrance {
    transform-origin: 50% 0;
    animation: ent-pop 0.16s calc(var(--eo, 0) * 55ms) cubic-bezier(0.22, 0.61, 0.36, 1) backwards;
  }
  @keyframes ent-pop {
    0%   { opacity: 0; transform: scaleY(0.05) scaleX(0.75); filter: brightness(9) saturate(0.2); }
    45%  { opacity: 1; transform: scaleY(0.55) scaleX(1); filter: brightness(2.6); }
    100% { opacity: 1; transform: scaleY(1) scaleX(1); filter: brightness(1) saturate(1); }
  }
  /* The title bar's rule flashes accent as its window lands. */
  .message.entrance .msg-agent-rule {
    animation: win-rule 0.3s calc(var(--eo, 0) * 55ms) ease-out backwards;
  }
  @keyframes win-rule {
    from { background: linear-gradient(to right, var(--agent-accent), transparent 95%); }
    to   { background: linear-gradient(to right, var(--border-strong), transparent 85%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .message.entrance, .message.entrance .msg-agent-rule { animation: none; }
  }

  .message-body { flex: 1; min-width: 0; }

  /* ── User — a compact "input echo" of the console, right-aligned. ──────── */
  .message.user { align-self: flex-end; max-width: min(80%, 850px); }
  .message.user .message-body {
    background: var(--bg-input);
    border: 1px solid var(--accent-edge);
    border-right: 2px solid var(--accent);
    padding: 8px 14px;
    clip-path: polygon(0 0, 100% 0, 100% 100%, var(--cut-sm) 100%, 0 calc(100% - var(--cut-sm)));
    color: var(--text-primary);
  }
  /* Caller-authored action chips (edit) sit left of the right-aligned bubble. */
  .message.user :global(.msg-action) { order: -1; align-self: flex-end; margin: 0; }

  /* ── Assistant — an open transmission block: header line + accent rail +
     faint wash, no boxy full border. ─────────────────────────────────────── */
  .message.assistant { align-self: flex-start; width: 100%; }
  .message.assistant .message-body {
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--agent-accent) 4.5%, transparent), transparent 50%),
      color-mix(in srgb, var(--bg-secondary) 42%, transparent);
    border-left: 2px solid var(--agent-accent);
    padding: 9px 16px 10px 16px;
    position: relative; /* anchors the rail-ignite overlay */
  }
  /* Live turn — the rail breathes while the reply streams. */
  .message.assistant .message-body.live { animation: msg-live-edge 2.2s ease-in-out infinite; }
  @keyframes msg-live-edge {
    0%, 100% { box-shadow: inset 3px 0 10px -7px var(--agent-accent-glow); }
    50% { box-shadow: inset 3px 0 16px -5px var(--agent-accent-glow); }
  }
  @media (prefers-reduced-motion: reduce) {
    .message.assistant .message-body.live { animation: none; }
  }

  /* Blank-response state — warm amber, distinct from a real reply. */
  .message.assistant .message-body.message-blank {
    border-left-color: var(--accent-reason);
    background: linear-gradient(to right, var(--accent-reason-dim), transparent 60%);
  }

  /* Private aside (channel whisper) — dashed rail + a faint diagonal hatch:
     reads as "off the record" without dimming the content itself. */
  .message.assistant .message-body.whisper {
    border-left-style: dashed;
    background:
      repeating-linear-gradient(
        135deg,
        color-mix(in srgb, var(--agent-accent) 3%, transparent) 0 8px,
        transparent 8px 18px
      ),
      color-mix(in srgb, var(--bg-secondary) 42%, transparent);
  }
  .message.user .message-body.whisper {
    border-style: dashed;
    border-right: 2px solid var(--accent);
    background:
      repeating-linear-gradient(
        135deg,
        color-mix(in srgb, var(--accent) 4%, transparent) 0 8px,
        transparent 8px 18px
      ),
      var(--bg-input);
  }

  /* Transmission header — avatar chip · name · rule. */
  .msg-head {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 0 7px;
  }
  .msg-ava {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    object-fit: cover;
    display: block;
    clip-path: polygon(3px 0, 100% 0, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0 100%, 0 3px);
    border: 1px solid var(--agent-accent);
  }
  .msg-ava-fb {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 12px;
    color: var(--agent-accent);
    background: var(--agent-accent-dim);
  }
  .msg-agent-name {
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 600;
    color: var(--agent-accent);
    text-transform: uppercase;
    letter-spacing: 2px;
    flex-shrink: 0;
  }
  .msg-agent-rule {
    flex: 1;
    height: 1px;
    background: linear-gradient(to right, var(--border-strong), transparent 85%);
  }
  .msg-meta {
    flex-shrink: 0;
    font-family: var(--font-terminal);
    font-size: 9px;
    letter-spacing: 0.8px;
    color: var(--text-muted);
    opacity: 0.7;
    white-space: nowrap;
  }

  /* Phones — full-width turns, tighter padding. */
  @media (max-width: 640px) {
    .message { max-width: 100%; }
    .message.user { max-width: 92%; }
    .message.assistant .message-body { padding: 8px 12px 9px; }
  }
</style>
