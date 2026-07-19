<script lang="ts">
  // Provider + model select pair from the live backend catalog. Renders a
  // form-kit `.row`, so it must sit inside a `.form` container (all consumers do).
  import { serverConfig } from '../lib/state.svelte';

  let { provider = $bindable(''), model = $bindable(''), placeholder = 'Use global default', modelPlaceholder = 'Provider default' }: {
    provider?: string;
    model?: string;
    placeholder?: string;
    modelPlaceholder?: string;
  } = $props();

  const providers = $derived(serverConfig.backends.filter((b) => b.configured));
  const models = $derived(serverConfig.backends.find((b) => b.id === provider)?.models ?? []);
</script>

<div class="row">
  <label class="field">
    <span>Provider</span>
    <select bind:value={provider} onchange={() => (model = '')}>
      <option value="">{placeholder}</option>
      {#each providers as b (b.id)}
        <option value={b.id}>{b.label}</option>
      {/each}
    </select>
  </label>
  <label class="field">
    <span>Model</span>
    <select bind:value={model}>
      <option value="">{modelPlaceholder}</option>
      {#each models as m (m)}
        <option value={m}>{m}</option>
      {/each}
    </select>
  </label>
</div>
