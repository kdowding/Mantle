<script lang="ts">
  // Active file pane (quick-toggle modal): header meta over the section rows
  // (expand to read, switch to toggle — instant save). Raw editing + assist now
  // live in the Personality systems-deck tab; this modal is read + toggle +
  // prompt-preview only.
  import { formatTimeAgo } from '../../lib/format';
  import Toggle from '../../components/Toggle.svelte';
  import { workspace, toggleSection, formatBytes } from './workspace.svelte';

  let expanded = $state<Set<string>>(new Set());

  const file = $derived(workspace.file);

  function toggleExpand(heading: string): void {
    const next = new Set(expanded);
    if (next.has(heading)) next.delete(heading);
    else next.add(heading);
    expanded = next;
  }

  function onToggle(heading: string, enabled: boolean): void {
    if (!file) return;
    const s = file.sections.find((x) => x.heading === heading);
    if (s) s.enabled = enabled;
    void toggleSection(file.name, heading, enabled);
  }
</script>

{#if workspace.loadingFile}
  <div class="muted">Loading…</div>
{:else if !file}
  <div class="muted">Failed to load file.</div>
{:else}
  <div class="file-header">
    <div class="fh-left">
      <div class="fh-name">{file.name}</div>
      <div class="fh-meta">
        {file.exists
          ? `${file.sections.length} section${file.sections.length === 1 ? '' : 's'} · ${formatBytes(file.content.length)} · modified ${formatTimeAgo(file.mtime)}`
          : 'File does not exist'}
      </div>
    </div>
  </div>

  {#if !file.exists}
    <div class="empty">
      <div class="empty-msg">File doesn't exist</div>
      <div class="empty-hint">Create and edit {file.name} in the <strong>Personality</strong> tab of the systems deck.</div>
    </div>
  {:else if file.sections.length === 0}
    <div class="empty">
      <div class="empty-msg">No <code>##</code> sections</div>
      <div class="empty-hint">
        The whole file passes through to the system prompt unchanged. Add
        <code>##</code> headings in the <strong>Personality</strong> tab for section-level control.
      </div>
    </div>
  {:else}
    <div class="sections">
      {#each file.sections as s (s.heading)}
        <div class="section" class:off={!s.enabled}>
          <div class="s-header">
            <button class="s-expand" type="button" onclick={() => toggleExpand(s.heading)}>
              <span class="chev" class:open={expanded.has(s.heading)}>▸</span>
              <span class="s-heading">{s.heading}</span>
              <span class="s-size">{formatBytes(s.body.length)}</span>
            </button>
            <Toggle
              checked={s.enabled}
              label={s.enabled ? 'On - included in system prompt' : 'Off - stripped from system prompt'}
              onchange={(v) => onToggle(s.heading, v)}
            />
          </div>
          {#if expanded.has(s.heading)}
            <pre class="s-body">{s.body}</pre>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .muted { color: var(--text-muted); font-size: 13px; }

  .file-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .fh-name { font-family: var(--font-display); font-size: 15px; font-weight: 600; letter-spacing: 1px; }
  .fh-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

  .empty { padding: 28px 16px; text-align: center; }
  .empty-msg { font-family: var(--font-display); font-size: 14px; letter-spacing: 1px; color: var(--text-secondary); }
  .empty-hint { font-size: 12px; color: var(--text-muted); margin-top: 6px; line-height: 1.5; }
  .empty code { font-family: var(--font-mono); color: var(--accent); }
  .empty strong { color: var(--text-secondary); }

  .sections { display: flex; flex-direction: column; gap: 6px; }
  .section { border: 1px solid var(--border); border-left: 2px solid var(--accent); background: var(--bg-tertiary); }
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
  .s-size { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); }

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
</style>
