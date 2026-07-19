<script lang="ts">
  // Chat composer: attach + emoji buttons + staged-file chips + auto-growing
  // textarea + send. The draft lives on `composer.draft` (module state) so
  // edit-last-turn can load it. While a turn streams, the composer STAYS LIVE:
  // Enter sends a steer-while-busy note (text only — attachments need a full
  // turn) and a stop button appears beside send. Desktop sends on Enter
  // (Shift+Enter = newline); mobile inserts a newline. The :shortcode:
  // autocomplete intercepts arrows/Enter/Tab/Esc while open.
  import { tick } from 'svelte';
  import { composer, chat, ui } from '../lib/state.svelte';
  import { lsGet, lsSet, lsRemove } from '../lib/storage';
  import { addFile, addTextFile, removePending, formatSize } from '../lib/attachments';
  import MicButton from '../rooms/voice/MicButton.svelte'; // [room] voice input
  import EmojiPicker from '../components/emoji/EmojiPicker.svelte';
  import ShortcodeAutocomplete from '../components/emoji/ShortcodeAutocomplete.svelte';
  import { scanShortcode, type ShortcodeMatch } from '../components/emoji/shortcodes';
  import { addRecent } from '../components/emoji/recents.svelte';

  let { onsend, onstop, streaming = false }: {
    onsend: (text: string) => void;
    onstop?: () => void;
    streaming?: boolean;
  } = $props();

  let ta: HTMLTextAreaElement;
  let fileInput: HTMLInputElement;

  const isMobile = () => window.innerWidth <= 768;
  // While streaming only a text note can go out; attachments wait for idle.
  const canSend = $derived(
    streaming
      ? composer.draft.trim().length > 0 && composer.pending.length === 0
      : composer.draft.trim().length > 0 || composer.pending.length > 0,
  );

  function autogrow(): void {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }

  // Keep height in sync with programmatic draft changes too (edit-last-turn
  // loads text in; send clears it).
  $effect(() => {
    void composer.draft;
    autogrow();
  });

  // ── Draft persistence ──────────────────────────────────────────────────────
  // A half-typed message survives session switches and reloads. Keyed by
  // agent+session ('new' for the lazy pre-creation lobby); written on every
  // keystroke (small strings — cheap), cleared when the draft empties (send).
  const draftKey = (): string => `mantle-draft:${ui.currentAgentId ?? '?'}:${chat.sessionId ?? 'new'}`;
  let activeDraftKey = draftKey();

  $effect(() => {
    // Context switched — restore that context's stored draft. Runs before
    // the writer below can observe the change (the writer only tracks
    // composer.draft, which this assignment updates).
    void chat.sessionId;
    void ui.currentAgentId;
    const key = draftKey();
    if (key === activeDraftKey) return;
    const prev = activeDraftKey;
    activeDraftKey = key;
    const stored = lsGet(key);
    // Lazy creation: 'new' becomes the real id mid-turn while the user may
    // already be typing a follow-up — that's the SAME thread, carry the
    // draft over instead of clobbering it with the (empty) stored value.
    const migration = prev.endsWith(':new') && !!chat.sessionId && stored == null && composer.draft !== '';
    if (migration) { lsSet(key, composer.draft); return; }
    composer.draft = stored ?? '';
  });
  $effect(() => {
    const text = composer.draft;
    if (text) lsSet(activeDraftKey, text);
    else lsRemove(activeDraftKey);
  });

  // Edit-last-turn loaded the draft — focus with the cursor parked at the end.
  $effect(() => {
    if (composer.editPending && ta) {
      void tick().then(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = composer.draft.length;
      });
    }
  });

  function send(): void {
    if (!canSend) return;
    onsend(composer.draft.trim());
    composer.draft = '';
    acMatches = [];
  }

  // ── Emoji ──────────────────────────────────────────────────────────────────
  let acMatches = $state<ShortcodeMatch[]>([]);
  let acIndex = $state(0);
  let acColonIdx = 0;

  async function setCursor(pos: number): Promise<void> {
    await tick(); // bind:value flushes to the DOM first
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
  }

  // Insert from the picker at the cursor (replacing any selection).
  function insertEmoji(emoji: string): void {
    const start = ta.selectionStart ?? composer.draft.length;
    const end = ta.selectionEnd ?? composer.draft.length;
    composer.draft = composer.draft.slice(0, start) + emoji + composer.draft.slice(end);
    void setCursor(start + emoji.length);
  }

  function scanForShortcode(): void {
    const scan = scanShortcode(composer.draft, ta.selectionStart ?? composer.draft.length);
    if (scan.kind === 'complete') {
      composer.draft = scan.text;
      acMatches = [];
      void setCursor(scan.cursor);
    } else if (scan.kind === 'suggest') {
      acMatches = scan.matches;
      acIndex = 0;
      acColonIdx = scan.colonIdx;
    } else {
      acMatches = [];
    }
  }

  function applyAutocomplete(m: ShortcodeMatch): void {
    const pos = ta.selectionStart ?? composer.draft.length;
    composer.draft = composer.draft.slice(0, acColonIdx) + m.emoji + composer.draft.slice(pos);
    acMatches = [];
    addRecent(m.emoji);
    void setCursor(acColonIdx + m.emoji.length);
  }

  function oninput(): void {
    autogrow();
    scanForShortcode();
  }

  function onkeydown(e: KeyboardEvent): void {
    if (acMatches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = (acIndex + 1) % acMatches.length; return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = (acIndex - 1 + acMatches.length) % acMatches.length; return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyAutocomplete(acMatches[acIndex]); return; }
      if (e.key === 'Escape') { acMatches = []; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      send();
    }
  }

  function onFiles(e: Event): void {
    const input = e.target as HTMLInputElement;
    for (const f of input.files ?? []) addFile(f);
    input.value = '';
  }

  function onPaste(e: ClipboardEvent): void {
    for (const item of e.clipboardData?.items ?? []) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const f = item.getAsFile();
        if (f) addFile(f);
        return;
      }
    }
    // Long text becomes a staged attachment instead of flooding the textarea.
    const text = e.clipboardData?.getData('text/plain');
    if (text && text.length > 1000) {
      e.preventDefault();
      addTextFile(text);
    }
  }
