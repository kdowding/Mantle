<!-- Inline edit affordance (no browser prompt/confirm/alert): swaps a label
     for a text input. Enter or blur commits, Escape cancels. The done-flag
     keeps Enter→blur from double-firing. -->
<script lang="ts">
  import { onMount } from 'svelte';

  let { value = '', placeholder = '', oncommit, oncancel }: {
    value?: string;
    placeholder?: string;
    oncommit: (v: string) => void;
    oncancel: () => void;
  } = $props();

  let inputEl: HTMLInputElement;
  let done = false;

  function finish(save: boolean): void {
    if (done) return;
    done = true;
    const v = inputEl.value.trim();
    if (save && v && v !== value) oncommit(v);
    else oncancel();
  }

  function onKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  }

  onMount(() => {
    inputEl.focus();
    inputEl.select();
  });
</script>

<input
  class="music-inline-input"
  type="text"
  {placeholder}
  value={value}
  bind:this={inputEl}
  onkeydown={onKeydown}
  onclick={(e) => e.stopPropagation()}
  onblur={() => finish(true)}
/>
