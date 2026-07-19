<script lang="ts">
  // The assist dock — a right-hand chat column inside the systems deck. The
  // current agent answers with the open artifact in context; propose_edit
  // proposals render as a git-style diff with accept/discard. Mounted by
  // SystemsDeck while assist.open.
  import { tick } from 'svelte';
  import { ui, prefs, serverConfig, getFeature } from '../../lib/state.svelte';
  import { cycleThinking, toggleMemory, contextWindow, effortLevels } from '../../lib/inference';
  import { ChatScroll } from '../../lib/chat-scroll.svelte';
  // The deck companion shares the chat's inference selection (one source of
  // truth in `prefs`) — same backend picker, changeable from either place.
  import BackendPicker from '../../views/BackendPicker.svelte';
  import {
    assist, sendAssist, acceptFile, rejectFile, acceptOthers, rejectOthers, toggleHunk,
    confirmAction, discardAction, alwaysAllowAction, loadAssistSession, clearConversation,
    registerAssistWs, segmentDiff, collapseContext, type AssistActivity,
  } from './assist.svelte';

  // Memory pack gate — shared with chat; off when Englyph isn't ready.
  const memFeature = $derived(getFeature('memory'));
  const memDisabled = $derived(!!memFeature && !memFeature.ready);

  // ── Live work feed helpers ───────────────────────────────────────────────
  // Glyph + label for a tool step the agent ran (reads ⊙, stages ✎, actions ⚙).
  function actGlyph(name?: string): string {
    if (name === 'read_file' || name === 'list_directory' || name === 'glob_files' || name === 'grep_files') return '⊙';
    if (name === 'propose_edit' || name === 'stage_skill_edit') return '✎';
    if (name === 'cron_jobs' || name === 'skills_manage') return '⚙';
    return '›';
  }
  const ACT_FALLBACK: Record<string, string> = {
    read_file: 'reading a file', list_directory: 'listing a directory', glob_files: 'finding files', grep_files: 'searching',
    propose_edit: 'staging a revision', stage_skill_edit: 'staging a skill file',
    cron_jobs: 'managing cron', skills_manage: 'managing skills',
  };
  function actLabel(a: AssistActivity): string {
    // Prefer the server's toolLabel ("read AGENTS.md") over the raw tool name.
    if (a.label && a.label !== a.name) return a.label;
    return (a.name && ACT_FALLBACK[a.name]) || a.name || 'working';
  }
  // The per-turn context chip: "cron · new job", "skill · my-skill".
  function ctxChip(c: { kind: string; label: string; create?: boolean }): string {
    const label = c.create ? `new ${c.kind === 'cron' ? 'job' : c.kind}` : c.label;
    return `${c.kind} · ${label}`;
  }

  let draft = $state('');
  let scroller = $state<HTMLDivElement>();
  // Shared claude.ai-style scroll model — anchor-on-send, opt-in tail-follow, the
  // ▼ chip — identical to the 1:1 chat and channel surfaces.
  const sc = new ChatScroll(() => scroller);

  // ── Resizable width ─────────────────────────────────────────────────────────
  // The 440px default is the FLOOR; drag the left edge to widen (persisted).
  const ASSIST_MIN_W = 440;
  const assistMaxW = (): number => Math.min(1000, Math.round(window.innerWidth * 0.7));
  function loadAssistWidth(): number {
    try {
      const v = Number(localStorage.getItem('mantle-assist-width'));
      return v >= ASSIST_MIN_W ? Math.min(v, assistMaxW()) : ASSIST_MIN_W;
    } catch { return ASSIST_MIN_W; }
  }
  let dockWidth = $state(loadAssistWidth());
  function startResize(e: PointerEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = dockWidth;
    const onMove = (ev: PointerEvent): void => {
      // Dock is on the RIGHT, so dragging left (smaller clientX) widens it.
      dockWidth = Math.max(ASSIST_MIN_W, Math.min(assistMaxW(), startW + (startX - ev.clientX)));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      try { localStorage.setItem('mantle-assist-width', String(Math.round(dockWidth))); } catch { /* best effort */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.userSelect = 'none'; // no text selection mid-drag
  }

  $effect(() => registerAssistWs());

  // Load the agent's persisted assist conversation on mount + whenever the
  // agent changes — it's a real hidden server session now, not a client wipe.
  // reset() re-arms the scroll; the first settle after the load lands at the
  // bottom (see the content-growth effect).
  let assistLoadPending = false;
  $effect(() => {
    const id = ui.currentAgentId;
    if (id) { sc.reset(); assistLoadPending = true; void loadAssistSession(id); }
  });

  // Dock context gauge — prefer the per-turn values (the model that ran),
  // falling back to the static config for the selected model pre-turn.
  const ctxWin = $derived(assist.contextWindow ?? contextWindow());
  const ctxThreshold = $derived(assist.compactionThreshold ?? Math.floor(ctxWin * serverConfig.compactionFraction));
  const ctxUsed = $derived(assist.contextTokens);
  const ctxPct = $derived(Math.min(100, (ctxUsed / ctxWin) * 100));
  const ctxMarkPct = $derived(Math.min(100, (ctxThreshold / ctxWin) * 100));
  const ctxPast = $derived(ctxUsed >= ctxThreshold);
  const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const effortDisabled = $derived(effortLevels().length <= 1);

  // Content growth: the FIRST settle after a load lands at the bottom (transform-
  // immune — the deck mounts under a CRT scale that squashes rects); after that,
  // follow the tail when the reader's opted in, else surface the ▼ chip — never
  // grab the scroll mid-reply (claude.ai parity, shared with chat + channel).
  $effect(() => {
    void assist.msgs.length;
    void assist.msgs[assist.msgs.length - 1]?.text;
    void assist.changeset.length;
    void assist.actions.length;
    const loading = assist.loading;
    void tick().then(() => {
      if (assistLoadPending) {
        if (!loading) { assistLoadPending = false; sc.landAtBottom(); }
        return;
      }
      sc.onWrite();
    });
  });

  const lastAssistIsUser = $derived(assist.msgs[assist.msgs.length - 1]?.role === 'user');
  const hasTail = $derived(assist.streaming || lastAssistIsUser || sc.anchorHold);

  const agentName = $derived(ui.agents.find((a) => a.id === ui.currentAgentId)?.name ?? 'agent');
  const avatarUrl = $derived(ui.profile?.avatarUrl ?? null);
  let imgFailed = $state(false);
  $effect(() => { void ui.currentAgentId; imgFailed = false; }); // reset fallback on agent swap

  // The OPEN file's diff renders in the EDITOR (InlineDiff), not here — the dock
  // shows only OTHER (multi-file skill) diffs + a compact pointer to the editor.
  const otherFiles = $derived(assist.changeset.filter((c) => c.id !== 'open'));
  const hasOpen = $derived(assist.changeset.some((c) => c.id === 'open'));

  function send(): void {
    const text = draft.trim();
    if (!text || assist.streaming) return;
    draft = '';
    void sendAssist(text);
    // sendAssist pushes the user row synchronously — anchor it near the top once
    // the DOM has it; the reply then streams below, free to scroll (claude.ai).
    void tick().then(() => {
      const rows = scroller?.querySelectorAll('.dk-msg.user');
      const el = rows && rows.length ? (rows[rows.length - 1] as HTMLElement) : null;
      if (el) sc.anchorSend(el);
    });
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<!-- Agent-at-work indicator — a counter-rotating reticle (the cyber spinner)
     replacing the old pulsing-glyph wait. Used for both the reasoning phase and
     the initial pre-output "working" beat. -->
{#snippet thinkIndicator(label: string)}
  <div class="dk-think">
    <span class="dk-reticle" aria-hidden="true"></span>
    <span class="dk-think-label">{label}<span class="dk-dots"></span></span>
  </div>
{/snippet}

<aside class="dock" style="width: {dockWidth}px">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dk-resize" onpointerdown={startResize} title="Drag to resize" role="separator" aria-label="Resize assist panel" aria-orientation="vertical"></div>
  <div class="dk-head">
    <div class="dk-avatar">
      {#if avatarUrl && !imgFailed}
        <img src={avatarUrl} alt="" onerror={() => (imgFailed = true)} />
      {:else}
        <span class="dk-avatar-fallback">{(agentName || '?').charAt(0).toUpperCase()}</span>
      {/if}
    </div>
    <div class="dk-id">
      <span class="dk-title">✦ {agentName}</span>
      {#if assist.target}<span class="dk-target" title={assist.target.label}>{assist.target.label}</span>{/if}
    </div>
    <button class="dk-clear" type="button" title="Clear the conversation (staged changes stay - the agent's still told about them)" onclick={() => void clearConversation()}>↺</button>
  </div>

  <!-- Inference controls — the SAME selection as the chat profile bar (one
       source of truth in `prefs`); changing them here changes the chat too. -->
  <div class="dk-controls">
    <BackendPicker />
    <button class="dk-chip" class:active={prefs.thinkingLevel !== 'off'} type="button" disabled={effortDisabled} onclick={cycleThinking} title="Reasoning effort - cycles the levels this model supports; shared with chat, remembered per model">
      ◆ <span class="dk-chip-val">{prefs.thinkingLevel === 'medium' ? 'med' : prefs.thinkingLevel}</span>
    </button>
    <button class="dk-chip" class:active={prefs.memoryPack && !memDisabled} type="button" disabled={memDisabled} onclick={toggleMemory} title={memDisabled ? (memFeature?.setupHint ?? memFeature?.detail ?? 'Memory is unavailable') : 'Inject the Englyph memory pack - shared with chat'}>
      ⊙ <span class="dk-chip-val">{memDisabled ? 'off' : (prefs.memoryPack ? 'on' : 'off')}</span>
    </button>
  </div>

  <div class="dk-scroll-wrap">
    <div
      class="dk-scroll"
      class:has-tail={hasTail}
      role="log"
      bind:this={scroller}
      onscroll={() => sc.onScroll()}
      onwheel={(e) => sc.onWheel(e)}
      ontouchmove={() => sc.onTouchMove()}
    >
    {#if assist.loading && assist.msgs.length === 0}
      <div class="dk-empty">Loading the conversation…</div>
    {:else if assist.msgs.length === 0}
      <div class="dk-empty">
        Ask {agentName} about what's open - "write me a morning briefing prompt",
        "why isn't this firing?", "tighten this skill's description". Proposed
        changes stage as a diff; nothing touches the file until you accept and save.
        This conversation persists until you clear it.
      </div>
    {/if}
    {#each assist.msgs as m, i (i)}
      {#if m.role === 'user'}
        <div class="dk-msg user" class:fresh={m.fresh}>
          {m.text}{#if m.context}<span class="dk-ctx-chip" title="What {agentName} saw for this turn">{ctxChip(m.context)}</span>{/if}
        </div>
      {:else}
        <div class="dk-turn" class:fresh={m.fresh}>
          {#if m.thinking || (m.activities && m.activities.length > 0) || (m.live && !m.text)}
            <div class="dk-feed">
              {#if m.thinking}{@render thinkIndicator('reasoning')}{/if}
              {#each m.activities ?? [] as a (a.toolId)}
                <div class="dk-act {a.status}"><span class="dk-act-glyph">{actGlyph(a.name)}</span><span class="dk-act-text">{actLabel(a)}</span></div>
              {/each}
              {#if m.live && !m.text && !m.thinking && !(m.activities && m.activities.length > 0)}
                {@render thinkIndicator('working')}
              {/if}
            </div>
          {/if}
          {#if m.text}<div class="dk-msg assistant">{m.text}{#if m.live}<span class="stream-caret"></span>{/if}</div>{/if}
        </div>
      {/if}
    {/each}

    {#each assist.actions as a (a.id)}
      <div class="act">
        <div class="act-head">
          <span class="act-kind">{a.kind}</span>
          <span class="act-pending">pending your decision</span>
        </div>
        <div class="act-summary">{a.summary}</div>
        <div class="act-actions">
          <button class="act-always" type="button" title="Run this now AND auto-approve {a.kind} for this agent from now on" onclick={() => void alwaysAllowAction(a.id)}>✓ always allow</button>
          <span class="act-grow"></span>
          <button class="p-discard" type="button" onclick={() => discardAction(a.id)}>✕ discard</button>
          <button class="p-accept" type="button" onclick={() => void confirmAction(a.id)}>✓ confirm</button>
        </div>
      </div>
    {/each}

    {#if hasOpen}
      <div class="cs-pointer">↑ A change is staged in the editor - review it there (accept / reject per block).</div>
    {/if}

    {#if otherFiles.length > 0}
      {#if otherFiles.length > 1}
        <div class="cs-head">
          <span class="cs-title">{otherFiles.length} staged changes</span>
          <span class="cs-actions">
            <button class="cs-reject" type="button" onclick={rejectOthers}>✕ reject all</button>
            <button class="cs-accept" type="button" onclick={() => void acceptOthers()}>✓ accept all</button>
          </span>
        </div>
      {/if}
      {#each otherFiles as f (f.id)}
        {@const sd = segmentDiff(f.baseline, f.content)}
        {@const mask = assist.hunks[f.id] ?? []}
        {@const adds = sd.segments.reduce((s, g) => s + (g.kind === 'hunk' ? g.adds.length : 0), 0)}
        {@const dels = sd.segments.reduce((s, g) => s + (g.kind === 'hunk' ? g.dels.length : 0), 0)}
        {@const onCount = sd.segments.reduce((s, g) => s + (g.kind === 'hunk' && mask[g.id] !== false ? 1 : 0), 0)}
        {@const stale = f.kind === 'open' && !!assist.target && assist.target.getContent() !== f.baseline}
        <div class="prop" class:stale>
          <div class="prop-head">
            <span class="prop-kind" class:new={f.isNew}>{f.kind === 'open' ? 'open' : f.isNew ? 'new' : 'edit'}</span>
            <span class="prop-file" title={f.label}>{f.label}</span>
            <span class="prop-stats"><span class="plus">+{adds}</span> <span class="minus">−{dels}</span></span>
          </div>
          {#if f.note}<div class="prop-note">{f.note}</div>{/if}
          {#if sd.hunkCount > 1}
            <div class="prop-hint">{onCount}/{sd.hunkCount} hunks included - click ✓/✕ to skip one</div>
          {/if}
          <div class="prop-diff">
            {#each sd.segments as seg, si (si)}
              {#if seg.kind === 'context'}
                {#each collapseContext(seg.lines, si === 0, si === sd.segments.length - 1) as row, ri (ri)}
                  <div class="dr {row.gap ? 'gap' : 'same'}">{row.text || ' '}</div>
                {/each}
              {:else}
                <div class="hunk" class:rejected={mask[seg.id] === false}>
                  <button
                    class="hunk-tgl"
                    type="button"
                    title={mask[seg.id] === false ? 'Skipped - keeping the original' : 'Included'}
                    onclick={() => toggleHunk(f.id, seg.id)}
                  >{mask[seg.id] === false ? '✕' : '✓'}</button>
                  <div class="hunk-lines">
                    {#each seg.dels as d, di (di)}<div class="dr del">{d || ' '}</div>{/each}
                    {#each seg.adds as a, ai (ai)}<div class="dr add">{a || ' '}</div>{/each}
                  </div>
                </div>
              {/if}
            {/each}
          </div>
          {#if stale}
            <div class="prop-stale">The editor changed since this was staged - accepting replaces your current content.</div>
          {/if}
          <div class="prop-actions">
            <button class="p-discard" type="button" onclick={() => rejectFile(f.id)}>✕ discard</button>
            <button class="p-accept" type="button" onclick={() => void acceptFile(f.id)}>
              {f.kind === 'open' ? '✓ accept → editor' : f.isNew ? '✓ create' : '✓ accept → file'}
            </button>
          </div>
        </div>
      {/each}
    {/if}

    {#if assist.error}<div class="dk-err">{assist.error}</div>{/if}
    </div>
    {#if sc.showJump}
      <button class="dk-jump" type="button" title="Jump to the latest" onclick={() => sc.jumpToBottom()}>▼ latest</button>
    {/if}
  </div>

  {#if assist.target}
    <div class="dk-ctx" title="Assist context: {ctxUsed.toLocaleString()} of ~{ctxWin.toLocaleString()} tokens · compaction summarizes the oldest turns past {ctxThreshold.toLocaleString()}">
      <div class="dk-ctx-track">
        <div class="dk-ctx-fill" class:past={ctxPast} style="width: {ctxPct}%"></div>
        {#if ctxMarkPct > 0 && ctxMarkPct < 100}<div class="dk-ctx-mark" style="left: {ctxMarkPct}%"></div>{/if}
      </div>
      <span class="dk-ctx-label">{fmtK(ctxUsed)}/{fmtK(ctxWin)}</span>
    </div>
  {/if}

  <div class="dk-input">
    <textarea
      rows="2"
      bind:value={draft}
      placeholder={assist.streaming ? `${agentName} is thinking…` : `ask ${agentName}…`}
      disabled={!assist.target}
      onkeydown={onKeydown}
    ></textarea>
    <button class="dk-send" type="button" disabled={!draft.trim() || assist.streaming || !assist.target} onclick={send} aria-label="Send">▶</button>
  </div>
</aside>

<style>
  .dock {
    flex-shrink: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    padding-left: 18px;
    margin-left: 2px;
    position: relative; /* anchors the resize handle + the ▼ jump chip */
    /* width is set inline (drag-resizable; 440px floor). */
  }
  /* Drag the left edge to widen the dock. */
  .dk-resize {
    position: absolute;
    left: -4px;
    top: 0;
    bottom: 0;
    width: 9px;
    cursor: ew-resize;
    z-index: 6;
    background: transparent;
    transition: background 0.15s;
  }
  .dk-resize:hover { background: linear-gradient(to right, transparent, var(--accent-dim)); }

  .dk-head { display: flex; align-items: center; gap: 11px; flex-shrink: 0; padding-bottom: 10px; }
  .dk-avatar {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    overflow: hidden;
    border: 1.5px solid var(--accent);
    box-shadow: 0 0 12px var(--accent-dim);
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  }
  .dk-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .dk-avatar-fallback {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 17px;
    color: var(--accent);
    background: var(--accent-dim);
  }
  .dk-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .dk-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent);
    text-shadow: 0 0 10px var(--accent-glow);
  }
  .dk-target {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .dk-clear { align-self: flex-start; background: none; border: none; color: var(--text-muted); font-size: 13px; cursor: pointer; }
  .dk-clear:hover { color: var(--accent); }

  /* Inference strip — shares the chat's prefs (backend picker + effort/memory). */
  .dk-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    flex-shrink: 0;
    padding-bottom: 10px;
    margin-bottom: 2px;
    border-bottom: 1px solid var(--border);
  }
  .dk-controls :global(.bp-trigger) { font-size: 11px; padding: 4px 8px; max-width: 220px; }
  .dk-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .dk-chip:hover:not(:disabled) { border-color: var(--accent); color: var(--text-secondary); }
  .dk-chip:disabled { opacity: 0.4; cursor: default; }
  .dk-chip.active { border-color: var(--accent); color: var(--accent); background: var(--accent-faint); }
  .dk-chip-val { opacity: 0.72; }

  /* Pointer to the in-editor diff (the open file resolves there, not here). */
  .cs-pointer {
    flex-shrink: 0;
    padding: 7px 10px;
    border: 1px dashed var(--accent-edge);
    border-left: 2px solid var(--accent);
    background: var(--accent-faint);
    color: var(--text-secondary);
    font-size: 11.5px;
    line-height: 1.4;
  }

  /* The scroll region + its overlay chip live in a relative wrapper so the ▼
     chip pins to the bottom of the messages, not the dock's input. */
  .dk-scroll-wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .dk-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 4px;
  }
  /* Tail room so a just-sent prompt can anchor near the top while its short
     reply streams below — only during an active exchange (claude.ai parity). */
  .dk-scroll.has-tail::after {
    content: '';
    display: block;
    flex: 0 0 max(220px, calc(100dvh - 340px));
    pointer-events: none;
  }
  /* ▼ jump-to-latest — appears when scrolled away from the newest reply. */
  .dk-jump {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 7;
    padding: 4px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 9.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), 0 0 10px var(--accent-dim);
  }
  .dk-jump:hover { background: var(--accent-dim); border-color: var(--accent); }
  .dk-empty { color: var(--text-muted); font-size: 12px; line-height: 1.55; padding: 4px 2px; }

  .dk-msg {
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 7px 10px;
    max-width: 96%;
  }
  .dk-msg.user {
    align-self: flex-end;
    background: var(--accent-faint);
    border: 1px solid var(--accent-edge);
    border-right: 2px solid var(--accent);
    color: var(--text-primary);
  }
  /* Assistant bubble = a compact transmission block: accent rail + faint
     diagonal wash (the dock echo of the main chat's MessageShell). */
  .dk-msg.assistant {
    align-self: flex-start;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent 55%),
      var(--bg-tertiary);
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    color: var(--text-secondary);
  }

  /* Entry — ONLY on turns sent this session (.fresh); loaded history never
     replays. User uplinks from the console side; the assistant turn decodes in
     from a soft blur (same vocabulary as views/Message). */
  .dk-msg.user.fresh { animation: dk-uplink 0.34s cubic-bezier(0.22, 0.61, 0.36, 1); }
  @keyframes dk-uplink {
    from { opacity: 0; transform: translateX(22px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  .dk-turn.fresh { animation: dk-decode 0.44s cubic-bezier(0.22, 0.61, 0.36, 1); }
  @keyframes dk-decode {
    0%   { opacity: 0; transform: translateY(8px); filter: blur(5px); }
    55%  { opacity: 1; filter: blur(0.5px); }
    100% { opacity: 1; transform: translateY(0); filter: blur(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dk-msg.user.fresh, .dk-turn.fresh { animation: none; }
  }
  /* Per-turn context chip on user messages — what the agent saw this turn. */
  .dk-ctx-chip {
    display: block;
    margin-top: 4px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.02em;
    color: var(--text-muted);
    opacity: 0.85;
  }
  .dk-ctx-chip::before { content: '↳ '; opacity: 0.55; }

  /* Assistant turn = the live work feed + the reply bubble, grouped tight. */
  .dk-turn { display: flex; flex-direction: column; gap: 4px; align-self: flex-start; max-width: 96%; min-width: 0; }
  .dk-feed { display: flex; flex-direction: column; gap: 1px; padding: 1px 2px 1px 4px; min-width: 0; }
  .dk-act {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.55;
    color: var(--text-muted);
    min-width: 0;
  }
  .dk-act-glyph { flex-shrink: 0; width: 12px; text-align: center; color: var(--accent); }
  .dk-act-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .dk-act.running { color: var(--text-secondary); }
  .dk-act.running .dk-act-glyph { animation: dk-act-pulse 1.3s ease-in-out infinite; }
  .dk-act.done .dk-act-glyph { color: var(--success); }
  .dk-act.error { color: var(--error); }
  .dk-act.error .dk-act-glyph { color: var(--error); }
  @keyframes dk-act-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  @media (prefers-reduced-motion: reduce) { .dk-act.running .dk-act-glyph { animation: none; } }

  /* ── Agent-at-work reticle — the on-theme "thinking" spinner that replaces the
     old pulsing-glyph wait. Two square brackets counter-rotate at different
     rates: a HUD targeting lock, not a round throbber. ────────────────────── */
  .dk-think { display: flex; align-items: center; gap: 10px; padding: 2px; }
  .dk-reticle { position: relative; width: 13px; height: 13px; flex-shrink: 0; }
  .dk-reticle::before, .dk-reticle::after { content: ''; position: absolute; border: 1.5px solid transparent; }
  .dk-reticle::before {
    inset: 0;
    border-top-color: var(--accent);
    border-right-color: var(--accent);
    animation: dk-reticle 0.85s linear infinite;
  }
  .dk-reticle::after {
    inset: 3px;
    border-bottom-color: var(--accent);
    border-left-color: var(--accent);
    opacity: 0.6;
    animation: dk-reticle 1.3s linear infinite reverse;
  }
  @keyframes dk-reticle { to { transform: rotate(360deg); } }
  .dk-think-label {
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent);
    text-shadow: 0 0 8px var(--accent-glow);
  }
  .dk-dots::after { content: ''; animation: dk-dots 1.4s steps(4, end) infinite; }
  @keyframes dk-dots {
    0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } 100% { content: ''; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dk-reticle::before, .dk-reticle::after { animation: none; }
    .dk-dots::after { animation: none; content: '…'; }
  }

  /* Transmission cursor — a glowing accent block whose halo throbs (a live
     signal, not a hard blink). Same rhythm as the chat island's cursor. */
  .stream-caret {
    display: inline-block;
    width: 7px;
    height: 1.1em;
    margin-left: 3px;
    vertical-align: text-bottom;
    background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 30%, transparent));
    box-shadow: 0 0 8px var(--accent-glow);
    animation: dk-stream 1.1s ease-in-out infinite;
  }
  @keyframes dk-stream {
    0%, 100% { opacity: 1; box-shadow: 0 0 10px var(--accent-glow), 0 0 4px var(--accent); }
    50%      { opacity: 0.5; box-shadow: 0 0 3px var(--accent-glow); }
  }
  @media (prefers-reduced-motion: reduce) { .stream-caret { animation: none; opacity: 0.85; } }

  /* ── Staged proposal ───────────────────────────────────────────────────── */
  .prop {
    border: 1px solid var(--accent-edge);
    border-left: 2px solid var(--accent);
    background: var(--bg-secondary);
    flex-shrink: 0;
    animation: dk-stage-in 0.32s cubic-bezier(0.22, 0.61, 0.36, 1);
  }
  /* Staged cards (diffs + action confirms) slide in when the agent stages them. */
  @keyframes dk-stage-in {
    from { opacity: 0; transform: translateY(7px) scaleY(0.97); }
    to   { opacity: 1; transform: translateY(0) scaleY(1); }
  }
  @media (prefers-reduced-motion: reduce) { .prop, .act { animation: none; } }
  .prop.stale { border-color: color-mix(in srgb, var(--warning) 50%, transparent); border-left-color: var(--warning); }
  .prop-head {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
  }
  .prop-kind {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 5px;
    border: 1px solid var(--accent-edge);
    color: var(--accent);
  }
  .prop-kind.new { border-color: var(--warning); color: var(--warning); }
  .prop-file {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .prop-stats { margin-left: auto; flex-shrink: 0; font-family: var(--font-mono); font-size: 11px; }

  /* Changeset header (multi-file) */
  .cs-head { display: flex; align-items: center; gap: 10px; flex-shrink: 0; padding: 4px 2px 2px; }
  .cs-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent);
  }
  .cs-actions { margin-left: auto; display: flex; gap: 6px; }
  .cs-accept, .cs-reject {
    padding: 4px 10px;
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  }
  .cs-accept { background: var(--accent); border: none; color: var(--bg-primary); }
  .cs-accept:hover { box-shadow: 0 0 12px var(--accent-glow); }
  .cs-reject { background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted); }
  .cs-reject:hover { color: var(--error); border-color: var(--error); }

  /* ── Staged systems action (confirm card) ──────────────────────────────── */
  .act {
    border: 1px solid var(--warning);
    border-left: 2px solid var(--warning);
    background: var(--bg-secondary);
    flex-shrink: 0;
    animation: dk-stage-in 0.32s cubic-bezier(0.22, 0.61, 0.36, 1);
  }
  .act-head { display: flex; align-items: center; gap: 9px; padding: 7px 10px; border-bottom: 1px solid var(--border); }
  .act-kind {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--warning);
    text-transform: uppercase;
  }
  .act-pending {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .act-summary { padding: 8px 10px; font-size: 13px; color: var(--text-primary); line-height: 1.45; }
  .act-actions { display: flex; align-items: center; gap: 8px; padding: 0 10px 10px; }
  .act-grow { flex: 1; }
  .act-always {
    padding: 5px 10px;
    background: transparent;
    border: 1px dashed var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 10px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .act-always:hover { border-style: solid; background: var(--accent-dim); }
  .plus { color: var(--success); }
  .minus { color: var(--error); }
  .prop-note { padding: 6px 10px 0; font-size: 12px; color: var(--text-secondary); line-height: 1.45; }

  .prop-diff {
    margin: 8px 10px;
    max-height: 300px;
    overflow: auto;
    border: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
  }
  .dr { padding: 0 8px; white-space: pre; }
  .dr.same { color: var(--text-muted); }
  .dr.add { background: rgba(0, 255, 136, 0.08); color: var(--success); }
  .dr.add::before { content: '+ '; opacity: 0.7; }
  .dr.del { background: rgba(255, 45, 124, 0.08); color: var(--error); text-decoration: line-through; text-decoration-color: rgba(255, 45, 124, 0.4); }
  .dr.del::before { content: '− '; opacity: 0.7; }
  .dr.same::before { content: '  '; }
  .dr.gap {
    color: var(--text-muted);
    font-style: italic;
    text-align: center;
    border-top: 1px dashed var(--border);
    border-bottom: 1px dashed var(--border);
  }

  /* ── Per-hunk review ───────────────────────────────────────────────────── */
  .prop-hint {
    padding: 6px 10px 0;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
  }
  .hunk { display: flex; }
  .hunk-tgl {
    flex-shrink: 0;
    width: 22px;
    align-self: stretch;
    background: transparent;
    border: none;
    border-right: 1px solid var(--border);
    color: var(--success);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    transition: background 0.12s, color 0.12s;
  }
  .hunk-tgl:hover { background: var(--bg-tertiary); }
  .hunk.rejected .hunk-tgl { color: var(--text-muted); }
  .hunk-lines { flex: 1; min-width: 0; }
  /* Rejected hunk = keep the original: deletions stay (not struck), additions drop. */
  .hunk.rejected .dr.del { text-decoration: none; color: var(--text-secondary); background: transparent; }
  .hunk.rejected .dr.del::before { content: '  '; }
  .hunk.rejected .dr.add { opacity: 0.4; }

  .prop-stale { padding: 0 10px 6px; font-size: 11px; color: var(--warning); line-height: 1.4; }
  .prop-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 0 10px 10px; }
  .p-accept {
    padding: 5px 13px;
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
  .p-accept:hover { box-shadow: 0 0 12px var(--accent-glow); }
  .p-discard {
    padding: 5px 11px;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 10.5px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
  }
  .p-discard:hover { color: var(--error); border-color: var(--error); }

  .dk-err { color: var(--error); font-size: 12px; flex-shrink: 0; }

  /* ── Context gauge — slim strip above the composer (assist session usage) ─ */
  .dk-ctx { display: flex; align-items: center; gap: 8px; flex-shrink: 0; padding-top: 8px; user-select: none; }
  .dk-ctx-track {
    flex: 1;
    height: 3px;
    position: relative;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    overflow: visible; /* the notch head pokes above the rail */
  }
  .dk-ctx-fill {
    height: 100%;
    background: var(--accent);
    box-shadow: 0 0 5px var(--accent-glow);
    transition: width 0.4s ease, background 0.3s;
  }
  .dk-ctx-fill.past { background: var(--error); box-shadow: 0 0 5px rgba(255, 45, 124, 0.4); }
  .dk-ctx-mark {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 2px;
    background: var(--accent-reason);
    box-shadow: 0 0 4px var(--accent-reason-glow);
  }
  .dk-ctx-label {
    flex-shrink: 0;
    font-family: var(--font-terminal);
    font-size: 9px;
    letter-spacing: 0.6px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* ── Input ─────────────────────────────────────────────────────────────── */
  .dk-input { display: flex; gap: 8px; align-items: flex-end; padding-top: 10px; flex-shrink: 0; }
  .dk-input textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-bottom: 2px solid var(--text-muted);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.45;
    padding: 8px 10px;
  }
  .dk-input textarea:focus { outline: none; border-bottom-color: var(--accent); }
  .dk-input textarea:disabled { opacity: 0.5; }
  .dk-send {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  }
  .dk-send:hover:not(:disabled) { background: var(--accent-dim); }
  .dk-send:disabled { opacity: 0.4; cursor: default; }

</style>
