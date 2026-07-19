<script lang="ts">
  import type { Snippet } from 'svelte';

  // Dumb kit button — variants ported from the old kit's .mui-btn family.
  let { children, onclick, variant = 'primary', disabled = false, title }: {
    children: Snippet;
    onclick?: () => void;
    variant?: 'primary' | 'ghost' | 'danger';
    disabled?: boolean;
    title?: string;
  } = $props();
</script>

<button class="btn {variant}" type="button" {onclick} {disabled} {title}>{@render children()}</button>

<style>
  .btn {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 8px 14px;
    border: 1px solid var(--border);
    color: var(--text-primary);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
  }
  .primary { background: color-mix(in srgb, var(--accent) 16%, transparent); border-color: var(--accent); color: var(--accent); }
  .ghost { background: transparent; color: var(--text-muted); }
  .danger { background: transparent; border-color: var(--error); color: var(--error); }
  .btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .danger:hover:not(:disabled) { border-color: var(--error); color: var(--error); background: rgba(255, 45, 124, 0.15); }
  .btn:disabled { opacity: 0.45; cursor: default; }
</style>
