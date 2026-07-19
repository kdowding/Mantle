<script lang="ts">
  // Small slider switch — promoted on its second consumer (cron job enable,
  // workspace section toggles). Props-only; the caller owns the state.
  let { checked = false, onchange, label = '', disabled = false }: {
    checked?: boolean;
    onchange: (value: boolean) => void;
    label?: string;
    disabled?: boolean;
  } = $props();
</script>

<button
  class="switch"
  class:on={checked}
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  title={label}
  {disabled}
  onclick={() => onchange(!checked)}
><span class="knob"></span></button>

<style>
  .switch {
    width: 26px;
    height: 14px;
    flex-shrink: 0;
    position: relative;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    cursor: pointer;
    padding: 0;
    transition: background 0.15s, border-color 0.15s;
  }
  .switch.on { background: var(--accent-dim); border-color: var(--accent); }
  .switch:disabled { opacity: 0.4; cursor: default; }
  .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 10px;
    height: 10px;
    background: var(--text-muted);
    transition: transform 0.15s, background 0.15s;
  }
  .switch.on .knob { transform: translateX(12px); background: var(--accent); box-shadow: 0 0 5px var(--accent-glow); }
</style>
