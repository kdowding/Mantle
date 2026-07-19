<!-- Generate form — the Suno generation recipe (agent, title, style prompt,
     optional lineage + lyrics). Stays mounted and hides via [hidden] so typed
     values survive a close/reopen (the vanilla player's behavior). -->
<script lang="ts">
  import { music, agentName, generateTrack } from './music.svelte';
  import { ICON } from './icons';

  let agentId = $state('');
  let title = $state('');
  let style = $state('');
  let basedOnRaw = $state('');
  let instrumental = $state(true);
  let lyrics = $state('');
  let msg = $state('');

  const agentOpts = $derived(
    music.agents.length ? music.agents : Object.keys(music.library).map((id) => ({ id, name: id })),
  );
  // "Based on" lists every existing track (value = "agentId::title") so a new
  // track can record a lineage link to one it riffs on.
  const basedOnOpts = $derived(
    Object.keys(music.library).sort().flatMap((aid) =>
      (music.library[aid] ?? []).map((s) => ({ value: `${aid}::${s.title}`, label: `${s.title} - ${agentName(aid)}` })),
    ),
  );

  // Seed/heal the agent select once options exist (or its pick disappears).
  $effect(() => {
    if (agentOpts.length && !agentOpts.some((a) => a.id === agentId)) agentId = agentOpts[0].id;
  });

  async function submit(): Promise<void> {
    const t = title.trim(), st = style.trim(), ly = lyrics.trim();
    const sep = basedOnRaw.indexOf('::');
    const basedOnAgentId = sep === -1 ? undefined : basedOnRaw.slice(0, sep);
    const basedOn = sep === -1 ? undefined : basedOnRaw.slice(sep + 2);
    if (!agentId) { msg = 'Pick an agent.'; return; }
    if (!t) { msg = 'Title required.'; return; }
    if (!st) { msg = 'Style required.'; return; }
    if (!instrumental && !ly) { msg = 'Lyrics required for a vocal track.'; return; }
    msg = 'Starting…';
    try {
      await generateTrack({
        agentId, title: t, style: st, instrumental,
        lyrics: instrumental ? undefined : ly,
        basedOn, basedOnAgentId,
      });
      msg = "Generating - it'll appear here in a few minutes.";
      title = '';
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div class="music-genform" hidden={!music.genFormOpen}>
  <div class="music-gf-head">
    <span class="music-gf-title">Generate Track</span>
    <button class="music-gf-close" type="button" title="Close" onclick={() => (music.genFormOpen = false)}>{@html ICON.close}</button>
  </div>
  <div class="music-gf-row">
    <label for="mgf-agent">Agent</label>
    <select id="mgf-agent" bind:value={agentId}>
      {#each agentOpts as a (a.id)}
        <option value={a.id}>{a.name}</option>
      {/each}
    </select>
  </div>
  <div class="music-gf-row">
    <label for="mgf-title">Title</label>
    <input id="mgf-title" type="text" placeholder="Track title" bind:value={title} />
  </div>
  <div class="music-gf-row">
    <label for="mgf-style">Style</label>
    <textarea id="mgf-style" rows="2" placeholder="genre, mood, instrumentation, tempo, production…" bind:value={style}></textarea>
  </div>
  <div class="music-gf-row">
    <label for="mgf-basedon">Based on <span class="music-gf-opt">(optional)</span></label>
    <select id="mgf-basedon" bind:value={basedOnRaw}>
      <option value="">- none -</option>
      {#each basedOnOpts as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
  </div>
  <label class="music-gf-check"><input type="checkbox" bind:checked={instrumental} /> Instrumental</label>
  {#if !instrumental}
    <div class="music-gf-row">
      <label for="mgf-lyrics">Lyrics</label>
      <textarea id="mgf-lyrics" rows="3" placeholder="exact lyrics to sing" bind:value={lyrics}></textarea>
    </div>
  {/if}
  <div class="music-gf-actions">
    <span class="music-gf-msg">{msg}</span>
    <button class="music-gf-go" type="button" onclick={() => void submit()}>Generate</button>
  </div>
</div>

<style>
  .music-genform {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-tertiary);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* The [hidden] attr must beat the display:flex above, or the form can't be
     dismissed (an author display:flex overrides the UA [hidden] = display:none). */
  .music-genform[hidden] { display: none; }
  .music-gf-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
  .music-gf-title {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .music-gf-close {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    line-height: 1;
    font-size: 15px;
    cursor: pointer;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
    transition: color 0.15s, border-color 0.15s;
  }
  .music-gf-close:hover { color: var(--accent-pink); border-color: var(--accent-pink); }
  .music-gf-row { display: flex; flex-direction: column; gap: 3px; }
  .music-gf-row label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
  .music-gf-opt { text-transform: none; letter-spacing: 0; opacity: 0.75; }
  .music-genform input[type="text"],
  .music-genform textarea,
  .music-genform select {
    width: 100%;
    padding: 6px 8px;
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text-primary);
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    resize: vertical;
  }
  .music-genform input:focus,
  .music-genform textarea:focus,
  .music-genform select:focus { outline: none; border-color: var(--accent-edge); }
  .music-gf-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); cursor: pointer; }
  .music-gf-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .music-gf-msg { font-size: 10px; color: var(--text-muted); flex: 1; }
  .music-gf-go {
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 6px 14px;
    cursor: pointer;
    color: var(--bg-primary);
    background: var(--accent);
    border: none;
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
  }
  .music-gf-go:hover { box-shadow: 0 0 14px var(--accent-glow); }
</style>
