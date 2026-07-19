<script lang="ts">
  // Reasoning block. Svelte owns the shell + collapse/status reactively; the
  // .thinking-content node's children are written imperatively by the reasoning
  // island (lib/reasoning.ts) — Svelte must not manage them.
  import { onMount } from 'svelte';
  import { prefs, type ThinkingPart } from '../lib/state.svelte';
  import { attachThinking } from '../lib/reasoning';

  let { part }: { part: ThinkingPart } = $props();
  let content: HTMLDivElement;

  onMount(() => {
    // Replay: content is known → populate instantly (no per-char fade).
    // Live: attach to the reasoning island.
    if (part.text != null) content.textContent = part.text;
    else attachThinking(content);
  });

  function toggle(): void {
    part.collapsed = !part.collapsed;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  }
</script>

<div class="thinking-block" class:streaming={part.status === 'streaming'} class:complete={part.status === 'done'} class:reasoning-hidden={!prefs.showReasoning}>
  <div class="thinking-header" role="button" tabindex="0" onclick={toggle} onkeydown={onKey}>
    <span class="thinking-toggle-icon" class:open={!part.collapsed}>▸</span>
    <span class="thinking-title">Reasoning</span>
    <span class="thinking-status">
      {#if part.status === 'streaming'}Thinking<span class="thinking-dots"></span>
      {:else if part.durationSec > 0}Thought for {part.durationSec}s
      {:else}Thought{/if}
    </span>
  </div>
  <div class="thinking-body" class:open={!part.collapsed}>
    <div class="thinking-fade-mask">
      <!-- island-owned: no children expression -->
      <div class="thinking-content" bind:this={content}></div>
    </div>
  </div>
</div>

<style>
  .thinking-block {
    margin: 4px 0 8px;
    background: rgba(255, 184, 77, 0.03);
    border: 1px solid rgba(255, 184, 77, 0.14);
    border-left: 2px solid var(--accent-reason);
    overflow: hidden;
    transition: background 0.4s ease, border-color 0.4s ease;
  }
  /* Reasoning-display toggle (profile bar ◉) hides blocks but keeps their
     content mounted, so flipping it back reveals what was thought. */
  .thinking-block.reasoning-hidden { display: none; }
  .thinking-block.streaming {
    background: rgba(255, 184, 77, 0.05);
    border-left-color: rgba(255, 184, 77, 0.9);
    box-shadow: inset 2px 0 8px -2px rgba(255, 184, 77, 0.28);
    animation: thinking-pulse 2.4s ease-in-out infinite;
  }
  @keyframes thinking-pulse {
    0%, 100% { box-shadow: inset 2px 0 8px -2px rgba(255, 184, 77, 0.22); }
    50%      { box-shadow: inset 2px 0 12px -2px rgba(255, 184, 77, 0.50); }
  }

  .thinking-header {
    padding: 4px 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 500;
    color: var(--accent-reason);
    user-select: none;
    letter-spacing: 0.5px;
    opacity: 0.8;
    transition: opacity 0.15s;
  }
  .thinking-block.streaming .thinking-header { opacity: 0.95; }
  .thinking-header:hover { opacity: 1; }

  .thinking-toggle-icon { font-size: 9px; transition: transform 0.15s; color: var(--accent-reason); }
  .thinking-toggle-icon.open { transform: rotate(90deg); }
  .thinking-title { text-transform: uppercase; letter-spacing: 1.5px; }

  .thinking-status {
    margin-left: auto;
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    opacity: 0.75;
    color: var(--accent-reason);
  }
  .thinking-block.complete .thinking-status { opacity: 0.5; }

  .thinking-dots::after {
    content: '';
    display: inline-block;
    width: 1ch;
    text-align: left;
    animation: thinking-dots 1.4s steps(4, end) infinite;
  }
  @keyframes thinking-dots {
    0%   { content: ''; }
    25%  { content: '.'; }
    50%  { content: '..'; }
    75%  { content: '...'; }
    100% { content: ''; }
  }

  .thinking-body { display: none; padding: 0 10px 8px; }
  .thinking-body.open { display: block; }

  .thinking-fade-mask {
    max-height: 220px;
    overflow-y: auto;
    scroll-behavior: smooth;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 24px, black calc(100% - 8px), transparent 100%);
            mask-image: linear-gradient(to bottom, transparent 0, black 24px, black calc(100% - 8px), transparent 100%);
    transition: max-height 0.3s ease;
  }
  .thinking-block.complete .thinking-fade-mask {
    max-height: 300px;
    -webkit-mask-image: none;
            mask-image: none;
  }

  .thinking-content {
    font-family: var(--font-sans);
    font-size: 12px;
    color: #c8c1ad;
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.55;
  }
</style>
