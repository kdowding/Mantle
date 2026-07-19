// Cipher decode action — a title-decode effect, as a Svelte action. The
// element's text scramble-locks character by character from random glyphs to
// the real value, re-running whenever the value changes (agent switch).
// use:cipher={name}
const GLYPHS = '!<>-_\\/[]{}—=+*^?#▓▒░$%&@01';

export function cipher(node: HTMLElement, text: string): { update: (t: string) => void; destroy: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  const reduced =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function stop(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function run(to: string): void {
    stop();
    const target = to ?? '';
    if (reduced || target.length === 0) { node.textContent = target; return; }
    let locked = 0;
    const step = Math.max(1, Math.ceil(target.length / 9)); // ~9 ticks for any length
    timer = setInterval(() => {
      locked = Math.min(target.length, locked + step);
      let out = target.slice(0, locked);
      for (let i = locked; i < target.length; i++) {
        out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      node.textContent = out;
      if (locked >= target.length) stop();
    }, 36);
  }

  run(text);
  return { update: run, destroy: stop };
}
