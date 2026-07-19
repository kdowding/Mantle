// Reasoning reveal island — a separate, slower char-fade typewriter for
// thinking blocks (ported from app.js streamReasoningChunk). Distinct from the
// text reveal clock (lib/stream.ts, smd): reasoning is plain text revealed
// char-by-char with a per-chunk fade, paced deliberately (~28cps) so
// chain-of-thought reads rather than races. One active block at a time —
// thinking blocks don't overlap on the wire.
//
// Like the text island, the bound node's children are written imperatively here
// and Svelte must not manage them. Order-independent: deltas queue whether or
// not the node has attached yet.
const REASONING_TICK_MS = 28;
const REASONING_BASE_CHUNK = 1;
const REASONING_TARGET_LAG = 200;
const REASONING_MAX_CHUNK = 24;

const rs = {
  node: null as HTMLElement | null,
  queue: '',
  timer: null as ReturnType<typeof setInterval> | null,
};

// Bind the active block's .thinking-content node (ThinkingBlock onMount).
export function attachThinking(node: HTMLElement): void {
  rs.node = node;
  if (rs.queue) startTimer();
}

export function pushThinking(text: string): void {
  rs.queue += text;
  if (rs.node) startTimer();
}

// thinking_end: drain whatever's left immediately, stop, detach.
export function finishThinking(): void {
  if (rs.queue && rs.node) { appendChunk(rs.queue); rs.queue = ''; }
  stopTimer();
  rs.node = null;
}

// Hard reset (turn start / abort) — drop queue + node without flushing.
export function resetThinking(): void {
  stopTimer();
  rs.queue = '';
  rs.node = null;
}

function startTimer(): void {
  if (rs.timer) return;
  rs.timer = setInterval(tick, REASONING_TICK_MS);
}
function stopTimer(): void {
  if (rs.timer) { clearInterval(rs.timer); rs.timer = null; }
}

function tick(): void {
  if (!rs.queue || !rs.node) { stopTimer(); return; }
  let chunkSize = REASONING_BASE_CHUNK;
  if (rs.queue.length > REASONING_TARGET_LAG) {
    chunkSize += Math.ceil((rs.queue.length - REASONING_TARGET_LAG) / 12);
  }
  chunkSize = Math.min(chunkSize, REASONING_MAX_CHUNK);
  appendChunk(rs.queue.slice(0, chunkSize));
  rs.queue = rs.queue.slice(chunkSize);
}

function appendChunk(chunk: string): void {
  if (!rs.node) return;
  const span = document.createElement('span');
  span.className = 'char-fade';
  span.textContent = chunk;
  rs.node.appendChild(span);
  // Keep the latest line in view inside the reasoning panel.
  const mask = rs.node.parentElement; // .thinking-fade-mask
  if (mask) mask.scrollTop = mask.scrollHeight;
}
