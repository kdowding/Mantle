<script lang="ts">
  // Personality tab of the systems deck — the home for an agent's persona files
  // (AGENTS / IDENTITY / SOUL / USER / MEMORY / CALL). Left: the fixed file list
  // with missing-file warnings + create-from-template. Right: an editor with a
  // [sections | raw] view switch (sections = toggle ## blocks on/off, the same
  // control the quick modal offers; raw = edit the markdown) plus the assist
  // Cursor-diff for the open file. Mirrors SkillsDeck; assist edits multiple
  // files via stage_workspace_edit (kind 'workspace').
  import { ui } from '../../lib/state.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import InlineDiff from '../../components/InlineDiff.svelte';
  import { confirmDialog } from '../../components/confirm.svelte';
  import Modal from '../../components/Modal.svelte';
  import PromptPreview from '../workspace/PromptPreview.svelte';
  import { loadPreview } from '../workspace/workspace.svelte';
  import { assist, setAssistTarget, discardOpen } from '../assist/assist.svelte';
  import {
    personality, personalityView, setPersonalityView,
    loadPersonalityFiles, readPersonalityFile, writePersonalityFile,
    togglePersonalitySection, createPersonalityFile, PERSONALITY_FILE_META,
  } from './personality.svelte';
  import type { WfFile } from '../../lib/workspace-files';

  const agentName = $derived(ui.agents.find((a) => a.id === ui.currentAgentId)?.name ?? '');

  // ── Editor state ───────────────────────────────────────────────────────────
  let selected = $state<string | null>(null);
  let fileData = $state<WfFile | null>(null);
  let content = $state('');
  let savedContent = $state('');
  let expanded = $state<Set<string>>(new Set());
  let loadErr = $state<string | null>(null);
  let saveErr = $state<string | null>(null);
  let saving = $state(false);
  let savedFlash = $state(false);
  const dirty = $derived(content !== savedContent);

  const meta = $derived(PERSONALITY_FILE_META.find((m) => m.name === selected) ?? null);
  const summary = $derived(personality.files.find((f) => f.name === selected) ?? null);
  const toggleable = $derived(summary?.toggleable ?? false);
  const exists = $derived(fileData?.exists ?? false);

  // The open file's staged assist edit, rendered as an inline Cursor diff in
  // place of the editor (accept → buffer, you still Save).
  const openFile = $derived(assist.changeset.find((c) => c.id === 'open') ?? null);

  // System-prompt preview modal — reuses the workspace preview fetcher,
  // force-refreshed on open so it reflects section toggles made in this tab.
  let showPrompt = $state(false);
  function openPrompt(): void {
    showPrompt = true;
    void loadPreview(true);
  }

  // Load the list + auto-open the first file on mount / agent switch.
  $effect(() => {
    const id = ui.currentAgentId;
    selected = null; fileData = null; content = ''; savedContent = '';
    void (async () => {
      await loadPersonalityFiles();
      if (ui.currentAgentId === id && !selected) {
        const first = PERSONALITY_FILE_META[0].name;
        selected = first;
        await openFileByName(first);
      }
    })();
  });

  // Register the assist target for the OPEN file (cleanup passes null). The
  // agent edits the open file via propose_edit (→ buffer) and OTHER personality
  // files via stage_workspace_edit (→ disk through applyExternal + list reload).
  $effect(() => {
    if (selected) {
      const file = selected;
      setAssistTarget({
        kind: 'workspace',
        label: file,
        getContent: () => content,
        apply: (c) => { content = c; },
        ref: { file },
        applyExternal: async (r, c) => {
          const f = 'file' in r ? r.file : '';
          if (!f) return;
          await writePersonalityFile(f, c);
          await loadPersonalityFiles();
          if (f === selected) await openFileByName(f); // agent wrote the open file
        },
      });
    } else {
      setAssistTarget(null);
    }
    return () => setAssistTarget(null);
  });

  async function openFileByName(name: string): Promise<void> {
    loadErr = null; saveErr = null;
    try {
      const data = await readPersonalityFile(name);
      if (selected !== name) return; // superseded by a faster switch
      fileData = data;
      content = data.content;
      savedContent = data.content;
      // View mode is sticky (personalityView) — don't reset it per file. The
      // render falls back to raw for non-toggleable / section-less / missing
      // files on its own, so honoring the user's chosen mode here is safe.
    } catch (e) {
      if (selected === name) loadErr = e instanceof Error ? e.message : String(e);
    }
  }

  async function select(name: string): Promise<void> {
    if (name === selected) return;
    if (dirty && !(await confirmDiscard())) return;
    selected = name;
    fileData = null; content = ''; savedContent = '';
    expanded = new Set();
    await openFileByName(name);
  }

  function confirmDiscard(): Promise<boolean> {
    return confirmDialog({
      title: 'Discard changes',
      message: 'This file has unsaved edits. Discard them?',
      confirmText: 'Discard',
      danger: true,
    });
  }

  async function save(): Promise<void> {
    if (!selected || saving || !dirty) return;
    saving = true; saveErr = null;
    try {
      await writePersonalityFile(selected, content);
      savedContent = content;
      savedFlash = true;
      setTimeout(() => (savedFlash = false), 1200);
      await loadPersonalityFiles();
      await openFileByName(selected); // refresh sections / exists / mtime
    } catch (e) {
      saveErr = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function createFromTemplate(): Promise<void> {
    if (!selected) return;
    saveErr = null;
    try {
      const data = await createPersonalityFile(selected);
      if (selected !== data.name) return;
      fileData = data;
      content = data.content;
      savedContent = data.content;
      await loadPersonalityFiles();
    } catch (e) {
      saveErr = e instanceof Error ? e.message : String(e);
    }
  }

  function toggleExpand(h: string): void {
    const next = new Set(expanded);
    if (next.has(h)) next.delete(h);
    else next.add(h);
    expanded = next;
  }

  async function onToggleSection(heading: string, enabled: boolean): Promise<void> {
    if (!selected || !fileData) return;
    const s = fileData.sections.find((x) => x.heading === heading);
    if (s) s.enabled = enabled;
    await togglePersonalitySection(selected, heading, enabled);
    void loadPersonalityFiles(); // refresh the row badge
  }

  function onEditorKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      void save();
    }
  }

  // List-row status badge: missing, or sections-on/total for toggleable files.
  function rowStatus(name: string): { missing: boolean; badge: string } {
    const f = personality.files.find((x) => x.name === name);
    if (!f || !f.exists) return { missing: true, badge: '' };
    if (f.toggleable && f.sections.length > 0) {
      const on = f.sections.filter((s) => s.enabled).length;
      return { missing: false, badge: `${on}/${f.sections.length}` };
    }
    return { missing: false, badge: '' };
  }
