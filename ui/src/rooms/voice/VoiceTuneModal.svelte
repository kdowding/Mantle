<script lang="ts">
  // Voice tuning — the three chatterbox synthesis knobs as per-agent
  // overrides over global defaults. Test synths a preview with the CURRENT
  // slider values (no persist); Save PUTs agent.voice; Reset clears the
  // overrides. Spec: app.js wireVoiceTuneModal + /api/voice/agent/:id.
  import Modal from '../../components/Modal.svelte';
  import Button from '../../components/Button.svelte';
  import TuneSlider from '../../components/TuneSlider.svelte';
  import { ui } from '../../lib/state.svelte';
  import { updateAgent } from '../../lib/api';

  let { onclose }: { onclose: () => void } = $props();

  interface SliderDef {
    key: 'temperature' | 'cfgWeight' | 'exaggeration';
    label: string;
    min: number;
    max: number;
    step: number;
    hint: string;
  }
  const SLIDERS: SliderDef[] = [
    {
      key: 'temperature', label: 'Temperature', min: 0.4, max: 1.0, step: 0.01,
      hint: 'How willing the model is to vary its delivery. 0.5 = consistent, measured intonation. 0.7 = default, natural variation. 0.9+ = adventurous; dramatic inflection but more rare oddities.',
    },
    {
      key: 'cfgWeight', label: 'CFG Weight', min: 0.0, max: 1.2, step: 0.05,
      hint: 'Speaker conditioning strength: how strongly the model anchors to your reference voice vs its training prior. 0.0 = no anchoring (accent can drift). 0.5 = balanced. 1.0 = strong fidelity to the reference clip.',
    },
    {
      key: 'exaggeration', label: 'Exaggeration', min: 0.0, max: 1.0, step: 0.05,
      hint: 'Emotion intensity baked into the speaker conditioning. 0.2-0.3 = flat, even-keeled. 0.5 = default, natural prosody. 0.7-0.9 = expressive, animated, emotionally varied.',
    },
  ];

  let values = $state<Record<string, number>>({ temperature: 0.7, cfgWeight: 0.5, exaggeration: 0.5 });
  let defaults = $state<Record<string, number> | null>(null);
  let sample = $state('The quick brown fox jumps over the lazy dog. How does this sound to you?');
  let status = $state('');
  let statusKind = $state<'' | 'error' | 'pending'>('');
  let busy = $state(false);

  let testAudio: HTMLAudioElement | null = null;
  function stopTestAudio(): void {
    if (testAudio) {
      try { testAudio.pause(); } catch { /* noop */ }
      try { URL.revokeObjectURL(testAudio.src); } catch { /* noop */ }
      testAudio = null;
    }
  }

  function setStatus(text: string, kind: '' | 'error' | 'pending' = ''): void {
    status = text;
    statusKind = kind;
  }

  function close(): void {
    stopTestAudio();
    onclose();
  }

  const stepDecimals = (step: number): number => (String(step).split('.')[1] || '').length;
  const round = (v: number, step: number): number => Number(v.toFixed(stepDecimals(step)));
  const isModified = (d: SliderDef): boolean =>
    defaults?.[d.key] !== undefined && Math.abs(round(values[d.key], d.step) - defaults[d.key]) > d.step / 2;

  // Populate from the agent's saved overrides over global defaults.
  $effect(() => {
    const agentId = ui.currentAgentId;
    if (!agentId) return;
    void (async () => {
      try {
        const r = await fetch(`/api/voice/agent/${encodeURIComponent(agentId)}`);
        if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
        const data = (await r.json()) as { defaults: Record<string, number>; overrides?: Record<string, number> };
        defaults = data.defaults;
        for (const d of SLIDERS) values[d.key] = data.overrides?.[d.key] ?? data.defaults[d.key] ?? d.min;
      } catch (e) {
        setStatus(`Couldn't load voice config: ${e instanceof Error ? e.message : e}`, 'error');
      }
    })();
  });

  function readParams(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of SLIDERS) out[d.key] = round(values[d.key], d.step);
    return out;
  }

  async function test(): Promise<void> {
    stopTestAudio();
    const text = sample.trim();
    if (!text) { setStatus('Sample text is empty', 'error'); return; }
    setStatus('Synthesizing…', 'pending');
    busy = true;
    try {
      const r = await fetch('/api/voice/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: ui.currentAgentId, sample: text, params: readParams() }),
      });
      if (!r.ok) {
        let detail = `${r.status} ${r.statusText}`;
        try { const j = (await r.json()) as { error?: string }; if (j?.error) detail = j.error; } catch { /* not json */ }
        throw new Error(detail);
      }
      const blob = await r.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      testAudio = audio;
      audio.onended = () => setStatus('Done.');
      void audio.play();
      setStatus('Playing preview…');
    } catch (e) {
      setStatus(`Synth failed: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      busy = false;
    }
  }

  async function save(): Promise<void> {
    const agentId = ui.currentAgentId;
    if (!agentId) return;
    busy = true;
    setStatus('Saving…', 'pending');
    try {
      await updateAgent(agentId, { voice: readParams() });
      setStatus('Saved. Takes effect on the next reply.');
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      busy = false;
    }
  }

  async function reset(): Promise<void> {
    const agentId = ui.currentAgentId;
    if (!agentId) return;
    busy = true;
    setStatus('Resetting…', 'pending');
    try {
      await updateAgent(agentId, { voice: null });
      for (const d of SLIDERS) values[d.key] = defaults?.[d.key] ?? d.min;
      setStatus('Reset to global defaults.');
    } catch (e) {
      setStatus(`Reset failed: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      busy = false;
    }
  }
</script>

<Modal open title="Voice Tuning" size="md" onclose={close}>
  <div class="form">
    {#each SLIDERS as d (d.key)}
      <TuneSlider bind:value={values[d.key]} label={d.label} min={d.min} max={d.max} step={d.step} hint={d.hint} modified={isModified(d)} />
    {/each}

    <label class="field">
      <span>Sample text</span>
      <textarea rows="2" bind:value={sample}></textarea>
    </label>

    {#if status}
      <div class="status" class:error={statusKind === 'error'} class:pending={statusKind === 'pending'}>{status}</div>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => void reset()} disabled={busy}>Reset</Button>
    <span class="spacer"></span>
    <Button variant="ghost" onclick={() => void test()} disabled={busy}>▶ Test</Button>
    <Button variant="primary" onclick={() => void save()} disabled={busy}>Save</Button>
  {/snippet}
</Modal>

<style>
  /* Sliders come from the shared TuneSlider kit component. */
  .status { font-size: 13px; color: var(--text-secondary); }
  .status.error { color: var(--error); }
  .status.pending { color: var(--warning); }

  .spacer { flex: 1; }
</style>
