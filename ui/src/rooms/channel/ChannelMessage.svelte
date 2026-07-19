<script lang="ts">
  // One channel row, rendered on the SHARED bubble shell (MessageShell) so the
  // channel reads exactly like the 1:1 chat: agent rows are accent-railed
  // transmission blocks (avatar chip · name · clock) in the speaker's OWN
  // color, user rows are the right-aligned input echo (mention pills kept),
  // system rows stay a dim centered notice.
  import { untrack } from 'svelte';
  import MessageShell from '../../components/MessageShell.svelte';
  import { avatarSrc } from '../../lib/state.svelte';
  import { islandFor, participants, agentById, agentName, type ChannelMsg } from './channel.svelte';
  import LiveText from './LiveText.svelte';
  import StaticAgentText from './StaticAgentText.svelte';
  import ReactionBar from './ReactionBar.svelte';

  let { msg }: { msg: ChannelMsg } = $props();

  // Copy — live bubbles mirror their deltas onto msg.text, complete once the
  // speaker ends (the reveal clock may still be draining; the text isn't).
  const canCopy = $derived(
    msg.kind === 'agent' && !msg.typing && !msg.error && (!msg.live || !!msg.done) && msg.text.trim().length > 0,
  );
  let copied = $state(false);
  function copyText(): void {
    void navigator.clipboard.writeText(msg.text).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1200);
    });
  }

  // Private aside: the row carries its whisper scope (agent ids).
  const isWhisper = $derived((msg.whisper?.length ?? 0) > 0);
  const whisperLabel = $derived((msg.whisper ?? []).map((id) => agentName(id)).join(' + '));

  // Author accent: the row's own stamp first (survives a purged agent), then
  // the live roster. Empty = the shell inherits the global cascade.
  const accent = $derived(msg.accent || agentById(msg.agentId)?.accentColor || '');
  // Real avatar when the roster says one exists; the shell falls back to the
  // initials chip on a load error (and for purged/avatar-less agents).
  const avatarUrl = $derived(
    msg.agentId && agentById(msg.agentId)?.hasAvatar
      ? avatarSrc(msg.agentId)
      : null,
  );

  // Live bubbles decode in; replayed transcript mounts instantly (1:1 parity).
  // Init-only on purpose (untrack): freshness is decided at mount.
  const fresh = untrack(() => msg.live);

  function fmtTime(ts?: string): string {
    const d = ts ? new Date(ts) : new Date();
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // User text split into text/pill segments (declarative — no DOM walking).
  interface Seg { pill: boolean; text: string; accent?: string }
  const segments = $derived.by<Seg[]>(() => {
    if (msg.kind !== 'user') return [];
    const parts = participants();
    const re = /(^|\s)@([A-Za-z0-9][A-Za-z0-9_-]*)/g;
    const out: Seg[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(msg.text)) !== null) {
      const token = m[2].toLowerCase();
      const a = parts.find((p) => p.id.toLowerCase() === token || p.name.toLowerCase() === token);
      if (!a) continue;
      const start = m.index + m[1].length;
      if (start > last) out.push({ pill: false, text: msg.text.slice(last, start) });
      out.push({ pill: true, text: `@${a.name}`, accent: a.accent });
      last = re.lastIndex;
    }
    if (last < msg.text.length) out.push({ pill: false, text: msg.text.slice(last) });
    return out;
  });
</script>

{#if msg.kind === 'system'}
  <div class="row-system">{msg.text}</div>
{:else if msg.kind === 'user'}
  <MessageShell role="user" {fresh} whisper={isWhisper}>
    {#if isWhisper}
      <div class="aside-tag">⌐ aside → {whisperLabel}</div>
    {/if}
    <div class="user-text">
      {#each segments as s, i (i)}
        {#if s.pill}<span class="pill" style:--pill-accent={s.accent}>{s.text}</span>{:else}{s.text}{/if}
      {/each}
    </div>
    <ReactionBar {msg} />
  </MessageShell>
{:else}
  <MessageShell
    role="assistant"
    {accent}
    name={msg.name ?? '?'}
    {avatarUrl}
    meta={fmtTime(msg.timestamp)}
    live={msg.live}
    blank={msg.blank}
    {fresh}
    whisper={isWhisper}
  >
    {#snippet headExtra()}
      {#if isWhisper}
        <span class="aside-chip" title="Private aside - only you + {whisperLabel} can see this">aside</span>
      {/if}
    {/snippet}
    {#if msg.tools.length > 0}
      <!-- Tool activity (recall / web lookup) — compact chips, chronologically
           above the reply they fed. -->
      <div class="tool-chips">
        {#each msg.tools as t (t.id)}
          <span class="tchip" class:run={t.status === 'run'} class:terr={t.status === 'err'}>
            <span class="ti">{t.status === 'run' ? '◌' : t.status === 'err' ? '✕' : '✓'}</span>
            {t.label ?? t.name}
          </span>
        {/each}
      </div>
    {/if}
    {#if msg.typing}
      <span class="typing" aria-label="{msg.name} is typing"><span></span><span></span><span></span></span>
    {:else if msg.live}
      <LiveText island={islandFor(msg)} />
    {:else}
      <StaticAgentText text={msg.text} />
    {/if}
    {#if msg.error}<div class="err">{msg.error}</div>{/if}
    {#if msg.blank}<div class="blank-note">No response - try again.</div>{/if}
    <ReactionBar {msg} />
    {#snippet actions()}
      {#if canCopy}
        <div class="msg-actions">
          <button
            class="msg-action"
            class:playing={copied}
            type="button"
            title="Copy reply text"
            onclick={copyText}
          >{copied ? '✓ copied' : '⧉ copy'}</button>
        </div>
      {/if}
    {/snippet}
  </MessageShell>
{/if}

<style>
  .row-system {
    align-self: center;
    max-width: 70%;
    color: var(--text-muted);
    font-size: 13px;
    text-align: center;
    padding: 2px 0;
    white-space: pre-line;
  }

  .pill {
    display: inline-block;
    padding: 0 6px;
    border: 1px solid var(--pill-accent, var(--accent));
    color: var(--pill-accent, var(--accent));
    background: color-mix(in srgb, var(--pill-accent, var(--accent)) 10%, transparent);
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 0.5px;
  }

  .typing { display: inline-flex; gap: 4px; padding: 4px 0; }
  .typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
    animation: typing-bounce 1.2s ease-in-out infinite;
  }
  .typing span:nth-child(2) { animation-delay: 0.15s; }
  .typing span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes typing-bounce {
    0%, 60%, 100% { opacity: 0.35; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-3px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .typing span { animation: none; }
  }

  .tool-chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 6px; }
  .tchip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 1px 8px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .tchip .ti { color: var(--agent-accent); font-size: 9px; }
  .tchip.run .ti { animation: tchip-spin 1s linear infinite; display: inline-block; }
  .tchip.terr { border-color: color-mix(in srgb, var(--error) 40%, transparent); }
  .tchip.terr .ti { color: var(--error); }
  @keyframes tchip-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .tchip.run .ti { animation: none; }
  }

  .aside-chip {
    flex-shrink: 0;
    padding: 0 6px;
    border: 1px dashed var(--agent-accent);
    color: var(--agent-accent);
    font-family: var(--font-display);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    opacity: 0.8;
  }
  .aside-tag {
    font-family: var(--font-display);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--accent);
    opacity: 0.75;
    margin-bottom: 3px;
  }

  .err { color: var(--error); font-size: 12.5px; margin-top: 4px; }
  .blank-note {
    color: var(--text-muted);
    font-style: italic;
    font-size: 13px;
    margin-top: 4px;
  }
</style>
