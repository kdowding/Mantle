<script lang="ts">
  // Labeled tuning slider: label + live value readout, range input, hint
  // text, and a modified-vs-default highlight. Promoted on its second
  // consumer (voice tune → local-model sampling).
  let { value = $bindable(0), label, min, max, step, hint = '', modified = false }: {
    value?: number;
    label: string;
    min: number;
    max: number;
    step: number;
    hint?: string;
    modified?: boolean;
  } = $props();

  const decimals = $derived((String(step).split('.')[1] || '').length);
  const shown = $derived(Number(value.toFixed(decimals)).toFixed(decimals));
</script>

<div class="slider" class:modified>
  <div class="s-row">
    <span class="s-label">{label}</span>
    <span class="s-value">{shown}</span>
  </div>
  <input type="range" {min} {max} {step} bind:value />
  {#if hint}<div class="hint">{hint}</div>{/if}
</div>

<style>
  .slider { display: flex; flex-direction: column; gap: 4px; }

  .s-row { display: flex; justify-content: space-between; align-items: baseline; }
  .s-label {
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-muted);
  }
  .slider.modified .s-label { color: var(--accent); }
  .s-value { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }

  input[type='range'] { width: 100%; accent-color: var(--accent); }

  .hint { font-size: 10px; color: var(--text-muted); }
</style>
