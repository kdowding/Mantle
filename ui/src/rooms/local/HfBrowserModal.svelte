<script lang="ts">
  // HuggingFace model browser — the master-detail "add model" overlay from
  // ui/local.js: live trending landing, debounced search, quick-pick chips
  // (topics + @authors with a sticky author scope), sort tabs, client-side
  // size/type filters, compact result rows → full detail pane, the polled
  // download tray, and a paste-a-spec fallback.
  import { onMount } from 'svelte';
  import Modal from '../../components/Modal.svelte';
  import Button from '../../components/Button.svelte';
  import HfDetailPane from './HfDetailPane.svelte';
  import {
    hf, runSearch, showLanding, enterAuthor, clearAuthorScope, openDetail,
    filteredResults, installedRepos, startPull, resumeTrayIfPulling, stopPullPoll,
    authorOf, repoOf, paramSize, fmtCount, fmtBytes, quickFit,
    QUICK_PICKS, POPULAR_AUTHORS,
    type HfSort, type HfSizeFilter, type HfTypeFilter, type PullJob,
  } from './hf.svelte';

  let { onclose }: { onclose: () => void } = $props();

  let specInput = $state('');
  let noTools = $state(false);
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const SORTS: Array<[HfSort, string]> = [['trending', 'Trending'], ['downloads', 'Downloads'], ['likes', 'Likes'], ['updated', 'Updated']];
  const SIZES: Array<[HfSizeFilter, string]> = [['all', 'Any size'], ['small', '<8B'], ['mid', '8-30B'], ['large', '>30B'], ['fit', 'Fits my GPU']];
  const TYPES: Array<[HfTypeFilter, string]> = [['all', 'All'], ['text', 'Text'], ['vision', 'Vision'], ['code', 'Code']];

  const results = $derived(filteredResults());
  const installed = $derived(installedRepos());

  onMount(() => {
    showLanding(); // straight into the live trending feed
    void resumeTrayIfPulling();
    return () => {
      if (debounce) clearTimeout(debounce);
      stopPullPoll(); // tray polling resumes on next open if still pulling
    };
  });

  function onSearchInput(): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void runSearch(), 350);
  }
  function onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      if (debounce) clearTimeout(debounce);
      void runSearch();
    }
  }
  function pickTopic(t: string): void {
    clearAuthorScope();
    hf.query = t;
    void runSearch();
  }
  function setSort(s: HfSort): void {
    hf.sort = s;
    void runSearch();
  }

  function jobMeta(j: PullJob): string {
    const p = j.progress ?? {};
    if (j.status === 'done') return `done${p.totalBytes ? ' · ' + fmtBytes(p.totalBytes) : ''}`;
    if (j.status === 'error') return j.error ?? 'failed';
    if (j.status === 'queued') return 'queued';
    if (p.phase === 'downloading') {
      const pct = p.totalBytes ? ((p.receivedBytes ?? 0) / p.totalBytes) * 100 : 0;
      const part = (p.fileCount ?? 1) > 1 ? `[${p.fileIndex}/${p.fileCount}] ` : '';
      return `${part}${p.totalBytes ? pct.toFixed(0) + '% · ' : ''}${fmtBytes(p.receivedBytes ?? 0)}${p.totalBytes ? ' / ' + fmtBytes(p.totalBytes) : ''} · ${fmtBytes(p.speedBytesPerSec ?? 0)}/s`;
    }
    if (p.phase === 'registering') return 'registering…';
    return 'resolving…';
  }
  function jobPct(j: PullJob): number {
    const p = j.progress ?? {};
    if (p.phase === 'registering') return 100;
    return p.totalBytes ? ((p.receivedBytes ?? 0) / p.totalBytes) * 100 : 0;
  }
</script>

