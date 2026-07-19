<!-- Features settings tab — turn the heavy, optional subsystems on/off after
     onboarding. Renders the same FeatureToggles the setup wizard uses, so the
     two surfaces can't drift. Refreshes the readiness snapshot on open so the
     pills are current. -->
<script lang="ts">
  import FeatureToggles from './FeatureToggles.svelte';
  import { loadConnections } from '../../lib/agents';

  void loadConnections().catch(() => {}); // fresh readiness when the tab opens
</script>

<div class="feats">
  <p class="lede">
    Mantle runs lean — enable only what you want. The heavy extras (voice, memory, local models)
    need a one-time setup; the pill says what's still missing. A process-backed feature you just
    turned on starts on the next restart.
  </p>
  <FeatureToggles />
</div>

<style>
  .feats { display: flex; flex-direction: column; gap: 16px; }
  .lede { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--text-secondary); }
</style>
