<script lang="ts">
  // One tool-call block — collapsible, status-colored. Fully reactive: re-renders
  // from the ToolCall state as start/input/executing/progress/result land.
  import type { ToolCall } from '../lib/state.svelte';

  let { tool }: { tool: ToolCall } = $props();

  function toggle(): void {
    tool.collapsed = !tool.collapsed;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  }

  // Live "Ns" elapsed counter while executing (ported from tool_call_executing).
  // First tick at 1s, so sub-second tools jump straight to done/error.
  let elapsed = $state(0);
  $effect(() => {
    if (tool.status !== 'pending' || !tool.startedAt) {
      elapsed = 0;
      return;
    }
    const t = setInterval(() => {
      elapsed = Math.floor((Date.now() - tool.startedAt) / 1000);
    }, 1000);
    return () => clearInterval(t);
  });

  const inputJson = $derived(tool.input != null ? JSON.stringify(tool.input, null, 2) : 'loading…');
  const statusText = $derived(
    tool.status === 'success' ? 'done'
      : tool.status === 'error' ? 'error'
        : elapsed > 0 ? `${elapsed}s` : '',
  );
</script>

<div class="tool-call" class:pending={tool.status === 'pending'} class:success={tool.status === 'success'} class:error={tool.status === 'error'}>
  <div class="tool-call-header" role="button" tabindex="0" onclick={toggle} onkeydown={onKey}>
    <span class="tool-call-toggle" class:open={!tool.collapsed}>▸</span>
    <span class="tool-call-name">{tool.name}</span>
    {#if tool.label}<span class="tool-call-label">{tool.label}</span>{/if}
    {#if tool.tag}<span class="tool-call-tag">{tool.tag}</span>{/if}
    {#if tool.status === 'pending' && elapsed === 0}<span class="spinner"></span>{/if}
    <span class="tool-call-status">{statusText}</span>
  </div>
  <div class="tool-call-body" class:open={!tool.collapsed}>
    <div class="tool-call-section">
      <div class="tool-call-section-label">Input</div>
      <pre class="tool-input-content">{inputJson}</pre>
    </div>
    {#if tool.output}
      <div class="tool-call-section tool-call-output">
        <div class="tool-call-section-label">{tool.status === 'pending' ? 'Live output' : 'Output'}</div>
        <pre class="tool-output-content" class:streaming={tool.status === 'pending'}>{tool.output}</pre>
      </div>
    {/if}
    {#if tool.result != null}
      <div class="tool-call-section">
        <div class="tool-call-section-label">Result</div>
        <pre>{tool.result}</pre>
      </div>
    {/if}
  </div>
</div>

<style>
  .tool-call {
    margin: 6px 0 6px 8px;
    background: rgba(8, 8, 14, 0.4);
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    overflow: hidden;
    position: relative;
  }
  .tool-call.success { border-left-color: var(--success); }
  .tool-call.error { border-left-color: var(--error); }
  .tool-call.pending { border-left-color: var(--warning); }

  .tool-call.pending::after {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: var(--warning);
    opacity: 0.5;
    animation: tool-scan 2s linear infinite;
  }
  @keyframes tool-scan {
    0%   { top: 0; opacity: 0.5; }
    100% { top: 100%; opacity: 0; }
  }

  .tool-call-header {
    padding: 4px 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 500;
    color: var(--text-secondary);
    user-select: none;
    transition: background 0.15s;
    letter-spacing: 0.5px;
  }
  .tool-call-header:hover { background: var(--bg-panel); }

  .tool-call-toggle { font-size: 9px; transition: transform 0.15s; color: var(--accent); }
  .tool-call-toggle.open { transform: rotate(90deg); }

  .tool-call-name {
    font-family: var(--font-display);
    font-weight: 600;
    color: var(--text-primary);
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 1px;
  }
  .tool-call-name::before {
    content: '\25B8';
    margin-right: 4px;
    color: var(--accent);
    font-size: 10px;
  }

  .tool-call-status {
    margin-left: auto;
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .tool-call.success .tool-call-status { color: var(--success); }
  .tool-call.error .tool-call-status { color: var(--error); }
  .tool-call-status::before {
    content: '';
    display: inline-block;
    width: 5px;
    height: 5px;
    margin-right: 4px;
    vertical-align: middle;
  }
  .tool-call.success .tool-call-status::before { background: var(--success); }
  .tool-call.error .tool-call-status::before { background: var(--error); }
  .tool-call.pending .tool-call-status::before { background: var(--warning); }

  .tool-call-label {
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-muted);
    opacity: 0.8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
    min-width: 0;
  }
  .tool-call-tag {
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-muted);
    opacity: 0.8;
    padding: 0 6px;
    white-space: nowrap;
  }
  .tool-call.error .tool-call-tag { color: var(--error); }

  .tool-call-body { display: none; padding: 0 12px 10px; }
  .tool-call-body.open { display: block; }

  .tool-call-section { margin-top: 6px; }
  .tool-call-section-label {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 4px;
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: 1.5px;
  }
  .tool-call-section pre {
    background: rgba(8, 8, 14, 0.9);
    border: 1px solid var(--border);
    padding: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
    max-height: 300px;
    overflow-y: auto;
  }
  .tool-call-output .tool-call-section-label { color: var(--accent); }
  .tool-output-content.streaming { border-left: 2px solid var(--accent); }

  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 1.5px solid var(--border-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
