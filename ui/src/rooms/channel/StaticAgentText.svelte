<script lang="ts">
  // Replayed agent reply: one-shot markdown render (same smd renderer as live
  // turns), then "@participant" tokens get wrapped in accent-tinted pills so
  // agent→agent handoffs stay visible on replay — the whole point of the room.
  // DOM-walk on text nodes only (skips pre/code/a); never injects markup.
  import { onMount } from 'svelte';
  import { renderStatic } from '../../lib/stream';
  import { participants } from './channel.svelte';

  let { text }: { text: string } = $props();
  let node: HTMLDivElement;

  function decoratePills(root: HTMLElement): void {
    const parts = participants();
    if (!parts.length) return;
    // smd leaves adjacent text-node fragments behind ("L" + "ate … @veg" +
    // "a") — merge them first or the token regex sees truncated names.
    root.normalize();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.includes('@')) return NodeFilter.FILTER_REJECT;
        for (let p = n.parentElement; p && p !== root; p = p.parentElement) {
          const tag = p.tagName;
          if (tag === 'PRE' || tag === 'CODE' || tag === 'A') return NodeFilter.FILTER_REJECT;
          if (p.classList.contains('mention-pill')) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text);

    const re = /(^|\s)@([A-Za-z0-9][A-Za-z0-9_-]*)/g;
    for (const tn of targets) {
      const str = tn.nodeValue ?? '';
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let last = 0;
      let hit = false;
      const frag = document.createDocumentFragment();
      while ((m = re.exec(str)) !== null) {
        const token = m[2].toLowerCase();
        const a = parts.find((p) => p.id.toLowerCase() === token || p.name.toLowerCase() === token);
        if (!a) continue;
        hit = true;
        const start = m.index + m[1].length;
        if (start > last) frag.appendChild(document.createTextNode(str.slice(last, start)));
        const pill = document.createElement('span');
        pill.className = 'mention-pill';
        if (a.accent) pill.style.setProperty('--pill-accent', a.accent);
        pill.textContent = `@${a.name}`;
        frag.appendChild(pill);
        last = re.lastIndex;
      }
      if (!hit) continue;
      if (last < str.length) frag.appendChild(document.createTextNode(str.slice(last)));
      tn.parentNode?.replaceChild(frag, tn);
    }
  }

  onMount(() => {
    renderStatic(node, text);
    decoratePills(node);
  });
</script>

<!-- .md-body (global, app.css) styles the smd-rendered markdown. -->
<div class="static md-body" bind:this={node}></div>

<style>
  .static { font-family: var(--font-sans); word-wrap: break-word; }
  .static :global(.mention-pill) {
    display: inline-block;
    padding: 0 6px;
    border: 1px solid var(--pill-accent, var(--accent));
    color: var(--pill-accent, var(--accent));
    background: color-mix(in srgb, var(--pill-accent, var(--accent)) 10%, transparent);
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 0.5px;
  }
</style>