</script>

<div class="pers-deck">
  <div class="list-col">
    <div class="lc-head">
      <span class="lc-label">personality · {agentName}</span>
      <button class="lc-prompt" type="button" title="View the assembled system prompt" onclick={openPrompt}>⊞ prompt</button>
    </div>
    {#each PERSONALITY_FILE_META as m (m.name)}
      {@const st = rowStatus(m.name)}
      <button
        class="prow"
        class:active={selected === m.name}
        class:missing={st.missing}
        type="button"
        onclick={() => void select(m.name)}
      >
        <span class="prow-head">
          <span class="prow-name">{m.label}</span>
          <span class="prow-file">{m.name}</span>
          {#if st.missing}<span class="prow-badge warn">missing</span>{:else if st.badge}<span class="prow-badge">{st.badge}</span>{/if}
        </span>
        <span class="prow-blurb">{m.blurb}</span>
      </button>
    {/each}
  </div>

  <div class="edit-col">
    {#if !selected}
      <div class="ed-empty">
        <div class="ee-mark">◈</div>
        <div>Pick a file to read or shape it.</div>
        <div class="ee-sub">These are {agentName || 'the agent'}'s personality files. Ask ✦ assist to help draft or revise any of them - changes stage as a diff you accept and save.</div>
      </div>
    {:else}
      <div class="ed-head">
        <span class="ed-name">{meta?.label ?? selected}</span>
        <span class="ed-chip dim">{selected}</span>
        {#if !exists}<span class="ed-chip warn">missing</span>{/if}
        <span class="ed-actions">
          {#if exists && toggleable && !openFile}
            <span class="view-switch">
              <button class="vs-btn" class:active={personalityView.mode === 'sections'} type="button" onclick={() => setPersonalityView('sections')}>sections</button>
              <button class="vs-btn" class:active={personalityView.mode === 'raw'} type="button" onclick={() => setPersonalityView('raw')}>raw</button>
            </span>
          {/if}
          {#if exists}
            <button class="deck-save" class:flash={savedFlash} type="button" disabled={!dirty || saving} onclick={() => void save()}>
              {savedFlash ? '✓ saved' : saving ? 'saving…' : 'save'}
            </button>
          {/if}
        </span>
      </div>
      {#if meta}<div class="ed-blurb">{meta.blurb}</div>{/if}

      {#if loadErr}
        <div class="ed-err">{loadErr}</div>
      {:else if openFile}
        <!-- Assist staged an edit to the open file — review it inline (Cursor
             model). Accept writes the editor buffer; you still Save to persist. -->
        <InlineDiff
          baseline={openFile.baseline}
          proposed={openFile.content}
          fileLabel={openFile.label}
          kindLabel={openFile.isNew ? 'new' : 'edit'}
          note={openFile.note}
          stale={content !== openFile.baseline}
          onResolve={(c) => { content = c; discardOpen(); }}
          onDiscard={() => discardOpen()}
        />
      {:else if !exists}
        <div class="ed-missing">
          <div class="em-mark">⚠</div>
          <div class="em-msg">{selected} doesn't exist yet</div>
          <div class="em-sub">Create it from the template (the same one new agents get), then shape it - or ask ✦ assist to draft it from scratch.</div>
          <button class="em-create" type="button" onclick={() => void createFromTemplate()}>+ create from template</button>
          {#if saveErr}<div class="ed-err">{saveErr}</div>{/if}
        </div>
      {:else if personalityView.mode === 'sections' && toggleable}
        {#if fileData && fileData.sections.length > 0}
          <div class="sections">
            {#each fileData.sections as s (s.heading)}
              <div class="section" class:off={!s.enabled}>
                <div class="s-header">
                  <button class="s-expand" type="button" onclick={() => toggleExpand(s.heading)}>
                    <span class="chev" class:open={expanded.has(s.heading)}>▸</span>
                    <span class="s-heading">{s.heading}</span>
                  </button>
                  <Toggle
                    checked={s.enabled}
                    label={s.enabled ? 'On - included in the system prompt' : 'Off - stripped from the system prompt'}
                    onchange={(v) => void onToggleSection(s.heading, v)}
                  />
                </div>
                {#if expanded.has(s.heading)}<pre class="s-body">{s.body}</pre>{/if}
              </div>
            {/each}
          </div>
          <div class="ed-foot">Toggling a section strips it from the prompt on the agent's next message · switch to <button class="lnk" type="button" onclick={() => setPersonalityView('raw')}>raw</button> to edit the text</div>
        {:else}
          <div class="ed-note">
            No <code>##</code> sections yet - the whole file passes through.
            Switch to <button class="lnk" type="button" onclick={() => setPersonalityView('raw')}>raw</button> to add <code>## headings</code> you can toggle.
          </div>
        {/if}
      {:else}
        <textarea class="ed-text" bind:value={content} spellcheck="false" onkeydown={onEditorKey}></textarea>
        {#if saveErr}<div class="ed-err">{saveErr}</div>{/if}
        <div class="ed-foot">
          ctrl+s saves · edits go live on the agent's next message{#if toggleable} · each <code>## heading</code> becomes a toggleable section{/if}
        </div>
      {/if}
    {/if}
  </div>
</div>

{#if showPrompt}
  <Modal open title="System prompt: {agentName}" size="lg" tall onclose={() => (showPrompt = false)}>
    <PromptPreview />
  </Modal>
{/if}

<style>
  .pers-deck {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 18px;
  }

  /* ── List column ───────────────────────────────────────────────────────── */
  .list-col {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-right: 4px;
    border-right: 1px solid var(--border);
  }
  .lc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px 6px; flex-shrink: 0; }
  .lc-prompt {
    flex-shrink: 0;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 9.5px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .lc-prompt:hover { color: var(--accent); border-color: var(--accent-edge); }
  .lc-label {
    font-family: var(--font-terminal);
    font-size: 10.5px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent);
    opacity: 0.85;
  }

  .prow {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 9px 11px;
    background: transparent;
    border: 1px solid transparent;
    border-left: 2px solid transparent;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.12s, border-color 0.12s;
  }
  .prow:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .prow.active { background: var(--accent-faint); border-color: var(--accent-edge); border-left-color: var(--accent); }
  .prow.missing .prow-name { color: var(--text-muted); }
  .prow-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .prow-name {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 14px;
    letter-spacing: 0.4px;
  }
  .prow-file {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
  }
  .prow-badge {
    flex-shrink: 0;
    margin-left: auto;
    padding: 0 5px;
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .prow-badge.warn { border-color: var(--warning); color: var(--warning); }
  .prow-blurb {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ── Editor column ─────────────────────────────────────────────────────── */
  .edit-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 10px; }

  .ed-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; flex-shrink: 0; }
  .ed-name { font-family: var(--font-display); font-weight: 700; font-size: 18px; letter-spacing: 0.5px; }
  .ed-chip {
    padding: 1px 8px;
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
  }
  .ed-chip.dim { border-color: var(--border-strong); color: var(--text-muted); }
  .ed-chip.warn { border-color: var(--warning); color: var(--warning); text-transform: uppercase; }
  .ed-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }

  .view-switch { display: flex; border: 1px solid var(--border-strong); }
  .vs-btn {
    padding: 5px 11px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 10.5px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }
  .vs-btn:hover { color: var(--text-secondary); }
  .vs-btn.active { color: var(--accent); background: var(--accent-faint); }

  .deck-save {
    padding: 6px 14px;
    background: var(--accent);
    border: none;
    color: var(--bg-primary);
    font-family: var(--font-display);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  }
  .deck-save:hover:not(:disabled) { box-shadow: 0 0 12px var(--accent-glow); }
  .deck-save:disabled { opacity: 0.4; cursor: default; }
  .deck-save.flash { background: var(--success); }

  .ed-blurb {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.5;
    border-left: 2px solid var(--accent-edge);
    padding: 2px 0 2px 10px;
  }

  .ed-text {
    flex: 1;
    min-height: 0;
    resize: none;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-left: 2px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
    padding: 14px 16px;
    tab-size: 2;
  }
  .ed-text:focus { outline: none; border-color: var(--accent-edge); border-left-color: var(--accent); }

  .ed-err { color: var(--error); font-size: 12.5px; flex-shrink: 0; }
  .ed-note { color: var(--text-muted); font-size: 12.5px; line-height: 1.5; }
  .ed-foot { flex-shrink: 0; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
  .ed-foot code, .ed-note code {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    padding: 0 4px;
  }
  .lnk {
    background: none;
    border: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }

  /* ── Missing file ──────────────────────────────────────────────────────── */
  .ed-missing {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    max-width: 440px;
    padding: 24px;
  }
  .em-mark { font-size: 26px; color: var(--warning); }
  .em-msg { font-family: var(--font-display); font-size: 15px; letter-spacing: 0.5px; color: var(--text-secondary); }
  .em-sub { font-size: 12.5px; color: var(--text-muted); line-height: 1.55; }
  .em-create {
    margin-top: 4px;
    padding: 8px 16px;
    background: transparent;
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .em-create:hover { background: var(--accent-dim); border-color: var(--accent); }

  /* ── Section rows (the in-tab quick-toggle view) ───────────────────────── */
  .sections { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
  .section { border: 1px solid var(--border); border-left: 2px solid var(--accent); background: var(--bg-tertiary); flex-shrink: 0; }
  .section.off { border-left-color: var(--text-muted); opacity: 0.6; }
  .s-header { display: flex; align-items: center; gap: 10px; padding-right: 12px; }
  .s-expand {
    display: flex;
    align-items: center;
    gap: 9px;
    flex: 1;
    min-width: 0;
    padding: 9px 12px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
  }
  .chev { font-size: 9px; color: var(--accent); transition: transform 0.15s; }
  .chev.open { transform: rotate(90deg); }
  .s-heading { flex: 1; min-width: 0; font-family: var(--font-display); font-size: 13px; letter-spacing: 0.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-body {
    margin: 0;
    padding: 4px 12px 12px 31px;
    font-family: var(--font-sans);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    max-height: 320px;
    overflow-y: auto;
  }

  /* ── Empty state ───────────────────────────────────────────────────────── */
  .ed-empty {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
    font-size: 14px;
    text-align: center;
    max-width: 440px;
  }
  .ee-mark { font-size: 28px; color: var(--accent); opacity: 0.6; }
  .ee-sub { font-size: 12px; opacity: 0.8; line-height: 1.5; }

  @media (max-width: 900px) {
    .pers-deck { grid-template-columns: 1fr; grid-template-rows: minmax(120px, 32vh) 1fr; }
    .list-col { border-right: none; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  }
</style>
