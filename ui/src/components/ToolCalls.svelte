<script lang="ts">
  // The bottom tool-calls container — collapsible "Tools (N)" header + summary +
  // pending pulse, with the per-tool blocks inside. Closed by default; the
  // open/closed state is sticky (the user owns it).
  import type { ChatMessage } from '../lib/state.svelte';
  import ToolCallItem from './ToolCall.svelte';

  let { message }: { message: ChatMessage } = $props();

  const tools = $derived(message.tools);
  const summary = $derived.by(() => {
    const names = [...new Set(tools.map((t) => t.name))];
    return names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  });
  const pending = $derived(tools.some((t) => t.status === 'pending'));

  function toggle(): void {
    message.toolsOpen = !message.toolsOpen;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  }
</script>

<div class="tool-calls-container">
  <div class="tool-calls-header" class:pending role="button" tabindex="0" onclick={toggle} onkeydown={onKey}>
    <span class="tool-calls-toggle" class:open={message.toolsOpen}>▸</span>
    <span class="tool-calls-label">Tools</span>
    <span class="tool-calls-count">({tools.length})</span>
    <span class="tool-calls-summary">{summary}</span>
  </div>
  <div class="tool-calls-list" class:open={message.toolsOpen}>
    {#each tools as tool (tool.id)}
      <ToolCallItem {tool} />
    {/each}
  </div>
</div>

<style>
  .tool-calls-container { margin-top: 6px; }

  .tool-calls-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    cursor: pointer;
    user-select: none;
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    background: rgba(8, 8, 14, 0.3);
    transition: color 0.15s;
    letter-spacing: 0.5px;
  }
  .tool-calls-header:hover { color: var(--text-secondary); }
  .tool-calls-header.pending {
    border-left-color: var(--warning);
    animation: tools-pending 1.8s ease-in-out infinite;
  }
  @keyframes tools-pending {
    0%, 100% { box-shadow: inset 2px 0 8px -4px rgba(255, 170, 0, 0.25); }
    50% { box-shadow: inset 2px 0 12px -3px rgba(255, 170, 0, 0.5); }
  }
  @media (prefers-reduced-motion: reduce) {
    .tool-calls-header.pending { animation: none; }
  }

  .tool-calls-toggle { font-size: 9px; transition: transform 0.15s; color: var(--accent); }
  .tool-calls-toggle.open { transform: rotate(90deg); }

  .tool-calls-label { text-transform: uppercase; letter-spacing: 1px; }
  .tool-calls-count { color: var(--text-muted); font-family: var(--font-mono); font-size: 10px; }
  .tool-calls-summary {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }

  .tool-calls-list { display: none; }
  .tool-calls-list.open { display: block; }
</style>