<Modal open title="Add Model - HuggingFace" size="xl" tall onclose={onclose}>
  <div class="browser">
    <div class="topbar">
      <input
        class="search"
        type="text"
        bind:value={hf.query}
        placeholder={hf.author ? `Filter ${hf.author}'s models - type to narrow, or clear for all` : 'Search GGUF models - name, family, size…'}
        oninput={onSearchInput}
        onkeydown={onSearchKey}
      />
      <div class="chips">
        {#each QUICK_PICKS as t (t)}
          <button class="chip" type="button" onclick={() => pickTopic(t)}>{t}</button>
        {/each}
        <span class="chip-sep"></span>
        {#each POPULAR_AUTHORS as a (a)}
          <button class="chip" type="button" onclick={() => void enterAuthor(a)}>@{a}</button>
        {/each}
      </div>
      <div class="controls">
        <div class="ctl-group">
          {#each SORTS as [k, label] (k)}
            <button class="ctl" class:active={hf.sort === k} type="button" onclick={() => setSort(k)}>{label}</button>
          {/each}
        </div>
        <div class="ctl-group">
          {#each SIZES as [k, label] (k)}
            <button class="ctl" class:active={hf.fsize === k} type="button" onclick={() => (hf.fsize = k)}>{label}</button>
          {/each}
        </div>
        <div class="ctl-group">
          {#each TYPES as [k, label] (k)}
            <button class="ctl" class:active={hf.ftype === k} type="button" onclick={() => (hf.ftype = k)}>{label}</button>
          {/each}
        </div>
      </div>
      {#if hf.authorInfo}
        <div class="author-head">
          {#if hf.authorInfo.avatarUrl}
            <img class="a-avatar" src={hf.authorInfo.avatarUrl} alt="" />
          {:else}
            <div class="a-avatar letter">{(hf.authorInfo.name[0] || '?').toUpperCase()}</div>
          {/if}
          <div class="a-info">
            <div class="a-name">{hf.authorInfo.name}</div>
            <div class="a-sub">
              {[
                hf.authorInfo.fullname && hf.authorInfo.fullname !== hf.authorInfo.name ? hf.authorInfo.fullname : null,
                hf.authorInfo.numModels != null ? `${hf.authorInfo.numModels.toLocaleString()} models` : null,
                hf.authorInfo.type === 'org' ? 'organization' : null,
              ].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button class="a-back" type="button" onclick={showLanding}>← back</button>
        </div>
      {/if}
    </div>

    <div class="split">
      <div class="results">
        {#if hf.loading && !results.length}
          <div class="note">searching HuggingFace…</div>
        {:else if hf.error}
          <div class="note err">search failed: {hf.error}</div>
        {:else if !results.length}
          <div class="note">{hf.results.length ? 'nothing matches these filters.' : 'no GGUF models found - try a different search.'}</div>
        {/if}
        {#each results as m (m.id)}
          {@const fit = quickFit(m.id)}
          <button class="li" class:selected={m.id === hf.selectedRepo} type="button" onclick={() => void openDetail(m.id)}>
            <div class="li-avatar">{(authorOf(m.id)[0] || '?').toUpperCase()}</div>
            <div class="li-main">
              <div class="li-name">
                {#if fit}<span class="li-dot {fit.cls}" title="~{fit.label} on your GPU at Q4"></span>{/if}
                <span class="li-repo">{repoOf(m.id)}</span>
              </div>
              <div class="li-sub">
                <span class="li-author">{authorOf(m.id)}</span>
                {#if paramSize(m.id)}<span class="li-size">{paramSize(m.id)}</span>{/if}
                <span class="li-dl">↓ {fmtCount(m.downloads)}</span>
              </div>
            </div>
            {#if installed.has(m.id)}<span class="li-installed" title="already installed">✓</span>{/if}
          </button>
        {/each}
        {#if hf.nextCursor && results.length}
          <button class="loadmore" type="button" disabled={hf.loading} onclick={() => void runSearch(true)}>
            {hf.loading ? 'loading…' : 'Load more'}
          </button>
        {/if}
      </div>

      <div class="detail">
        {#if hf.detailLoading}
          <div class="note">loading {hf.selectedRepo}…</div>
        {:else if hf.detailError}
          <div class="note err">couldn't load model: {hf.detailError}</div>
        {:else if hf.detail}
          {#key hf.detail.id}
            <HfDetailPane detail={hf.detail} />
          {/key}
        {:else}
          <div class="note">Select a model to see its card, specs &amp; quants - no need to open HuggingFace.</div>
        {/if}
      </div>
    </div>

    {#if hf.jobs.length}
      <div class="tray">
        {#each hf.jobs as j (j.id)}
          <div class="job is-{j.status}">
            <div class="job-head">
              <span class="job-ic">{j.status === 'done' ? '✓' : j.status === 'error' ? '✗' : j.status === 'queued' ? '⋯' : '↓'}</span>
              <span class="job-name">{j.status === 'done' ? (j.modelId ?? j.spec) : j.spec}</span>
              <span class="job-meta">{jobMeta(j)}</span>
            </div>
            {#if j.status === 'active'}
              <div class="job-bar"><div class="job-fill" style="width: {jobPct(j).toFixed(1)}%"></div></div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <div class="specrow">
      <input class="spec-input" type="text" bind:value={specInput} placeholder="…or paste org/repo:QUANT or a huggingface.co URL"
        onkeydown={(e) => { if (e.key === 'Enter' && specInput.trim()) void startPull(specInput.trim(), { noTools }); }} />
      <label class="check"><input type="checkbox" bind:checked={noTools} /><span>no tools</span></label>
      <Button variant="ghost" disabled={!specInput.trim()} onclick={() => void startPull(specInput.trim(), { noTools })}>Pull</Button>
    </div>
    {#if hf.trayMsg}<div class="traymsg {hf.trayMsgKind}">{hf.trayMsg}</div>{/if}
  </div>
</Modal>

<style>
  .browser { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; }

  .topbar { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
  .search {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-bottom: 2px solid var(--text-muted);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 14px;
  }
  .search:focus { outline: none; border-bottom-color: var(--accent); }

  .chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .chip {
    padding: 2px 9px;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .chip:hover { border-color: var(--accent); color: var(--accent); }
  .chip-sep { width: 1px; height: 14px; background: var(--border-strong); margin: 0 4px; }

  .controls { display: flex; flex-wrap: wrap; gap: 12px; }
  .ctl-group { display: flex; gap: 2px; }
  .ctl {
    padding: 3px 9px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .ctl:hover { color: var(--text-secondary); }
  .ctl.active { border-color: var(--accent); color: var(--accent); background: var(--accent-faint); }

  .author-head { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
  .a-avatar { width: 32px; height: 32px; object-fit: cover; }
  .a-avatar.letter {
    display: grid;
    place-items: center;
    background: var(--accent-dim);
    color: var(--accent);
    font-family: var(--font-display);
    font-weight: 700;
  }
  .a-info { flex: 1; min-width: 0; }
  .a-name { font-family: var(--font-display); font-weight: 600; color: var(--text-primary); }
  .a-sub { font-size: 12px; color: var(--text-muted); }
  .a-back {
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
  }
  .a-back:hover { border-color: var(--accent); color: var(--accent); }

  .split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(260px, 1fr) 1.6fr;
    gap: 12px;
  }
  .results { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 3px; padding-right: 4px; }
  .detail { overflow-y: auto; min-height: 0; border-left: 1px solid var(--border); padding-left: 14px; }

  .note { color: var(--text-muted); font-size: 13px; padding: 10px 4px; }
  .note.err { color: var(--error); }

  .li {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-left: 2px solid transparent;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .li:hover { background: var(--bg-tertiary); }
  .li.selected { background: var(--accent-faint); border-color: var(--accent-edge); border-left-color: var(--accent); }
  .li-avatar {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
  }
  .li-main { flex: 1; min-width: 0; }
  .li-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .li-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .li-dot.fits { background: var(--success); }
  .li-dot.tight { background: var(--warning); }
  .li-dot.toobig { background: var(--error); }
  .li-repo { font-size: 13px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .li-sub { display: flex; gap: 8px; font-size: 12px; color: var(--text-muted); margin-top: 1px; }
  .li-size { color: var(--accent); }
  .li-installed { color: var(--success); flex-shrink: 0; }

  .loadmore {
    margin-top: 4px;
    padding: 6px;
    background: transparent;
    border: 1px dashed var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
  }
  .loadmore:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }

  .tray { flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; max-height: 120px; overflow-y: auto; }
  .job { padding: 5px 8px; border: 1px solid var(--border); border-left: 2px solid var(--border-strong); }
  .job.is-done { border-left-color: var(--success); }
  .job.is-error { border-left-color: var(--error); }
  .job.is-active { border-left-color: var(--accent); }
  .job-head { display: flex; align-items: center; gap: 8px; }
  .job-ic { flex-shrink: 0; font-size: 12px; color: var(--text-muted); }
  .is-done .job-ic { color: var(--success); }
  .is-error .job-ic { color: var(--error); }
  .job-name { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .job-meta { font-size: 12px; color: var(--text-muted); flex-shrink: 0; }
  .job-bar { height: 3px; background: var(--bg-tertiary); margin-top: 4px; overflow: hidden; }
  .job-fill { height: 100%; background: var(--accent); box-shadow: 0 0 6px var(--accent-glow); transition: width 0.4s ease; }

  .specrow { flex-shrink: 0; display: flex; align-items: center; gap: 10px; }
  .spec-input {
    flex: 1;
    padding: 6px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .spec-input:focus { outline: none; border-color: var(--accent); }
  .check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); cursor: pointer; flex-shrink: 0; }
  .check input { accent-color: var(--accent); }

  .traymsg { font-size: 13px; color: var(--text-secondary); flex-shrink: 0; }
  .traymsg.ok { color: var(--success); }
  .traymsg.error { color: var(--error); }
</style>
