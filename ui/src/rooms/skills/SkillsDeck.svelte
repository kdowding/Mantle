<script lang="ts">
  // Skills tab of the systems deck — list + detail editor over the agent's
  // full skill surface (agent dir AND global dir, both scopes manageable).
  // The editor edits the RAW SKILL.md (frontmatter included); the server
  // validates with discovery's own parse so a save can never produce an
  // invisible skill. Discovery is fingerprint-cached per turn, so saved
  // skills exist for the agent on its next message — no restart.
  import { ui } from '../../lib/state.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { confirmDialog } from '../../components/confirm.svelte';
  import {
    skills, loadSkills, toggleSkill, readSkillFile, writeSkillFile, deleteSkillFile,
    type AgentSkill, type SkillFileRef,
  } from './skills.svelte';
  import { assist, setAssistTarget, discardOpen } from '../assist/assist.svelte';
  import InlineDiff from '../../components/InlineDiff.svelte';

  $effect(() => {
    void ui.currentAgentId;
    void loadSkills();
    selected = null; // an agent switch invalidates the open editor
  });

  // The assist dock edits the OPEN skill's editor buffer — or, with nothing
  // open, stays in CREATION mode so the agent can build a new skill from the
  // chat (it stages new SKILL.md files via stage_skill_edit → dock diffs).
  $effect(() => {
    if (selected) {
      setAssistTarget({
        kind: 'skill',
        label: `${selected.dir}/SKILL.md`,
        getContent: () => content,
        apply: (c) => { content = c; },
        // The open skill's identity, so the agent's edits to it fold into the
        // buffer-baselined "open" entry.
        ref: { scope: selected.scope, dir: selected.dir },
        // Persist a NON-open skill the agent staged (or a new one): write via the
        // skills API; writeSkillFile reloads the list so it shows up immediately.
        applyExternal: (r, c) => ('scope' in r ? writeSkillFile({ scope: r.scope, dir: r.dir }, c) : Promise.resolve()),
      });
    } else {
      setAssistTarget({
        kind: 'skill',
        label: 'new skill',
        getContent: () => '',
        apply: () => {},
        create: true,
        applyExternal: (r, c) => ('scope' in r ? writeSkillFile({ scope: r.scope, dir: r.dir }, c) : Promise.resolve()),
      });
    }
    return () => setAssistTarget(null);
  });

  const agentSkills = $derived(skills.list.filter((s) => s.source === 'agent'));
  const globalSkills = $derived(skills.list.filter((s) => s.source === 'global'));

  // The open skill's staged edit, if any — rendered as a Cursor-style inline
  // diff in the editor (below) instead of the textarea.
  const openFile = $derived(assist.changeset.find((c) => c.id === 'open') ?? null);

  // After the assist applies a skill action (delete/enable/disable), refresh the
  // list. Sentinel-guarded so it doesn't double-load on mount.
  let lastAppliedTick = 0;
  $effect(() => {
    const t = assist.appliedTick;
    if (t !== lastAppliedTick) { lastAppliedTick = t; void loadSkills(); }
  });

  // ── Editor state ───────────────────────────────────────────────────────────
  // selected = the open file; null = empty state. Creating = a ref that may
  // not exist on disk yet (saved on first Save).
  let selected = $state<(SkillFileRef & { name: string; isNew?: boolean }) | null>(null);
  let content = $state('');
  // $state, not a plain let: `dirty` is a $derived over it, so a non-reactive
  // reassignment in save() would leave `dirty` stale-true (save never clears).
  let savedContent = $state('');
  let loadErr = $state<string | null>(null);
  let saveErr = $state<string | null>(null);
  let saving = $state(false);
  let savedFlash = $state(false);
  const dirty = $derived(content !== savedContent);

  const selectedMeta = $derived(
    selected ? skills.list.find((s) => s.source === selected!.scope && s.dir === selected!.dir) ?? null : null,
  );

  async function openSkill(s: AgentSkill): Promise<void> {
    if (dirty && !(await confirmDiscard())) return;
    selected = { scope: s.source, dir: s.dir, name: s.name };
    saveErr = null;
    loadErr = null;
    content = '';
    savedContent = '';
    try {
      const text = await readSkillFile({ scope: s.source, dir: s.dir });
      // Stale guard — user may have clicked elsewhere while the read ran.
      if (selected?.dir === s.dir && selected?.scope === s.source) {
        content = text;
        savedContent = text;
      }
    } catch (e) {
      loadErr = e instanceof Error ? e.message : String(e);
    }
  }

  function confirmDiscard(): Promise<boolean> {
    return confirmDialog({
      title: 'Discard changes',
      message: 'The open skill has unsaved edits. Discard them?',
      confirmText: 'Discard',
      danger: true,
    });
  }

  // Create flow: name the directory, get a template in the editor, save to mint.
  let creating = $state<null | 'agent' | 'global'>(null);
  let newDir = $state('');
  const dirOk = $derived(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(newDir));

  async function startCreate(scope: 'agent' | 'global'): Promise<void> {
    if (dirty && !(await confirmDiscard())) return;
    creating = scope;
    newDir = '';
  }
  function commitCreate(): void {
    if (!creating || !dirOk) return;
    const dir = newDir.trim();
    selected = { scope: creating, dir, name: dir, isNew: true };
    content = `---\nname: ${dir}\ndescription: One line - when should the agent reach for this skill?\n---\n\n# ${dir}\n\nInstructions the agent follows when this skill triggers.\n`;
    savedContent = ''; // anything unsaved counts as dirty until the first save
    saveErr = null;
    loadErr = null;
    creating = null;
  }

  async function save(): Promise<void> {
    if (!selected || saving) return;
    saving = true;
    saveErr = null;
    try {
      await writeSkillFile(selected, content);
      savedContent = content;
      selected.isNew = false;
      savedFlash = true;
      setTimeout(() => (savedFlash = false), 1200);
    } catch (e) {
      saveErr = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function remove(): Promise<void> {
    if (!selected || selected.isNew) return;
    const ok = await confirmDialog({
      title: 'Delete skill',
      message: `Delete the ${selected.scope} skill "${selected.name}"?\nIts whole directory (assets included) is removed.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteSkillFile(selected);
      selected = null;
      content = '';
      savedContent = '';
    } catch (e) {
      saveErr = e instanceof Error ? e.message : String(e);
    }
  }

  function onEditorKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      void save();
    }
  }
</script>

<div class="skills-deck">
  <div class="list-col">
    {#snippet skillRow(s: AgentSkill)}
      <button
        class="srow"
        class:active={selected?.dir === s.dir && selected?.scope === s.source}
        class:off={!s.enabled}
        type="button"
        onclick={() => void openSkill(s)}
      >
        <span class="srow-head">
          <span class="srow-name">{s.name}</span>
          {#if s.always}<span class="srow-badge" title="Standing skill - full body in every prompt">always</span>{/if}
          {#if !s.enabled}<span class="srow-badge dim">off</span>{/if}
        </span>
        {#if s.description}<span class="srow-desc">{s.description}</span>{/if}
      </button>
    {/snippet}

    <div class="lc-head">
      <span class="lc-label">agent · {ui.agents.find((a) => a.id === ui.currentAgentId)?.name ?? ''}</span>
      <button class="side-sect-btn" type="button" title="New agent skill" onclick={() => void startCreate('agent')}>+</button>
    </div>
    {#each agentSkills as s (s.dir)}{@render skillRow(s)}{/each}
    {#if creating === 'agent'}
      <div class="new-row">
        <input
          class="new-input"
          placeholder="skill-dir-name"
          bind:value={newDir}
          onkeydown={(e) => { if (e.key === 'Enter') commitCreate(); if (e.key === 'Escape') creating = null; }}
        />
        <button class="new-go" type="button" disabled={!dirOk} onclick={commitCreate}>create</button>
      </div>
    {/if}
    {#if agentSkills.length === 0 && creating !== 'agent'}
      <div class="lc-empty">No agent skills yet.</div>
    {/if}

    <div class="lc-head">
      <span class="lc-label">global</span>
      <button class="side-sect-btn" type="button" title="New global skill" onclick={() => void startCreate('global')}>+</button>
    </div>
    {#each globalSkills as s (s.dir)}{@render skillRow(s)}{/each}
    {#if creating === 'global'}
      <div class="new-row">
        <input
          class="new-input"
          placeholder="skill-dir-name"
          bind:value={newDir}
          onkeydown={(e) => { if (e.key === 'Enter') commitCreate(); if (e.key === 'Escape') creating = null; }}
        />
        <button class="new-go" type="button" disabled={!dirOk} onclick={commitCreate}>create</button>
      </div>
    {/if}
    {#if globalSkills.length === 0 && creating !== 'global'}
      <div class="lc-empty">No global skills.</div>
    {/if}
  </div>

  <div class="edit-col">
    {#if selected}
      <div class="ed-head">
        <span class="ed-name">{selectedMeta?.name ?? selected.name}</span>
        <span class="ed-chip">{selected.scope}</span>
        <span class="ed-chip dim">{selected.dir}/SKILL.md</span>
        {#if selected.isNew}<span class="ed-chip new">unsaved</span>{/if}
        {#if selectedMeta}
          <span class="ed-toggle" title="Enabled for this agent">
            <Toggle
              checked={selectedMeta.enabled}
              label="Enable {selectedMeta.name}"
              onchange={(v) => void toggleSkill(selectedMeta, v)}
            />
          </span>
        {/if}
        <span class="ed-actions">
          {#if !selected.isNew}
            <button class="ed-del" type="button" onclick={() => void remove()}>✕ delete</button>
          {/if}
          <button class="deck-save" class:flash={savedFlash} type="button" disabled={!dirty || saving} onclick={() => void save()}>
            {savedFlash ? '✓ saved' : saving ? 'saving…' : 'save'}
          </button>
        </span>
      </div>
      {#if loadErr}
        <div class="ed-err">{loadErr}</div>
      {:else if openFile}
        <!-- Assist staged an edit to the open skill — review it inline (Cursor
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
      {:else}
        <!-- svelte-ignore a11y_autofocus -->
        <textarea class="ed-text" bind:value={content} spellcheck="false" onkeydown={onEditorKey} autofocus></textarea>
        {#if saveErr}<div class="ed-err">{saveErr}</div>{/if}
        <div class="ed-foot">
          frontmatter: <code>name</code> · <code>description</code> (required - skills without one are invisible) ·
          <code>always</code> (body in every prompt) · <code>platform</code> (windows/macos/linux) - saved skills are
          live for the agent on its next message · ctrl+s saves
        </div>
      {/if}
    {:else}
      <div class="ed-empty">
        <div class="ee-mark">◈</div>
        <div>Pick a skill to read or edit it - or create one.</div>
        <div class="ee-sub">Agent skills live in the workspace and win name conflicts; global skills serve every agent.</div>
      </div>
    {/if}
  </div>
</div>

<style>
  .skills-deck {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 300px 1fr;
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
  .lc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 2px 4px;
    flex-shrink: 0;
  }
  .lc-head:first-child { padding-top: 0; }
  .lc-label {
    font-family: var(--font-terminal);
    font-size: 10.5px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent);
    opacity: 0.85;
  }
  .lc-empty { color: var(--text-muted); font-size: 12.5px; padding: 2px 4px 8px; }

  .srow {
    display: flex;
    flex-direction: column;
    gap: 2px;
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
  .srow:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .srow.active { background: var(--accent-faint); border-color: var(--accent-edge); border-left-color: var(--accent); }
  .srow-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .srow-name {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 14px;
    letter-spacing: 0.4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .srow.off .srow-name { color: var(--text-muted); }
  .srow-badge {
    flex-shrink: 0;
    padding: 0 5px;
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .srow-badge.dim { border-color: var(--border-strong); color: var(--text-muted); }
  .srow-desc {
    font-size: 11.5px;
    color: var(--text-muted);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .new-row { display: flex; gap: 6px; padding: 2px 2px 6px; flex-shrink: 0; }
  .new-input {
    flex: 1;
    min-width: 0;
    background: var(--bg-input);
    border: 1px solid var(--accent-edge);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 12.5px;
    padding: 6px 9px;
  }
  .new-input:focus { outline: none; border-color: var(--accent); }
  .new-go {
    padding: 0 10px;
    background: transparent;
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
  }
  .new-go:disabled { opacity: 0.4; cursor: default; }

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
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .ed-chip.dim { border-color: var(--border-strong); color: var(--text-muted); text-transform: none; }
  .ed-chip.new { border-color: var(--warning); color: var(--warning); }
  .ed-toggle { margin-left: 2px; }
  .ed-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .ed-del {
    padding: 6px 11px;
    background: transparent;
    border: 1px dashed color-mix(in srgb, var(--error) 45%, transparent);
    color: color-mix(in srgb, var(--error) 75%, var(--text-muted));
    font-family: var(--font-display);
    font-size: 10.5px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .ed-del:hover { color: var(--error); border-color: var(--error); }

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
  .ed-foot {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .ed-foot code {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    padding: 0 4px;
  }

  .ed-empty {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
    font-size: 14px;
    text-align: center;
    max-width: 420px;
  }
  .ee-mark { font-size: 28px; color: var(--accent); opacity: 0.6; }
  .ee-sub { font-size: 12px; opacity: 0.8; line-height: 1.5; }

  @media (max-width: 900px) {
    .skills-deck { grid-template-columns: 1fr; grid-template-rows: minmax(120px, 32vh) 1fr; }
    .list-col { border-right: none; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  }
</style>
