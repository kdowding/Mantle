<script lang="ts">
  // Composer replacement for call-mode sessions: their transcript replays as
  // normal bubbles, but the way to continue one is to call back in — the
  // server prefills the new xAI conversation from the session's JSONL.
  import { sessions, chat } from '../../lib/state.svelte';
  import { call, startCall } from './call.svelte';

  const meta = $derived(sessions.list.find((s) => s.id === chat.sessionId));
</script>

<div class="resume-bar">
  <span class="hint">
    This is a voice-call session{meta?.callVoice ? ` · voice: ${meta.callVoice}` : ''}
  </span>
  <button
    class="resume-btn"
    type="button"
    disabled={call.active}
    onclick={() => chat.sessionId && void startCall({ resumeSessionId: chat.sessionId, resumeVoice: meta?.callVoice ?? 'ara' })}
  >✆ Resume call</button>
</div>

<style>
  .resume-bar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 24px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
  }
  .hint { flex: 1; font-size: 13px; color: var(--text-muted); }
  .resume-btn {
    padding: 8px 18px;
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: background 0.15s, box-shadow 0.15s;
  }
  .resume-btn:hover:not(:disabled) { background: var(--accent-dim); box-shadow: 0 0 10px var(--accent-glow); }
  .resume-btn:disabled { opacity: 0.4; cursor: default; }
</style>