</script>

<div class="input-area">
  {#if composer.pending.length > 0}
    <div class="chips">
      {#each composer.pending as p (p.id)}
        <div class="chip">
          {#if p.kind === 'image'}
            <img class="chip-thumb" src={p.previewUrl} alt="" />
          {:else}
            <span class="chip-icon">▤</span>
          {/if}
          <span class="chip-name">{p.name}</span>
          <span class="chip-size">{formatSize(p.size)}</span>
          <button class="chip-x" type="button" aria-label="Remove" onclick={() => removePending(p.id)}>×</button>
        </div>
      {/each}
    </div>
  {/if}

  <ShortcodeAutocomplete matches={acMatches} activeIndex={acIndex} onpick={applyAutocomplete} onhover={(i) => (acIndex = i)} />

  <div class="console" class:streaming>
    <div class="console-tools">
      <button class="tool-btn" type="button" aria-label="Attach file" title="Attach file" onclick={() => fileInput.click()}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <path d="M13.5 7.5l-5.2 5.2a3.4 3.4 0 0 1-4.8-4.8l5.8-5.8a2.3 2.3 0 0 1 3.2 3.2l-5.7 5.7a1.1 1.1 0 0 1-1.6-1.6l5-5" />
        </svg>
      </button>
      <input bind:this={fileInput} type="file" multiple hidden onchange={onFiles} />
      <span class="emoji-wrap"><EmojiPicker onpick={insertEmoji} /></span>
      <MicButton />
    </div>

    <span class="prompt-glyph" aria-hidden="true">{streaming ? '▮' : '❯'}</span>
    <textarea
      bind:this={ta}
      bind:value={composer.draft}
      class="message-input"
      rows="1"
      placeholder={streaming ? 'note → running turn…' : 'transmit…'}
      {oninput}
      onkeydown={onkeydown}
      onpaste={onPaste}
    ></textarea>

    {#if streaming}
      <button class="stop-btn" type="button" onclick={onstop} aria-label="Stop the running turn" title="Stop the running turn">■</button>
    {/if}
    <button class="send-btn" type="button" onclick={send} disabled={!canSend} aria-label={streaming ? 'Send note' : 'Send'}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M2 2l12 6-12 6 2.5-6L2 2z" />
      </svg>
    </button>
  </div>
</div>

<style>
  .input-area {
    padding: 12px 24px 16px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
    position: relative;
    z-index: 1;
  }
  .input-area::before {
    content: '';
    position: absolute;
    top: -1px;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(to right, transparent, var(--border-strong) 30%, var(--border-strong) 70%, transparent);
  }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 4px 4px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    max-width: 220px;
  }
  .chip-thumb { width: 24px; height: 24px; object-fit: cover; }
  .chip-icon { color: var(--accent); font-size: 14px; padding: 0 3px; }
  .chip-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chip-size { font-size: 10px; color: var(--text-muted); font-family: var(--font-mono); }
  .chip-x { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 15px; padding: 0 2px; }
  .chip-x:hover { color: var(--error); }

  /* ── The console — one framed instrument: tools · prompt · input · send ── */
  .console {
    display: flex;
    gap: 6px;
    align-items: flex-end;
    padding: 6px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  /* clip-path clips ALL descendant painting — the emoji picker mounts inside
     the console and was being sliced to the console box (found live). Lift
     the cut while any popover panel is open; the square corner is invisible
     under an open picker. */
  .console:has(:global(.panel)) { clip-path: none; }
  .console:focus-within {
    border-color: var(--accent-edge);
    box-shadow: 0 0 14px var(--accent-dim), inset 0 0 24px rgba(0, 0, 0, 0.3);
  }
  .console.streaming { border-color: var(--accent-reason-dim); }

  .console-tools { display: flex; gap: 2px; align-items: center; flex-shrink: 0; padding-bottom: 2px; }

  .tool-btn {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.2s, background 0.2s;
  }
  .tool-btn:hover { color: var(--accent); background: var(--accent-faint); }

  /* The emoji + mic room buttons adopt the quiet in-console style. */
  .console :global(.emoji-btn),
  .console :global(.mic-btn) {
    width: 34px;
    height: 34px;
    border-color: transparent;
    background: transparent;
  }

  .prompt-glyph {
    flex-shrink: 0;
    padding: 8px 0 9px 4px;
    font-family: var(--font-terminal);
    font-size: 13px;
    line-height: 1.4;
    color: var(--accent);
    text-shadow: 0 0 6px var(--accent-glow);
    user-select: none;
  }
  .console.streaming .prompt-glyph {
    color: var(--accent-reason);
    text-shadow: 0 0 6px var(--accent-reason-glow);
    animation: glyph-blink 1.1s step-end infinite;
  }
  @keyframes glyph-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
  }
  @media (prefers-reduced-motion: reduce) {
    .console.streaming .prompt-glyph { animation: none; }
  }

  .message-input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    padding: 8px 6px 9px;
    font-family: var(--font-sans);
    font-size: 14px;
    resize: none;
    max-height: 200px;
    line-height: 1.5;
  }
  .message-input:focus { outline: none; }
  .message-input::placeholder {
    color: var(--text-muted);
    font-family: var(--font-display);
    font-weight: 500;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    font-size: 12px;
    /* Match the 14px×1.5 content line box (21px) so the smaller placeholder
       sits on the same visual line as the ❯ glyph instead of riding high. */
    line-height: 1.75;
  }

  .send-btn {
    background: var(--accent-dim);
    border: 1px solid var(--accent);
    color: var(--accent);
    width: 36px;
    height: 36px;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.2s, box-shadow 0.2s, opacity 0.2s;
  }
  .send-btn:hover:not(:disabled) { background: var(--accent-soft); box-shadow: 0 0 12px var(--accent-glow); }
  .send-btn:disabled { opacity: 0.3; cursor: default; }
  /* Charged — a glow pulse the moment there's something to send. */
  .send-btn:not(:disabled) { animation: send-charge 1.8s ease-in-out infinite; }
  @keyframes send-charge {
    0%, 100% { box-shadow: 0 0 5px var(--accent-dim); background: var(--accent-dim); }
    50%      { box-shadow: 0 0 18px var(--accent-glow); background: var(--accent-soft); }
  }
  @media (prefers-reduced-motion: reduce) {
    .send-btn:not(:disabled) { animation: none; }
  }

  .stop-btn {
    background: rgba(255, 45, 124, 0.08);
    border: 1px solid var(--error);
    color: var(--error);
    width: 36px;
    height: 36px;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.2s, box-shadow 0.2s;
  }
  .stop-btn:hover { background: rgba(255, 45, 124, 0.18); box-shadow: 0 0 10px rgba(255, 45, 124, 0.3); }

  /* ── Mobile — quiet tools shrink, text stays ≥16px (iOS zoom guard) ────── */
  @media (max-width: 768px) {
    .emoji-wrap { display: none; } /* the OS keyboard owns emoji on phones */
    .console { gap: 3px; }
    .tool-btn, .console :global(.mic-btn) { width: 31px; height: 34px; }
    .prompt-glyph { display: none; }
    .message-input { font-size: 16px; padding: 7px 4px 8px; }
    .message-input::placeholder { font-size: 12px; }
  }
</style>
